/**
 * pi-then-run — run a validation command in the same tool call as a file mutation.
 *
 * How it attaches without forking or re-registering the target tools:
 * - TypeBox accepts unknown keys by default, so `then_run` passes Pi's argument
 *   validation for any target tool.
 * - The assistant `message_end` hook removes `then_run` from the tool call's
 *   arguments before the tool executes and parks it by toolCallId, so targets with
 *   their own strict shape checks (hashline's [E_BAD_SHAPE]) never see it.
 * - The toolResult `message_end` hook picks the parked request up; when the mutation
 *   succeeded and was actually written (not queued in a batch), it runs the command
 *   and appends the output to the same result.
 * - The model learns the parameter from a system-prompt section.
 *
 * Order independence: stripping happens by in-place mutation of the persisted assistant
 * message (visible to every later reader), and the command output is appended in the
 * toolResult's message_end — after every extension's tool_result patch has been applied
 * (pi-hashline-edit-pro rebuilds replace/insert content there). Either load order works.
 *
 * Nothing here depends on the target extensions' internals beyond: tool name, and
 * hashline's `details.batch.last` / `details.metrics.classification` (with the
 * literal `In batch` text as fallback) to detect edits that are queued, not written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { compose, composeSkipped, decide, type ThenRunInput, type ToolResult } from "./then-run.ts";
import { prepareOutput } from "./output.ts";

export const DEFAULT_TARGET_TOOLS = ["replace", "replace_match", "insert", "write", "edit"] as const;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 900;

export interface Config {
  /** Tool names whose results may carry a then_run. */
  tools: readonly string[];
  defaultTimeoutSeconds: number;
}

const SECTION = "then_run";

export const DEFAULT_CONFIG: Config = { tools: DEFAULT_TARGET_TOOLS, defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS };

export function systemPromptSection(tools: readonly string[]): string {
  return `## then_run

The file-mutating tools ${tools.map((t) => `\`${t}\``).join(", ")} accept \`then_run: { "command": string, "timeout"?: seconds }\`. After the mutation is written, the command runs in the project directory. Its output is appended to the same tool result, below the diff, marked \`[then_run:succeeded]\` or \`[then_run:failed]\` with the exit code.

When the next step after a mutation is a shell command, put that command in \`then_run\`. Do not send it as a separate tool call. This covers any follow-up command: run, build, test, typecheck, lint, format, install, restart or reload a service, or inspect the result. A separate call costs one more model round that replays the whole context, so the user pays extra tokens, money, and waiting time for it. Use a separate call only when the command must run in the background, or must keep running after its timeout.

- The diff still comes first in the result. If the edit is wrong, fix it and run the command again.
- Same-file edits sent in one message commit as one batch. Put \`then_run\` on the last call of the batch. Earlier calls only queue, and their command is reported as \`[then_run:skipped]\`.
- A failed mutation skips the command. A non-zero exit keeps the mutation.
- The default timeout is ${DEFAULT_TIMEOUT_SECONDS} seconds. Set \`timeout\` (max ${MAX_TIMEOUT_SECONDS}) for longer commands.`;
}

export function parseThenRun(input: unknown): ThenRunInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>)["then_run"];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["command"] !== "string" || r["command"].trim().length === 0) return null;
  const timeout = typeof r["timeout"] === "number" && Number.isFinite(r["timeout"]) && r["timeout"] > 0 ? Math.min(r["timeout"], MAX_TIMEOUT_SECONDS) : undefined;
  return { command: r["command"], ...(timeout !== undefined ? { timeout } : {}) };
}

export const THEN_RUN_SCHEMA = Type.Optional(
  Type.Object(
    {
      command: Type.String({ description: "Bash command to run after the mutation is written (project directory)." }),
      timeout: Type.Optional(Type.Number({ description: `Seconds before the command is killed (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).` })),
    },
    { description: "The shell command to run next, right after this mutation succeeds: run, build, test, check, restart, and so on. Use it instead of a separate tool call; that saves one model round of tokens, money, and time. Skipped if the mutation fails or only queues in a batch." },
  ),
);

/**
 * Advertise then_run in the target tools' JSON schemas. `pi.getAllTools()` returns each
 * definition's live `parameters` object, and TypeBox schemas are plain mutable objects,
 * so adding a property here is what the provider sees — without re-registering the tool
 * (which Pi reports as a conflict) or forking the target extension. Idempotent.
 */
export function advertiseInSchemas(pi: ExtensionAPI, tools: ReadonlySet<string>): string[] {
  const patched: string[] = [];
  for (const t of pi.getAllTools()) {
    if (!tools.has(t.name)) continue;
    const params = t.parameters as { type?: string; properties?: Record<string, unknown> } | undefined;
    if (!params || params.type !== "object") continue;
    params.properties ??= {};
    if (!("then_run" in params.properties)) params.properties["then_run"] = THEN_RUN_SCHEMA;
    patched.push(t.name);
  }
  return patched;
}

export default function thenRun(pi: ExtensionAPI): void {
  const config = DEFAULT_CONFIG;
  const targets = new Set(config.tools);

  pi.on("session_start", async () => {
    advertiseInSchemas(pi, targets);
  });

  pi.on("before_agent_start", async (event) => {
    // Only advertise tools that are actually active in this session.
    const active = new Set(pi.getActiveTools());
    const present = config.tools.filter((t) => active.has(t));
    const options = event.systemPromptOptions;
    // An earlier handler forced the whole prompt: sections are not rendered then, so append to it.
    if (options.forceSystemPrompt !== undefined) {
      return present.length === 0 ? undefined : { systemPrompt: `${options.forceSystemPrompt}\n\n${systemPromptSection(present)}` };
    }
    // A structured section (Pi >= 0.86) keeps later extensions' sections and is recorded as a
    // transcript delta instead of replacing the whole prompt.
    const { [SECTION]: _previous, ...others } = options.sections ?? {};
    options.sections = present.length === 0 ? others : { ...others, [SECTION]: systemPromptSection(present) };
    return undefined;
  });

  /** then_run requests parked from the assistant message until its toolResult message, keyed by toolCallId. */
  const parked = new Map<string, ThenRunInput>();

  // Strip then_run from the assistant message before any tool runs. Pi passes the same
  // message object through every message_end handler and persists it afterwards, so an
  // in-place mutation of `block.arguments` is seen by every later consumer regardless of
  // extension order — including pi-hashline-edit-pro's batch planner, which reads the raw
  // toolCall arguments in its own message_end handler and rejects unknown fields.
  pi.on("message_end", async (event) => {
    const m = event.message;
    if (m.role !== "assistant") return undefined;
    for (const block of m.content) {
      if (block.type !== "toolCall" || !targets.has(block.name)) continue;
      const args = block.arguments as Record<string, unknown>;
      if (!("then_run" in args)) continue;
      const req = parseThenRun(args);
      if (req) parked.set(block.id, req);
      delete args["then_run"];
    }
    return undefined;
  });

  // Belt and braces: tool_call receives validated args cloned from the toolCall; if a
  // then_run survived (e.g. message_end ordering surprises), remove it here too.
  pi.on("tool_call", async (event) => {
    if (!targets.has(event.toolName)) return undefined;
    if ("then_run" in event.input) {
      const req = parseThenRun(event.input);
      if (req && !parked.has(event.toolCallId)) parked.set(event.toolCallId, req);
      delete (event.input as Record<string, unknown>)["then_run"];
    }
    return undefined;
  });

  pi.on("agent_end", async () => parked.clear());
  pi.on("session_start", async () => parked.clear());

  // Run the command once the toolResult message is final (after every extension's
  // tool_result patch, including hashline's content rebuild), and append to it.
  pi.on("message_end", async (event, ctx) => {
    const m = event.message;
    if (m.role !== "toolResult" || !targets.has(m.toolName)) return undefined;
    const req = parked.get(m.toolCallId);
    if (!req) return undefined;
    parked.delete(m.toolCallId);

    const mutation: ToolResult = { content: m.content, details: m.details };
    const decision = decide(mutation, m.isError);
    if (!decision.run) {
      const out = composeSkipped(mutation, req.command, decision.reason);
      return { message: { ...m, content: out.content, details: out.details } };
    }

    const timeoutMs = (req.timeout ?? config.defaultTimeoutSeconds) * 1000;
    let output = "";
    let exitCode: number | null = null;
    let timedOut = false;
    try {
      const r = await pi.exec("bash", ["-lc", req.command], { cwd: ctx.cwd, timeout: timeoutMs, signal: ctx.signal });
      output = [r.stdout, r.stderr].filter((s) => s.length > 0).join(r.stdout && r.stderr ? "\n--- stderr ---\n" : "");
      exitCode = r.code;
      timedOut = r.killed;
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      exitCode = null;
    }
    const prepared = await prepareOutput(output, ctx);
    const out = compose(mutation, req.command, { ...prepared, exitCode, timedOut });
    // A failed validation is information, not a tool error: the mutation itself succeeded.
    return { message: { ...m, content: out.content, details: out.details } };
  });
}
