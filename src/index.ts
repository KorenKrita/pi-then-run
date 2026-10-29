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
 * Nested calls (codemode scripts) have no toolResult message and never run then_run; their
 * `[then_run:ignored]` notice is added in the nested tool_execution_end, which also follows
 * every tool_result patch.
 *
 * Nothing here depends on the target extensions' internals beyond: tool name, and
 * hashline's `details.batch.last` / `details.metrics.classification` (with the
 * literal `In batch` text as fallback) to detect edits that are queued, not written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { compose, composeSkipped, decide, editedPath, ignoredNotice, type ThenRunInput, type ToolResult } from "./then-run.ts";
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

The file-mutating tools ${tools.map((t) => `\`${t}\``).join(", ")} accept \`then_run\` (a shell command string) and \`then_run_timeout\` (seconds, optional). After the mutation is written, the command runs in the root of the git repository that contains the edited file (the innermost repository when they are nested), or in the file's own directory when it is outside git. Write the command for that directory; do not \`cd\` into it. Its output is appended to the same tool result, below the diff, marked \`[then_run:succeeded]\` or \`[then_run:failed]\` with the exit code.

When the next step after a mutation is a shell command (run, build, test, typecheck, lint, format, install, restart a service, inspect the result), put it in \`then_run\` instead of a separate tool call. Use a separate call only when the command must run in the background or keep running past its timeout.

- The diff still comes first in the result. If the edit is wrong, fix it and run the command again.
- Same-file edits sent in one message commit as one batch. Put \`then_run\` on the last call of the batch. Earlier calls only queue, and their command is reported as \`[then_run:skipped]\`.
- A failed mutation skips the command. A non-zero exit keeps the mutation.
- The default timeout is ${DEFAULT_TIMEOUT_SECONDS} seconds. Set \`then_run_timeout\` (max ${MAX_TIMEOUT_SECONDS}) for longer commands.
- Inside a codemode script, \`then_run\` is not run. Call bash from the script after the edit instead.`;
}

export const TIMEOUT_KEY = "then_run_timeout";

export function parseThenRun(input: unknown): ThenRunInput | null {
  if (!input || typeof input !== "object") return null;
  const args = input as Record<string, unknown>;
  const command = args["then_run"];
  if (typeof command !== "string" || command.trim().length === 0) return null;
  const t = args[TIMEOUT_KEY];
  const timeout = typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMEOUT_SECONDS) : undefined;
  return { command, ...(timeout !== undefined ? { timeout } : {}) };
}

/** Removes both then_run keys; true when either was present. */
function stripThenRun(args: Record<string, unknown>): boolean {
  const had = "then_run" in args || TIMEOUT_KEY in args;
  delete args["then_run"];
  delete args[TIMEOUT_KEY];
  return had;
}

// A flat string, not an object: models (Claude, Kimi) intermittently leaked their own
// `<parameter name="command">` markup into a nested then_run object, which made the whole
// call's arguments unparseable and dropped the edit.
export const THEN_RUN_SCHEMA = Type.Optional(
  Type.String({
    description: "Shell command to run after this mutation is written; its output is appended to this result. Runs in the git repository root of the edited file, or the file's directory outside git.",
  }),
);

export const THEN_RUN_TIMEOUT_SCHEMA = Type.Optional(
  Type.Number({ description: `Seconds before the then_run command is killed (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).` }),
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
    params.properties["then_run"] = THEN_RUN_SCHEMA;
    params.properties[TIMEOUT_KEY] = THEN_RUN_TIMEOUT_SCHEMA;
    patched.push(t.name);
  }
  return patched;
}

/**
 * Where a then_run command runs: the innermost git repository root containing the edited file
 * (`git rev-parse --show-toplevel` from the file's directory), else that directory. Without a
 * known file, or when its directory does not exist, the session's cwd.
 */
export async function commandDir(pi: Pick<ExtensionAPI, "exec">, file: string | undefined, fallback: string): Promise<string> {
  if (!file) return fallback;
  const expanded = file === "~" || file.startsWith("~/") ? homedir() + file.slice(1) : file;
  const dir = dirname(isAbsolute(expanded) ? expanded : resolve(fallback, expanded));
  if (!existsSync(dir)) return fallback;
  try {
    const r = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
    const root = r.code === 0 ? r.stdout.trim() : "";
    return root || dir;
  } catch {
    return dir;
  }
}

function displayPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
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
      const req = parseThenRun(args);
      if (!stripThenRun(args)) continue;
      if (req) parked.set(block.id, typeof args["path"] === "string" ? { ...req, path: args["path"] } : req);
    }
    return undefined;
  });

  /** then_run commands passed by another tool's nested call (e.g. a codemode script), keyed by toolCallId. */
  const ignored = new Map<string, string>();

  // tool_call receives validated args cloned from the toolCall. A then_run here was not
  // stripped by the assistant message_end hook: either a nested call made by another tool
  // (Pi sets parentToolCallId; such calls have no transcript message, so nothing would run
  // it) or, belt and braces, a message_end ordering surprise. Remove it either way.
  pi.on("tool_call", async (event) => {
    if (!targets.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    const req = parseThenRun(input);
    if (stripThenRun(input)) {
      const nested = typeof (event as { parentToolCallId?: unknown }).parentToolCallId === "string";
      if (req && nested) ignored.set(event.toolCallId, req.command);
      else if (req && !parked.has(event.toolCallId)) parked.set(event.toolCallId, typeof input["path"] === "string" ? { ...req, path: input["path"] } : req);
    }
    return undefined;
  });

  // Tell the calling script its then_run did not run. Not in tool_result: Pi applies those
  // patches in load order and a returned `content` replaces the previous one, so an extension
  // loaded later that rebuilds the content (pi-hashline-edit-pro does for replace/insert)
  // would drop the notice. Pi (>= 1.x, NestedToolCallRunner.execute) emits a nested call's
  // tool_execution_end after runToolCall has applied every tool_result patch, once per call,
  // passing the very `outcome.result` it then returns to the caller (codemode's
  // ctx.executeTool). Replacing `result.content` on that object is what the script receives.
  // A Pi that does not emit it for nested calls shows no notice; agent_end clears the record.
  pi.on("tool_execution_end", async (event) => {
    const command = ignored.get(event.toolCallId);
    if (command === undefined) return undefined;
    ignored.delete(event.toolCallId);
    const result = event.result as { content?: unknown; structuredContent?: unknown } | null | undefined;
    if (!result || typeof result !== "object") return undefined;
    const notice = ignoredNotice(command);
    const content = Array.isArray(result.content) ? result.content : [];
    result.content = [...content, { type: "text", text: notice }];
    // A tool with outputSchema hands the script its structuredContent, not the text
    // (codemode toScriptValue). hashline's edit results carry a `warnings` array there.
    const structured = result.structuredContent as { warnings?: unknown } | undefined;
    if (structured && typeof structured === "object" && Array.isArray(structured.warnings)) {
      structured.warnings = [...structured.warnings, notice];
    }
    return undefined;
  });

  const clear = async () => {
    parked.clear();
    ignored.clear();
  };
  pi.on("agent_end", clear);
  pi.on("session_start", clear);

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

    const cwd = await commandDir(pi, editedPath(m.details, req.path), ctx.cwd);
    const timeoutMs = (req.timeout ?? config.defaultTimeoutSeconds) * 1000;
    let output = "";
    let exitCode: number | null = null;
    let timedOut = false;
    try {
      const r = await pi.exec("bash", ["-lc", req.command], { cwd, timeout: timeoutMs, signal: ctx.signal });
      output = [r.stdout, r.stderr].filter((s) => s.length > 0).join(r.stdout && r.stderr ? "\n--- stderr ---\n" : "");
      exitCode = r.code;
      timedOut = r.killed;
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      exitCode = null;
    }
    const prepared = await prepareOutput(output, ctx);
    const out = compose(mutation, req.command, { ...prepared, exitCode, timedOut, cwd, displayCwd: displayPath(cwd) });
    // A failed validation is information, not a tool error: the mutation itself succeeded.
    return { message: { ...m, content: out.content, details: out.details } };
  });
}
