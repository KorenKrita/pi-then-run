/**
 * Pure logic for the then_run wrapper: deciding whether the mutation result
 * warrants running the command, and composing the combined result.
 *
 * Marker vocabulary follows NVlabs/SoL-Pi Action Fusion so models that have
 * seen either produce the same behaviour.
 */

import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";
export const THEN_RUN_IGNORED = "[then_run:ignored]";

export interface ThenRunInput {
  command: string;
  timeout?: number;
  /** The mutating call's own `path` argument, when it has one. */
  path?: string;
}

/**
 * The file a mutation touched: hashline's `details.snapshotId` first, since replace/insert calls
 * carry no path, then the call's `path` argument normalized the way Pi's own tools resolve it.
 */
export function editedPath(details: unknown, argPath: string | undefined): string | undefined {
  const snap = (details as { snapshotId?: unknown } | null | undefined)?.snapshotId;
  if (typeof snap === "string" && snap.startsWith("v2|")) {
    // v2|<path>|ino|mtimeMs|ctimeMs|size — the path is not escaped and may contain "|".
    const parts = snap.split("|");
    const p = parts.length >= 6 ? parts.slice(1, -4).join("|") : "";
    if (p) return p;
  }
  return argPath ? normalizeToolPath(argPath) : undefined;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Pi's tool path normalization (resolveToCwd): `file://` URLs, a leading `@`, special Unicode spaces. */
export function normalizeToolPath(p: string): string {
  let out = p.replace(UNICODE_SPACES, " ");
  if (out.startsWith("file://")) {
    try {
      return fileURLToPath(out);
    } catch {
      return out;
    }
  }
  if (out.startsWith("@")) out = out.slice(1);
  return out;
}

export type ToolResult = AgentToolResult<JsonValue | undefined>;

export function resultText(result: ToolResult): string {
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Patterns in a *successful* mutation result that mean "nothing was written yet",
 * so a validation command would test the wrong state. Extension-specific but
 * stable: hashline batches same-file edits and only the last call writes.
 */
const DEFERRED_PATTERNS: readonly RegExp[] = [
  /^In batch(?: \d+)?$/m, // pi-hashline-edit-pro: queued, applied by the batch's last call
];

export type Decision = { run: true } | { run: false; reason: "mutation_failed" | "deferred" | "noop" };

export function decide(mutation: ToolResult, mutationThrew: boolean): Decision {
  if (mutationThrew) return { run: false, reason: "mutation_failed" };
  // pi-hashline-edit-pro reports batch membership structurally; prefer that over text.
  const d = mutation.details as { batch?: { last?: boolean }; metrics?: { classification?: string } } | undefined;
  if (d?.batch?.last === false) return { run: false, reason: "deferred" };
  if (d?.metrics?.classification === "noop") return { run: false, reason: "noop" };
  const text = resultText(mutation);
  for (const re of DEFERRED_PATTERNS) if (re.test(text)) return { run: false, reason: "deferred" };
  if (/^No changes made\b/m.test(text)) return { run: false, reason: "noop" };
  return { run: true };
}

export interface CommandOutcome {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  fullOutputPath?: string;
  archiveError?: string;
  /** Absolute directory the command ran in (details), and how the result header shows it. */
  displayCwd?: string;
  cwd?: string;
}

export function compose(mutation: ToolResult, command: string, outcome: CommandOutcome): ToolResult {
  const ok = outcome.exitCode === 0 && !outcome.timedOut;
  const marker = ok ? THEN_RUN_SUCCEEDED : THEN_RUN_FAILED;
  const status = outcome.timedOut ? "timed out" : `exit ${outcome.exitCode ?? "?"}`;
  const block = [
    `${marker} $ ${command} (${outcome.cwd ? `in ${outcome.displayCwd ?? outcome.cwd}, ` : ""}${status})`,
    outcome.archiveError ? `[then_run:archive_failed] ${outcome.archiveError}; full output kept untruncated inline.` : "",
    outcome.archiveError ? outcome.output : outcome.output.trimEnd(),
    outcome.fullOutputPath ? `Full output: ${outcome.fullOutputPath}` : "",
  ].filter((s) => s.length > 0).join("\n");
  return {
    ...mutation,
    content: [...mutation.content, { type: "text", text: `\n${block}` }],
    details: {
      ...baseDetails(mutation.details),
      then_run: {
        command, exitCode: outcome.exitCode, timedOut: outcome.timedOut, succeeded: ok,
        ...(outcome.cwd ? { cwd: outcome.cwd } : {}),
        ...(outcome.fullOutputPath ? { fullOutputPath: outcome.fullOutputPath } : {}),
        ...(outcome.archiveError ? { archiveError: outcome.archiveError } : {}),
      },
    },
  };
}

export function composeSkipped(mutation: ToolResult, command: string, reason: Exclude<Decision, { run: true }>["reason"]): ToolResult {
  const why =
    reason === "deferred"
      ? "the edit is queued in a batch and will be written by the batch's last call; run the command from that call"
      : reason === "noop"
        ? "the edit changed nothing"
        : "the file mutation did not complete";
  return {
    ...mutation,
    content: [...mutation.content, { type: "text", text: `\n${THEN_RUN_SKIPPED} $ ${command} — ${why}.` }],
    details: { ...baseDetails(mutation.details), then_run: { command, skipped: reason } },
  };
}

/** Notice for a then_run that another tool (e.g. a codemode script) passed: it is not run. */
export function ignoredNotice(command: string): string {
  return `\n${THEN_RUN_IGNORED} $ ${command} — called from a script; run the command with bash from the script.`;
}

/** The mutation's own details, wrapped when they are not an object so then_run can sit beside them. */
function baseDetails(details: JsonValue | undefined): JsonObject {
  if (details === undefined) return {};
  return isRecord(details) ? details : { mutation: details };
}

function isRecord(v: JsonValue): v is JsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export const MAX_OUTPUT_CHARS = 20_000;

/** Head + tail truncation so both the first error and the final summary survive. */
export function clipOutput(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} chars omitted]…\n${s.slice(s.length - tail)}`;
}
