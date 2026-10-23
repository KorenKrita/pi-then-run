# pi-then-run

Adds an optional `then_run` argument to file-mutating tools registered by other Pi extensions — most usefully [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro)'s `replace` and `insert`, plus Pi's `write` — so the validation command you would run next executes in the same tool call. It replaces NVlabs/SoL-Pi Action Fusion when hashline is installed (see below).

Works with stock Pi too: the built-in `edit` and `write` tools are targets, so no other extension is needed.

```jsonc
// replace call
{ "remove_from": "JsEd", "remove_to": "JsEd", "replacement_lines": ["    return a + b"],
  "then_run": { "command": "bun test", "timeout": 120 } }
```

The tool result gains a trailing block:

```
[then_run:succeeded] $ bun test (exit 0)
3 pass
```

or `[then_run:failed] … (exit 1)` with the output, or `[then_run:skipped] … — <reason>` when nothing was written (mutation error, no-op, or an edit queued in a hashline batch — the batch's last call runs it). A call made from a codemode script never runs `then_run`; its result gets `[then_run:ignored] …` instead. The notice is added in the nested call's `tool_execution_end` event, after every extension's `tool_result` patch, so an extension that rewrites the result (hashline does) cannot drop it in either load order. Pi versions that do not emit that event for nested calls show no notice; the command still does not run.

## Complete validation logs

When command output exceeds 20,000 characters, the extension saves the complete combined stdout/stderr **before** making the head-and-tail preview. The result includes `Full output: <path>` and `details.then_run.fullOutputPath`; use `read` on that path to inspect omitted diagnostics.

Each log lives in a new private directory at `<session-directory>/then-run-<session-id>-<random>/output.log`. On POSIX, the directory is mode `0700` and the file is `0600`. Logs remain local, survive session resume, and are not automatically deleted. They can contain sensitive command output; treat them like the session transcript.

Relative `--session-dir` paths use Pi's process working directory (which can differ from the SDK session's project directory). Returned log paths are absolute.

Short output and skipped commands create no archive. If saving fails, or the session has no persistent directory, the complete output stays inline with an explicit `[then_run:archive_failed]` notice and `details.then_run.archiveError`. The command's success, exit code, timeout flag, and the mutation's error state are unchanged.

## Why not SoL-Pi Action Fusion

NVlabs/SoL-Pi's Action Fusion wraps Pi's built-in `edit`/`write`. If you use pi-hashline-edit-pro, `edit` is disabled and your edits go through `replace`/`insert`, which Action Fusion does not touch. This extension attaches to whatever tool names you configure without re-registering or forking them.

## How it attaches (no fork, no re-registration)

1. On `session_start` the `then_run` property is added to the target tools' live parameter schemas (TypeBox schemas are plain mutable objects and `pi.getAllTools()` returns them by reference), so the model sees it as a real parameter. Models that trust the schema over prose — Claude does — will not use an unadvertised field.
2. In the assistant `message_end` hook the argument is removed in place from the persisted tool call (so strict targets like hashline never see it) and parked by tool-call id.
3. In the toolResult `message_end` hook — after every extension's `tool_result` patch — the command runs and its output is appended.

Works in either load order relative to the target extension. Verified on Pi 0.85.1 with pi-hashline-edit-pro 4.2.1: single edit, same-file batch (only the last call runs), and both `packages` orders.

## Install

```bash
pi install git:github.com/KorenKrita/pi-then-run
```

Targets default to `replace`, `replace_match`, `insert`, `write`, `edit`; default timeout 120 s (max 900). No configuration file yet.

## Develop

```bash
bun install && bun run verify
```
