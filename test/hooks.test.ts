import { expect, test } from "bun:test";
import thenRun from "../src/index.ts";
import { THEN_RUN_IGNORED } from "../src/then-run.ts";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;

function load(): (name: string, event: Record<string, unknown>) => Promise<unknown[]> {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    getAllTools: () => [],
    getActiveTools: () => [],
  } as unknown as Parameters<typeof thenRun>[0];
  thenRun(pi);
  return async (name, event) => Promise.all((handlers.get(name) ?? []).map((h) => h(event, {})));
}

const text = { type: "text", text: "diff" };

test("a then_run on a nested call (e.g. from a codemode script) is stripped and reported once in the final result", async () => {
  const emit = load();
  const input: Record<string, unknown> = { path: "a.ts", then_run: { command: "bun test" } };
  await emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "c1/1", parentToolCallId: "c1", input });
  expect("then_run" in input).toBe(false);
  const patches = await emit("tool_result", { type: "tool_result", toolName: "write", toolCallId: "c1/1", parentToolCallId: "c1", input, content: [text], isError: false });
  expect(patches.every((r) => r === undefined)).toBe(true);
  const result = { content: [text], details: {} };
  await emit("tool_execution_end", { type: "tool_execution_end", toolName: "write", toolCallId: "c1/1", parentToolCallId: "c1", result, isError: false });
  const notice = { type: "text", text: `\n${THEN_RUN_IGNORED} $ bun test — called from a script; run the command with bash from the script.` };
  expect(result.content).toEqual([text, notice]);
  await emit("tool_execution_end", { type: "tool_execution_end", toolName: "write", toolCallId: "c1/1", parentToolCallId: "c1", result, isError: false });
  expect(result.content).toEqual([text, notice]);
});

test("a nested call whose result has structuredContent.warnings gets the notice there too", async () => {
  const emit = load();
  const input: Record<string, unknown> = { remove_from: "abcd", then_run: { command: "bun test" } };
  await emit("tool_call", { type: "tool_call", toolName: "replace", toolCallId: "c1/1", parentToolCallId: "c1", input });
  const result = { content: [text], structuredContent: { ok: true, warnings: ["w"] }, details: {} };
  await emit("tool_execution_end", { type: "tool_execution_end", toolName: "replace", toolCallId: "c1/1", parentToolCallId: "c1", result, isError: false });
  const notice = `\n${THEN_RUN_IGNORED} $ bun test — called from a script; run the command with bash from the script.`;
  expect(result.structuredContent.warnings).toEqual(["w", notice]);
  expect(result.content).toEqual([text, { type: "text", text: notice }]);
});

test("a top-level call gets no ignored notice", async () => {
  const emit = load();
  const input: Record<string, unknown> = { path: "a.ts", then_run: { command: "bun test" } };
  await emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "c1", input });
  const result = { content: [text], details: {} };
  await emit("tool_execution_end", { type: "tool_execution_end", toolName: "write", toolCallId: "c1", result, isError: false });
  expect(result.content).toEqual([text]);
});

test("a Pi that never emits tool_execution_end for nested calls gets no notice, and agent_end drops the record", async () => {
  const emit = load();
  const input: Record<string, unknown> = { path: "a.ts", then_run: { command: "bun test" } };
  await emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "c1/1", parentToolCallId: "c1", input });
  await emit("agent_end", { type: "agent_end", messages: [] });
  const result = { content: [text], details: {} };
  await emit("tool_execution_end", { type: "tool_execution_end", toolName: "write", toolCallId: "c1/1", parentToolCallId: "c1", result, isError: false });
  expect(result.content).toEqual([text]);
});

test("then_run: null is treated as absent on assistant messages and nested calls", async () => {
  const emit = load();
  const args: Record<string, unknown> = { path: "a.ts", content: "x", then_run: null };
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: args }] } });
  expect("then_run" in args).toBe(false);
  const done = await emit("message_end", { type: "message_end", message: { role: "toolResult", toolName: "write", toolCallId: "c1", content: [text], isError: false } });
  expect(done.every((r) => r === undefined)).toBe(true);

  const input: Record<string, unknown> = { path: "a.ts", then_run: null };
  await emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "c2/1", parentToolCallId: "c2", input });
  expect("then_run" in input).toBe(false);
  const result = { content: [text], details: {} };
  await emit("tool_execution_end", { type: "tool_execution_end", toolName: "write", toolCallId: "c2/1", parentToolCallId: "c2", result, isError: false });
  expect(result.content).toEqual([text]);
});

test("a null timeout falls back to the default", async () => {
  const { parseThenRun } = await import("../src/index.ts");
  expect(parseThenRun({ then_run: { command: "bun test", timeout: null } })).toEqual({ command: "bun test" });
});
