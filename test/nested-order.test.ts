/**
 * The `[then_run:ignored]` notice on a nested (codemode script) call must survive another
 * extension that rebuilds the result content in its own tool_result hook — in either load
 * order. Run once against a faithful simulation of Pi's dispatch (always) and once against
 * the installed Pi's real nested-call pipeline (skipped when that Pi is not available).
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import thenRun from "../src/index.ts";
import { ignoredNotice } from "../src/then-run.ts";

type Handler = (event: any, ctx?: unknown) => Promise<any> | any;
type Ext = { path: string; handlers: Map<string, Handler[]> };

function extension(path: string, factory: (pi: any) => void): Ext {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    getAllTools: () => [],
    getActiveTools: () => [],
  };
  factory(pi);
  return { path, handlers };
}

const REWRITTEN = { type: "text", text: "rewritten by another extension" };

/** Like pi-hashline-edit-pro: rebuilds the content of the target's result in tool_result. */
function rewriter(pi: any): void {
  pi.on("tool_result", async (event: any) => (event.toolName === "write" ? { content: [REWRITTEN] } : undefined));
}

const NOTICE = { type: "text", text: ignoredNotice("bun test") };
const orders = [
  ["then-run before the rewriter", () => [extension("then-run", thenRun), extension("rewriter", rewriter)]],
  ["then-run after the rewriter", () => [extension("rewriter", rewriter), extension("then-run", thenRun)]],
] as const;

/**
 * Simulation of Pi 1.4.0 for one nested call: emitToolCall (handlers in order), execute,
 * emitToolResult (each returned content replaces the previous), runToolCall builds a new
 * result object, then NestedToolCallRunner emits tool_execution_end with that object and
 * returns it to the caller.
 */
async function simulateNestedCall(exts: Ext[], args: Record<string, unknown>) {
  const handlers = (name: string) => exts.flatMap((e) => e.handlers.get(name) ?? []);
  const toolCallId = "c1/1";
  const parentToolCallId = "c1";
  for (const h of handlers("tool_call")) await h({ type: "tool_call", toolName: "write", toolCallId, parentToolCallId, input: args });
  let result: any = { content: [{ type: "text", text: `wrote ${Object.keys(args).join(",")}` }], details: {} };
  const event: any = { type: "tool_result", toolName: "write", toolCallId, parentToolCallId, input: args, content: result.content, details: result.details, isError: false };
  for (const h of handlers("tool_result")) {
    const r = await h(event);
    if (r?.content !== undefined) event.content = r.content;
  }
  result = { ...result, content: event.content };
  for (const h of handlers("tool_execution_end")) await h({ type: "tool_execution_end", toolCallId, toolName: "write", result, isError: false, parentToolCallId });
  return result;
}

for (const [name, make] of orders) {
  test(`simulated Pi: the ignored notice survives a content rewrite (${name})`, async () => {
    const args: Record<string, unknown> = { path: "a.ts", content: "x", then_run: "bun test" };
    const result = await simulateNestedCall([...make()], args);
    expect(result.content).toEqual([REWRITTEN, NOTICE]);
  });
}

// --- the installed Pi's real pipeline --------------------------------------------------------

const PI_DIR = process.env["PI_CODING_AGENT_DIR_FOR_TESTS"] ?? join(homedir(), ".bun/install/global/node_modules/@earendil-works/pi-coding-agent");
const piIndex = join(PI_DIR, "dist/index.js");
const pi: any = existsSync(piIndex) ? await import(pathToFileURL(piIndex).href).catch(() => undefined) : undefined;
const realAvailable = typeof pi?.AgentSession?.prototype?._executeNestedToolCall === "function" && typeof pi?.ExtensionRunner === "function";

/**
 * AgentSession._executeNestedToolCall with only the session state it reads stubbed. Everything
 * on the call path is Pi's own code: NestedToolCallRunner, pi-agent-core runToolCall,
 * AgentSession._beforeToolCall/_afterToolCall and ExtensionRunner's emitToolCall /
 * emitToolResult / emit.
 */
async function realNestedCall(exts: Ext[], args: Record<string, unknown>) {
  const { Type } = await import(pathToFileURL(join(PI_DIR, "../pi-ai/dist/index.js")).href).catch(() => import("@earendil-works/pi-ai"));
  let executedWith: Record<string, unknown> | undefined;
  const write = {
    name: "write",
    label: "write",
    description: "write",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id: string, a: Record<string, unknown>) => {
      executedWith = { ...a };
      return { content: [{ type: "text", text: `wrote ${a["path"]}` }], details: {} };
    },
  };
  const runner = new pi.ExtensionRunner(exts, pi.createExtensionRuntime(), process.cwd(), undefined, undefined);
  const session = Object.create(pi.AgentSession.prototype);
  const own = {
    _nestedToolCalls: undefined,
    _extensionRunner: runner,
    _getCallableTools: () => [write],
    _findLastAssistantMessage: () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "codemode", arguments: {} }] }),
    _limitsModel: () => undefined,
    _emit: () => {},
    settingsManager: { getImageAutoResize: () => false },
    agent: { toolExecution: "parallel", state: { messages: [], tools: [write] } },
  };
  for (const [k, v] of Object.entries(own)) Object.defineProperty(session, k, { value: v, writable: true, configurable: true });
  const outcome = await session._executeNestedToolCall("c1", "write", args, {});
  return { outcome, executedWith };
}

for (const [name, make] of orders) {
  test.skipIf(!realAvailable)(`installed Pi: the ignored notice survives a content rewrite (${name})`, async () => {
    const args: Record<string, unknown> = { path: "a.ts", content: "x", then_run: "bun test" };
    const { outcome, executedWith } = await realNestedCall([...make()], args);
    expect(executedWith).toEqual({ path: "a.ts", content: "x" });
    expect(outcome.isError).toBe(false);
    expect(outcome.result.content).toEqual([REWRITTEN, NOTICE]);
  });
}
