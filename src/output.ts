/** Preserve the complete command output before making a model-facing preview. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clipOutput, MAX_OUTPUT_CHARS } from "./then-run.ts";

export async function prepareOutput(output: string, ctx: Pick<ExtensionContext, "sessionManager">): Promise<{
  output: string;
  fullOutputPath?: string;
  archiveError?: string;
}> {
  if (output.length <= MAX_OUTPUT_CHARS) return { output };
  try {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionDir) throw new Error("No persistent session directory is available");
    // Pi retains relative --session-dir values and uses them relative to process.cwd(),
    // not ctx.cwd (which SDK callers can set to a different project). Return an absolute
    // log path so a later read resolves to the same file regardless of the project cwd.
    const root = resolve(sessionDir);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(sessionId)) throw new Error("Invalid session id for output archival");
    // A fresh private directory avoids shared-directory/symlink and filename collisions.
    // Keep it under the session directory, not tmpdir(), so resumed sessions can read it.
    const directory = await mkdtemp(join(root, `then-run-${sessionId}-`));
    const fullOutputPath = join(directory, "output.log");
    await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { output: clipOutput(output), fullOutputPath };
  } catch (error) {
    // Archival is best-effort; losing evidence is not. No truncation on this path.
    return { output, archiveError: error instanceof Error ? error.message : String(error) };
  }
}
