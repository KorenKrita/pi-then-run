import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@earendil-works/pi-ai";
import { advertiseInSchemas, parseThenRun, systemPromptSection } from "../src/index.ts";
import { clipOutput, compose, composeSkipped, decide, THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED, type ToolResult } from "../src/then-run.ts";

const ok = (text: string, details: JsonValue | undefined = { patch: "x" }): ToolResult => ({ content: [{ type: "text", text }], details });

describe("decide", () => {
  test("runs after a written mutation", () => {
    expect(decide(ok("--- diff\n+abc"), false)).toEqual({ run: true });
  });
  test("skips when the mutation threw", () => {
    expect(decide(ok("E_RANGE_STALE"), true)).toEqual({ run: false, reason: "mutation_failed" });
  });
  test("skips hashline batch members (nothing written yet)", () => {
    expect(decide(ok("In batch"), false)).toEqual({ run: false, reason: "deferred" });
    expect(decide(ok("In batch 2"), false)).toEqual({ run: false, reason: "deferred" });
    // a diff that merely mentions the phrase mid-line is not a batch notice
    expect(decide(ok("+ // In batch mode we retry"), false)).toEqual({ run: true });
  });
  test("prefers hashline's structured batch/noop signals when present", () => {
    expect(decide(ok("diff text", { batch: { last: false } }), false)).toEqual({ run: false, reason: "deferred" });
    expect(decide(ok("diff text", { batch: { last: true } }), false)).toEqual({ run: true });
    expect(decide(ok("whatever", { metrics: { classification: "noop" } }), false)).toEqual({ run: false, reason: "noop" });
  });
  test("skips no-op edits", () => {
    expect(decide(ok("No changes made"), false)).toEqual({ run: false, reason: "noop" });
  });
});

describe("compose", () => {
  test("appends a succeeded block and structured details, preserving the mutation's own details", () => {
    const out = compose(ok("diff"), "bun test", { output: "3 pass", exitCode: 0, timedOut: false });
    expect(out.content.map((c) => (c as { text: string }).text)).toEqual(["diff", `\n${THEN_RUN_SUCCEEDED} $ bun test (exit 0)\n3 pass`]);
    expect(out.details).toEqual({ patch: "x", then_run: { command: "bun test", exitCode: 0, timedOut: false, succeeded: true } });
  });
  test("failed exit and timeout are marked failed", () => {
    expect((compose(ok("d"), "x", { output: "", exitCode: 1, timedOut: false }).content[1] as { text: string }).text).toBe(`\n${THEN_RUN_FAILED} $ x (exit 1)`);
    expect((compose(ok("d"), "x", { output: "", exitCode: 0, timedOut: true }).content[1] as { text: string }).text).toBe(`\n${THEN_RUN_FAILED} $ x (timed out)`);
  });
  test("skipped explains why and keeps non-object details under a key", () => {
    const out = composeSkipped(ok("In batch", null), "bun test", "deferred");
    expect((out.content[1] as { text: string }).text).toContain(`${THEN_RUN_SKIPPED} $ bun test — the edit is queued in a batch`);
    expect(out.details).toEqual({ mutation: null, then_run: { command: "bun test", skipped: "deferred" } });
  });
});

describe("parseThenRun", () => {
  test("accepts command with optional bounded timeout; rejects junk", () => {
    expect(parseThenRun({ then_run: { command: "bun test" } })).toEqual({ command: "bun test" });
    expect(parseThenRun({ then_run: { command: "x", timeout: 5000 } })).toEqual({ command: "x", timeout: 900 });
    expect(parseThenRun({ then_run: { command: "   " } })).toBeNull();
    expect(parseThenRun({ then_run: "bun test" })).toBeNull();
    expect(parseThenRun({})).toBeNull();
  });
});

describe("clipOutput", () => {
  test("keeps head and tail", () => {
    const s = `${"A".repeat(100)}${"B".repeat(100)}${"C".repeat(100)}`;
    const c = clipOutput(s, 100);
    expect(c.startsWith("A".repeat(40))).toBe(true);
    expect(c.endsWith("C".repeat(60))).toBe(true);
    expect(c).toContain("200 chars omitted");
  });
});

describe("systemPromptSection", () => {
  test("names only the tools passed in", () => {
    const s = systemPromptSection(["replace", "insert"]);
    expect(s).toContain("`replace`, `insert`");
    expect(s).not.toContain("`write`");
  });
});

describe("advertiseInSchemas", () => {
  test("adds then_run to targeted object schemas in place, idempotently, and leaves others alone", () => {
    const replaceParams = { type: "object", properties: { remove_from: { type: "string" } }, additionalProperties: true };
    const readParams = { type: "object", properties: { path: { type: "string" } } };
    const fakePi = { getAllTools: () => [{ name: "replace", parameters: replaceParams }, { name: "read", parameters: readParams }] } as unknown as Parameters<typeof advertiseInSchemas>[0];
    expect(advertiseInSchemas(fakePi, new Set(["replace"]))).toEqual(["replace"]);
    expect("then_run" in replaceParams.properties).toBe(true);
    expect("then_run" in readParams.properties).toBe(false);
    const before = JSON.stringify(replaceParams);
    advertiseInSchemas(fakePi, new Set(["replace"]));
    expect(JSON.stringify(replaceParams)).toBe(before);
  });
});
