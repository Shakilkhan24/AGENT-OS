# Verification


## v1.2.2 — M0 foundation prerequisites

Implementation began from roadmap commit `8f4137f` on `feat/m0-foundation`, with application baseline `3d96f78`. The initial working tree was clean. The baseline was freshly reproduced: 73 backend tests, 89 desktop tests, typecheck/build and the legacy package smoke passed before repairs. Temporary test profiles and private tmux sockets preserve the user's running work.

Environment inspected: WSL/Linux, development Node 22.23.2 (the shell default 20.19.6 is too old), Python 3.13.11, tmux 3.4; Electron 44.2.0, React 19.2.8, TypeScript 7.0.2, Vite 8.2.2, xterm 6.0.0, Zod 4.5.4. Application JSON schema remains 2, Python file protocol 2 and settings schema 1. `profilePaths()` still derives the private `/tmp/minimal-<uid>/<sha256(profile-path)[0:20]>.sock` namespace; no profile was moved.

| Check | Result |
| --- | --- |
| Typecheck and build | Passed; build cleans `dist` before compilation |
| Backend regressions | 84 passed in 97.3 seconds; includes the nested release, ownership and provider-discovery regressions |
| Desktop regression suite | 92 passed in 6.3 minutes on a private Xvfb display with two workers; exit 0 |
| Clean package + separate smoke | Both passed for 1.2.2, with no global Node/npm on the app PATH; 12 live terminal switches took 1,141 ms and 1,840 ms respectively; clean GUI exit retained every PID |
| Recursive discovery | 92 desktop cases across seven files, including both nested regression files; backend discovery includes nested tooling cases and excludes fixtures/symlinks |
| Publication faults | Smoke failure, injected exceptions and SIGKILL at staging, verification, retention, previous-pointer and current-pointer boundaries; complete old/new locator, subsequent publish, stale-asset exclusion and rollback passed |
| Upgrade refusal | Newer schemas stay byte-for-byte intact after caught load errors, save attempts and reopening. Unloaded/unreadable stores refuse writes. Corrupt-byte backup and v1 migration regressions still pass |
| Draft recovery | A real IPC save acknowledgement followed immediately by SIGKILL restores Unicode edits as unsaved; the source file remains unchanged |
| `npm run test:runtime` | Passed with the packaged binary, no display or global Node. Node 24.20.0 / SQLite 3.53.4; duplicate owner rejected, lock inode retained, child descriptor leak rejected, committed rows recovered and interrupted rows absent, integrity OK, same cold-started tmux PID after SIGKILL/restart/SIGTERM |
| `npm run test:runtime -- --systemd` | Passed in a transient user unit with `KillMode=process`, including reuse of the execution backend. Unit is stopped afterwards; no autostart installation |
| `npm run probe:providers` | Codex 0.154.0 and Claude Code 2.1.268 version/help inspected. No prompts, credentials or quota used. Live invocation, continuation, permissions and native background replay are explicitly unqualified |

The first draft E2E run exposed an automation teardown race in Chromium's before-unload dialog handling. Installing the same explicit dialog handler used by the existing suite resolved it; the persistence and source-content assertions passed. The first detached probe also exposed a test-harness lifetime bug: an unreferenced child could let Node exit before its exit observation. The harness now keeps that observation referenced. Neither failure is counted as a successful probe.

Release publication uses fsync and a same-filesystem symlink rename; the tests exercise process interruption, not physical power removal or every storage-controller failure. Staging and unselected retained builds may remain after abrupt death and are never mistaken for `current`. Binary rollback leaves application state alone and cannot make an incompatible schema readable. M1 still needs production runtime integration; the probe's SQLite table is not application storage. Existing external-writer save races and WSL move fallback semantics remain documented in [recovery](recovery.md).

## Archived v1.2.1 verification

Verified on 2026-09-13: 73 backend cases, 89 desktop cases, typechecking, production build and packaged-runtime smoke pass. The desktop runner exits successfully with no teardown timeout. Twenty fresh-server exit-recovery trials also passed.

| Check | Result |
| --- | --- |
| `npm run check` | 73 backend cases, typecheck and build passed |
| `npm run test:desktop -- --workers=2` | 89 passed in 6.7 minutes on a private Xvfb display; exit 0 |
| `npm run package` | Standalone Linux package built successfully |
| `npm run test:package` | Sandboxed renderer; 12 output-producing terminals; clean GUI exit; every process survives |
| Release metadata | Application, lockfile and packaged manifest all report 1.2.1 |

Focused regressions cover blocked and reordered writes, failed-save visibility, malformed/future-schema recovery backups, failed event publication, pending-launch shutdown, quitting during renderer loading, multiline paste execution and sustained Unicode output. The loading-close and settings-restart checks each passed three consecutive runs. These assertions check resulting state or command output rather than only echoed input.

Microbenchmark on this WSL host: state mutation p95 11.14 ms (review baseline 56.70 ms); durable single-event publication p95 12.42 ms; 25 concurrent simulated snapshots p95 2.15 ms. The benchmark uses 36 fake terminals. It does not certify real first-prompt latency or the original 128-terminal and warm-tab-switch budgets. The final packaged smoke switched 12 real terminal tabs in 1,549 ms total; that is a broad regression check, not a per-switch p95 measurement.

The original requirement mapping below is retained for orientation. Feature availability is defined by the [current snapshot](build-snapshot-v1.2.1.md), not by historical release claims.

The acceptance criteria come from the original [ins.md](../ins.md). Tests use real tmux processes, actual filesystem operations, and Electron on WSLg or a private Xvfb display. Fault-recovery tests additionally inject a single engine failure or stop a disposable helper.

| Requirement                                              | Implementation and verification                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create sessions bound to directories                     | Native chooser and typed directory field; root canonicalization and persisted device/inode identity. Backend and desktop tests create sessions.                                                                                                                  |
| List name, directory, terminal count                     | Sidebar renders live snapshot metadata; desktop tests inspect and select session cards.                                                                                                                                                                          |
| Switch sessions without losing work                      | Independent tmux sessions per terminal; desktop test switches projects and compares original PIDs.                                                                                                                                                               |
| Rename and delete sessions                               | Durable service mutations and confirmation dialogs; backend and desktop tests exercise both. Session deletion keeps project files.                                                                                                                               |
| Add/remove independent terminals                         | Each terminal owns a UUID, command, launch directory, label and tmux process. Integration tests verify distinct PIDs and directories; desktop tests use the fixed add button and each tab’s cross, preserving unaffected PIDs and checking active-tab selection. |
| Configurable workflow presets                            | Presets are editable persisted data. Desktop test creates a custom command through the preset editor and launches it.                                                                                                                                            |
| Bulk creation and labels                                 | 1–32 terminals per request with unique auto-labels. Backend test creates twelve workers and checks labels, PIDs, and working directories.                                                                                                                        |
| Browse, open, create, rename, delete, move files/folders | Descriptor-based file service and explorer/editor UI. Backend tests cover CRUD and no-overwrite behavior on both Linux storage and the actual Windows-mounted workspace; desktop scenarios cover toolbar actions and editing.                                    |
| Scoped filesystem access                                 | Tests reject absolute paths, parent traversal, symlink escapes, hard-linked file access, root mutation, and replacement of the bound directory. Linux openat2 additionally prohibits mounted subtrees and magic links.                                           |
| Survive GUI close/reopen                                 | Desktop test closes Electron, inspects surviving tmux processes, relaunches the app, and asserts identical PIDs.                                                                                                                                                 |
| Reconcile actual running state                           | Fast-exit test preserves exit code 7 and proves a command is not rerun. A killed terminal becomes missing. Interrupted launch intents and deletion tombstones are recovered using real saved state.                                                              |
| Auditable control interface                              | `EngineAdapter` is the only session/process control interface. All tmux execution and attachments live in `TmuxEngine` and its private helpers.                                                                                                                 |
| Modular, extensible foundation                           | Separate typed UI bridge, domain service, store, engine, filesystem provider, and renderer modules. [Architecture](architecture.md) describes extension boundaries.                                                                                              |
| Responsive with 10+ background sessions/terminals        | Tests run twelve workers in one session and twelve independent sessions; validate distinct live processes, bounded snapshot latency, and concurrent file listing. Inactive terminals have no renderer clients.                                                   |
| Working desktop deliverable                              | Production build and Electron UI test, plus a standalone packaged application directory. [desktop.png](desktop.png) captures the running app.                                                                                                                    |

The v1.1 regression suite includes 13 backend cases and three desktop scenarios. New coverage exercises direct commands, saving a preset during launch, adding a second batch, tab overflow, closing every terminal and launching again, editing a failed command, restoring tab selection, hiding the explorer, reconnecting without a new process, partial batch failures, snapshot sequencing, file-helper recovery, and an intact 1.44 MB Unicode paste. Screenshots show the [command box](launcher.png) and [terminal controls](terminals.png).

Validation commands are `npm run check`, `npm run test:desktop`, `npm run package`, and `npm run test:package`. The desktop suite requires a graphical Linux session or WSLg. Kernel/process retention across a reboot is not claimed: unavailable terminals stay visible without command replay.

The packaged-runtime smoke test launches the executable with Chromium's sandbox enabled, starts twelve continuously output-producing terminals, switches all twelve tabs, closes the GUI, and verifies every PID survives. The regression bound for twelve switches is 5 seconds. File-preview checks cover editable text, a rendered PNG image, generic binary bytes, a blocked FIFO, and mounted-filesystem escape rejection.
