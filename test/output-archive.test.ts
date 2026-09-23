import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import thenRun from "../src/index.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareOutput } from "../src/output.ts";
import { MAX_OUTPUT_CHARS } from "../src/then-run.ts";

type EndHandler = (event: MessageEndEvent, ctx: ExtensionContext) => Promise<{ message?: AgentMessage } | void>;
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

// Exercise the installed message_end handlers, not just the clipping helper.
// Fixtures stay in the OS temporary directory for inspection after a failure.
function harness(sessionDir: string, execResult: ExecResult, sessionId = "test-session") {
  const handlers: EndHandler[] = [];
  let executions = 0;
  thenRun({
    on(name: string, handler: EndHandler) { if (name === "message_end") handlers.push(handler); },
    async exec() { executions++; return execResult; },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: sessionDir,
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  async function end(message: AgentMessage) {
    for (const handler of handlers) {
      const result = await handler({ type: "message_end", message }, ctx);
      if (result?.message) message = result.message;
    }
    return message;
  }
  async function run(id = "call-1", details: JsonValue = { mutation: "preserved" }) {
    await end({
      role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { path: "virtual", content: "virtual", then_run: { command: "bun test" } } }],
      api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const result = await end({ role: "toolResult", toolCallId: id, toolName: "write", content: [{ type: "text", text: "Virtual mutation succeeded" }], details, isError: false, timestamp: 2 });
    if (result.role !== "toolResult") throw new Error("Expected a tool result");
    return result;
  }
  return { run, executions: () => executions };
}

const fullStdout = `${"a".repeat(21_000)}\nUNIQUE_MIDDLE_DIAGNOSTIC 中文 🧪\n${"z".repeat(21_000)}\n`;
const fullStderr = "stderr evidence\n";
const combined = `${fullStdout}\n--- stderr ---\n${fullStderr}`;

describe("then_run complete output preservation", () => {
  for (const outcome of [{ code: 0, killed: false }, { code: 1, killed: false }, { code: 0, killed: true }]) {
    test(`archives untruncated stdout/stderr before clipping (exit ${outcome.code}, killed ${outcome.killed})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-then-run-test-"));
      const h = harness(root, { stdout: fullStdout, stderr: fullStderr, ...outcome });
      const result = await h.run();
      const details = result.details as { mutation: string; then_run: { fullOutputPath?: string; exitCode: number; timedOut: boolean; succeeded: boolean } };
      expect(details.then_run.fullOutputPath).toBeString();
      const path = details.then_run.fullOutputPath!;
      expect(path.startsWith(`${root}${sep}`)).toBe(true);
      expect(await readFile(path, "utf8")).toBe(combined);
      const text = JSON.stringify(result.content);
      expect(text).toContain("chars omitted");
      expect(text).not.toContain("UNIQUE_MIDDLE_DIAGNOSTIC");
      expect(text).toContain(`Full output: ${path}`);
      expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS + 2000);
      expect(details.mutation).toBe("preserved");
      expect(details.then_run.exitCode).toBe(outcome.code);
      expect(details.then_run.timedOut).toBe(outcome.killed);
      expect(details.then_run.succeeded).toBe(outcome.code === 0 && !outcome.killed);
      expect(result.isError).toBe(false); // validation is not the mutation's error state
      expect(h.executions()).toBe(1);
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      }
      // Repeated calls must not overwrite an earlier result's full output.
      const again = await h.run("call-2");
      const againPath = (again.details as typeof details).then_run.fullOutputPath;
      expect(againPath).not.toBe(path);
      expect(await readFile(path, "utf8")).toBe(combined);
    });
  }

  test("does not archive an output at the clipping limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-then-run-test-"));
    const stdout = "x".repeat(MAX_OUTPUT_CHARS);
    const result = await harness(root, { stdout, stderr: "", code: 0, killed: false }).run();
    expect(JSON.stringify(result.content)).toContain(stdout);
    expect(result.details).toEqual({ mutation: "preserved", then_run: { command: "bun test", exitCode: 0, timedOut: false, succeeded: true } });
    expect(await readdir(root)).toEqual([]);
  });

  test("keeps the entire output inline and reports archival failure without hiding validation status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-then-run-test-"));
    const notDirectory = join(root, "not-a-directory");
    await writeFile(notDirectory, "do not overwrite");
    const result = await harness(notDirectory, { stdout: fullStdout, stderr: fullStderr, code: 1, killed: false }).run();
    const details = result.details as { then_run: { fullOutputPath?: string; archiveError?: string; exitCode: number } };
    expect(details.then_run.fullOutputPath).toBeUndefined();
    expect(details.then_run.archiveError).toBeString();
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(text).toContain(combined);
    expect(text).toContain("kept untruncated inline");
    expect(details.then_run.exitCode).toBe(1);
    expect(result.isError).toBe(false);
    expect(await readFile(notDirectory, "utf8")).toBe("do not overwrite");
  });

  test("uses Pi's process-relative session directory even when the session project cwd differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-then-run-test-"));
    const configuredDir = relative(process.cwd(), root);
    const sessionManager = SessionManager.create(join(root, "different-project-cwd"), configuredDir);
    expect(sessionManager.getSessionDir()).toBe(configuredDir);
    expect(sessionManager.isPersisted()).toBe(true);
    const result = await prepareOutput(combined, { sessionManager });
    expect(result.archiveError).toBeUndefined();
    expect(result.fullOutputPath).toBeString();
    expect(isAbsolute(result.fullOutputPath!)).toBe(true);
    expect(dirname(dirname(result.fullOutputPath!))).toBe(root);
    expect(await readFile(result.fullOutputPath!, "utf8")).toBe(combined);
  });

  test("keeps full output for in-memory sessions without a persistent directory", async () => {
    const result = await harness("", { stdout: fullStdout, stderr: "", code: 0, killed: false }).run();
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(text).toContain(fullStdout);
    expect(text).toContain("[then_run:archive_failed]");
    expect(JSON.stringify(result.details)).not.toContain("fullOutputPath");
    expect(JSON.stringify(result.details)).toContain('"succeeded":true');
  });

  test("refuses unsafe session ids without writing outside the session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-then-run-test-"));
    const result = await harness(root, { stdout: fullStdout, stderr: "", code: 0, killed: false }, "../../escape").run();
    expect(JSON.stringify(result.content)).toContain("UNIQUE_MIDDLE_DIAGNOSTIC");
    expect(JSON.stringify(result.details)).toContain("archiveError");
    expect(await readdir(root)).toEqual([]);
  });

  test("does not execute or archive a deferred mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-then-run-test-"));
    const h = harness(root, { stdout: fullStdout, stderr: fullStderr, code: 0, killed: false });
    const result = await h.run("deferred", { batch: { last: false } });
    expect(h.executions()).toBe(0);
    expect(JSON.stringify(result.content)).toContain("[then_run:skipped]");
    expect(await readdir(root)).toEqual([]);
  });
});
