# pi-then-run

Adds an optional `then_run` argument to file-mutating tools registered by other Pi extensions — most usefully [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro)'s `replace` and `insert`, plus Pi's `write` — so the validation command you would run next executes in the same tool call. It replaces NVlabs/SoL-Pi Action Fusion when hashline is installed (see below).

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

or `[then_run:failed] … (exit 1)` with the output, or `[then_run:skipped] … — <reason>` when nothing was written (mutation error, no-op, or an edit queued in a hashline batch — the batch's last call runs it).

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

Targets default to `replace`, `insert`, `write`, `edit`; default timeout 120 s (max 900). No configuration file yet.

## Develop

```bash
bun install && bun run verify
```
