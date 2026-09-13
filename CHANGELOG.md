# Changelog

All notable changes to MINIMAL are recorded here. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

M1 runtime foundation, in progress.

- Introduce the shared versioned control manifest, preload handshake, typed replies, validated terminal signals and visible protocol failures.
- Bound pending requests by count and UTF-8 bytes; carry deadlines/cancellation into file operations and launch batches without undoing started terminals or replaying uncertain mutations.
- Refresh workspace state from committed event hints so terminal exit status appears promptly, retaining polling as a fallback.
- Add an authenticated local socket transport with bounded framing, per-connection cancellation, slow-peer protection and explicit disconnect uncertainty; runtime deployment remains pending.
- Consolidate domain operations in an Electron-independent workspace used by the desktop facade and headless socket tests. Bind attachment control to its connection and preserve accepted batches across observer disconnects.

## [1.2.2] - 2026-09-13

M0 compatibility and packaging prerequisites for the FUTURE roadmap.

- Discover backend and desktop tests recursively; list both suites in CI.
- Build into clean output and fresh release staging, smoke the exact candidate without global Node/npm, then atomically select an immutable build. Retain a previous build for explicit rollback. Preserve legacy release directories.
- Refuse newer state schemas and all saves after failed/unreadable initialization. Preserve malformed-state recovery backups and existing version-1 migration.
- Add roving terminal-tab keyboard navigation and accessible dialog names/focus restoration.
- Test acknowledged Unicode drafts after SIGKILL, publication interruptions and stale assets.
- Add isolated packaged runtime/SQLite and OS-lock experiments, including real tmux survival under detached and user-service ownership. Add read-only provider capability discovery that explicitly distinguishes advertised features from verified support.

The runtime experiments do not migrate profiles or move production ownership out of Electron. Live provider qualification, transactional application storage and managed execution remain later milestones. See [verification](docs/verification.md) and the [roadmap](FUTURE/IMPLEMENTATION-README.md).

## [1.2.1] - 2026-09-13

Bug-fix baseline after the [source review](docs/review-2026-09-12.md).

- Serialize active writes and drain them during shutdown; surface persistence failures.
- Commit validated state only after disk success. Restore data and directory fsync by default; remove the fixed 50 ms save delay.
- Preserve corrupt/unsupported state in a durable recovery copy before allowing edits; make the recovery notice available after renderer startup.
- Restore acknowledged, bounded terminal input; correct UTF-8 output accounting and multiline paste; cancel disposed rendering callbacks.
- Drain accepted IPC and active launch work before closing storage. Report failed shutdown separately from success.
- Drain shutdown before closing a loading renderer; prevent repeated quit requests from bypassing the drain. Suppress expected load-abort dialogs and dispose restarted test applications completely.
- Recover unreaped tmux pane exits during polling without signalling terminal jobs or fabricating exit codes.
- Strengthen tests to verify actual command output, durable saves, recovery copies, write ordering and cancellation.
- Correct unsupported completion claims and align package/lockfile versions. See the [current baseline](docs/build-snapshot-v1.2.1.md) for verification and remaining scope.

The 1.2.0 notes below are historical; their durability/performance guarantees were not all supported by the implementation.

## [1.2.0] - 2026-09-12

Hardening, performance, and resilience on top of the v1.1.0 baseline. The seven foundation commits are recorded in [`docs/v1.2-work.md`](docs/v1.2-work.md); the work in this release is summarised below.

### Performance

- **Debounced state writes.** `Store.save` coalesces a burst of mutations into one `fsync` inside a 50 ms trailing-edge window; the latest state always wins. `Store.flush()` returns a promise that resolves once the in-flight write lands on disk, and `Store.close()` drains before the process exits. Durability is configurable (`"strong"`, `"async-strong"`, `"crash"`); the default is `async-strong` (data `fsync`, no directory `fsync`). The event bus uses the same shape — `EventBus.publishMany` enqueues events in sequence order, subscribers see them immediately, and the on-disk journal lags by at most 25 ms.
- **Frozen zero-copy state views.** `WorkspaceState.view()` returns a `Readonly<State>` reference that is recomputed only when the state mutates. The reconciler, snapshot builder, and coordinators read from this view instead of deep-cloning on every call; `view()` measures 0.00 ms in the hot-path benchmark.
- **Coalesced concurrent snapshots.** A burst of concurrent `Reconciler.snapshot()` calls (e.g. a renderer poll plus a watcher event plus an incoming IPC) folds into a single engine `inspect()` call. With 25 parallel callers the median wall-clock is 1.85 ms — the same as a single cold call.
- **Per-frame xterm output coalescing.** Terminal output from the PTY is buffered in the renderer until the next animation frame and delivered to xterm.js as one `write()` per frame, with a single acknowledgement that aggregates the bytes. The `input` IPC handler is now `send` (fire-and-forget) instead of `invoke`, removing one round-trip per keystroke.
- **Memoised tab bar and 4 s polling.** `TerminalTabs` is wrapped in `React.memo` and the workspace polling interval moved from 2 s to 4 s, halving snapshot traffic without affecting perceived freshness.

Run `npm run bench` for the median/p95 numbers per scenario. The benchmark harness is a non-test script under `scripts/bench.mts`; it is not part of the gate.

### Durability

- **`runWithWatchdog` shutdown helper.** `will-quit` awaits `workspace.close()` (which awaits `Store.close()` + `EventBus.close()`) inside a 5 s budget. On timeout the helper logs `shutdown-flush-timeout` and forces `app.exit(1)`. State already on disk is preserved; only the last in-flight debounced write may be lost, which matches the documented renderer-side guarantee.
- **Headless-safe malformed-state recovery.** `Store.load()` catches parse errors internally, leaves `state.json` byte-for-byte unchanged on disk, falls back to the empty default, and exposes `recoveredFromInvalid` so the main process can send a `startup-recovered` IPC to the renderer after `did-finish-load`. The renderer surfaces the reason through the existing toast mechanism. The app no longer depends on a display server for startup; an unreachable `dialog.showErrorBox` cannot block recovery.

### Renderer changes

- **Launch-error UX.** A terminal whose engine creation fails now shows its failure in the tab surface (`<h2>Could not start this terminal</h2>` with the `launchError` reason and an Edit & run hint). The redundant global toast — which read like "1 terminal(s) could not start..." — is gone. After a launch with errors, the renderer auto-selects the first failed tab so the user lands on the surface that explains the failure.
- **Reconciler preserves undefined exit fields.** When the engine reports a still-running process with no exit metadata, the reconciler no longer clobbers an already-recorded exit code or signal with `undefined`.

### Test coverage

58 backend scenarios pass (`npm test`) including a new `tests/durability.test.ts` (9 cases pinning the `Debouncer<T>` contract, the journal coalescing order, and the three `atomicJson` durability levels), a new `tests/shutdown.test.ts` (4 cases pinning the watchdog contract), `tests/store.test.ts` updated for the recovery contract, and `tests/perf.test.ts` covering the inspect coalescing behaviour.

87 desktop scenarios pass (`npm run test:desktop`), including a new `tests/shutdown-flush.spec.ts` (2 cases force-killing the Electron process after a debounced write and asserting the latest mutation is durable on disk).

### Repository hygiene

The seven v1.2 foundation commits, `LICENSE` (ISC), `SECURITY.md`, `.github/workflows/ci.yml`, this `CHANGELOG.md`, and `.githooks/pre-push` (a local gate mirroring the headless CI job) were added so the repository is publishable on GitHub. `FUTURE/` (planning material for work beyond v1.x) is excluded from the published tree.

## [1.1.0] - 2026-09-09

Initial public release. Verified against the snapshot in [`docs/build-snapshot-v1.1.md`](docs/build-snapshot-v1.1.md).

### Highlights

- Persistent project sessions bound to directories, with independent terminals that survive GUI closure.
- Reusable command presets with batch launches (1–32 terminals per batch).
- Scoped file explorer with atomic text editing, expected-hash save races, and Linux `openat2` containment.
- Private tmux server under `/tmp/minimal-<uid>/`; ordinary tmux sessions are unaffected.
- Sandboxed Electron renderer with `connect-src 'none'`, exact main-frame sender validation, and no Node integration in the renderer.
- 13 backend test cases, 3 desktop scenarios, and a packaged-runtime smoke test.

[1.1.0]: #110---2026-09-09
[1.2.0]: #120---2026-09-12


[1.2.1]: #121---2026-09-12
