/** Preserve the complete command output before making a model-facing preview. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clipOutput, MAX_OUTPUT_CHARS } from "./then-run.ts";

export async function prepareOutput(output: string, ctx: Pick<ExtensionContext, "sessionManager">): Promise<{
  output: string;
  fullOutputPath?: string;
  archiveError?: string;
}> {
  if (output.length <= MAX_OUTPUT_CHARS) return { output };
  try {
    const root = ctx.sessionManager.getSessionDir();
    const sessionId = ctx.sessionManager.getSessionId();
    if (!root || !isAbsolute(root)) throw new Error("No persistent session directory is available");
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
