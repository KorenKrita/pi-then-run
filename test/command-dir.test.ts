import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandDir } from "../src/index.ts";
import { compose, editedPath } from "../src/then-run.ts";

/** A real `exec` for git, the only command commandDir runs. */
const pi = {
  exec: async (cmd: string, args: string[]) => {
    try {
      return { stdout: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), stderr: "", code: 0, killed: false };
    } catch {
      return { stdout: "", stderr: "", code: 1, killed: false };
    }
  },
} as never;

const root = realpathSync(mkdtempSync(join(tmpdir(), "then-run-dir-")));
const outer = join(root, "outer");
const inner = join(outer, "vendor", "inner");
const plain = join(root, "plain", "sub");
for (const d of [join(outer, "src"), join(inner, "lib"), plain]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", outer]);
execFileSync("git", ["init", "-q", inner]);
writeFileSync(join(outer, "src", "a.ts"), "");

test("runs in the innermost git repository root containing the file", async () => {
  expect(await commandDir(pi, join(outer, "src", "a.ts"), "/fallback")).toBe(outer);
  expect(await commandDir(pi, join(inner, "lib", "b.ts"), "/fallback")).toBe(inner); // nested repo wins
});

test("outside git it runs in the file's directory; unknown or missing paths fall back", async () => {
  expect(await commandDir(pi, join(plain, "c.txt"), "/fallback")).toBe(plain);
  expect(await commandDir(pi, "src/a.ts", outer)).toBe(outer); // relative to the session cwd
  expect(await commandDir(pi, undefined, "/fallback")).toBe("/fallback");
  expect(await commandDir(pi, join(root, "missing", "x.ts"), "/fallback")).toBe("/fallback");
});

test("editedPath prefers hashline's snapshotId over the call's path", () => {
  expect(editedPath({ snapshotId: "v2|/abs/file.ts|150246844|1792810117472.5|1792810117477.3|13294" }, "rel.ts")).toBe("/abs/file.ts");
  expect(editedPath({ snapshotId: "v2|/abs/a|b.ts|1|2|3|4" }, undefined)).toBe("/abs/a|b.ts"); // "|" inside the path
  expect(editedPath({}, "@src/x.ts")).toBe("src/x.ts"); // Pi strips a leading @ from tool paths
  expect(editedPath({}, "file:///abs/y.ts")).toBe("/abs/y.ts");
  expect(editedPath({}, "rel.ts")).toBe("rel.ts");
  expect(editedPath(undefined, undefined)).toBeUndefined();
});

test("the result names the directory the command ran in", () => {
  const out = compose({ content: [{ type: "text", text: "ok" }], details: undefined }, "bun test", { output: "", exitCode: 0, timedOut: false, cwd: "/home/u/repo", displayCwd: "~/repo" });
  expect((out.content[1] as { text: string }).text).toContain("$ bun test (in ~/repo, exit 0)");
  expect((out.details as { then_run: { cwd: string } }).then_run.cwd).toBe("/home/u/repo"); // absolute in details
});
