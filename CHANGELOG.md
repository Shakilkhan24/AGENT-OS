# Changelog

All notable changes to MINIMAL are recorded here. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-10

Hardening release. No user-facing features added or removed; the foundation is now stronger, more observable, and easier to extend without breaking existing invariants.

### Foundation hardening

- Bounded FIFO mutex with cancellation, atomic JSON writes, structured error envelopes, daily NDJSON logs with payload redaction, and Zod-validated profile settings. (`#1010241`)
- Bounded, atomically persisted event bus with sequence validation, replay-gap detection, and delivery only after persistence. (`#27199e5`)
- Explicit schema migration to v2 records (launch intents, environment profiles, hook definitions, session metadata, terminal lifecycle). Original v1 bytes are content-addressed and preserved on disk. (`#dad2b11`)
- Separated `EngineAdapter` contract, tmux implementation, and disposable PTY transport. Length-prefixed tmux metadata preserves tabs, newlines, and UTF-8. PTY queue accounting is now byte-based. (`#06be29a`)
- Profile runtime/configuration ownership checks, explicit environment propagation, clean-shell mode, and bounded `/proc`-based stop policies. (`#0c076af`)
- Replaced the global work queue with short state commits, a launch coordinator, coalesced reconciliation, and a stop coordinator. Per-item launch progress, cancellation between items, and idempotent retries are now explicit. (`#9865ee7`)
- File operations with typed request/response envelopes, a bounded cancellable mutex, deadlines, expected-hash save races, draft recovery across restart, descriptor-cursor listings, header-first binary classification, and recursive deletion with bounds. (`#4855b3e`)

### Test coverage

41 backend scenarios and 4 desktop scenarios pass. The packaged-runtime smoke test runs 12 active output-producing terminals with the renderer sandbox enabled, switches all 12 tabs, and verifies every PID survives GUI closure. File-previews, save conflicts, draft restoration, and WSL fallback interruptions all have dedicated tests.

### Out of scope (planned for v1.3+)

The `FUTURE/` directory holds planning material for upcoming work (managed single-agent workflow, schedules, recipes, owned remote execution, paid release). It is not part of this release.

## [1.1.0] - 2026-09-09

Initial public release. Verified against the snapshot in [`docs/build-snapshot-v1.1.md`](docs/build-snapshot-v1.1.md).

### Highlights

- Persistent project sessions bound to directories, with independent terminals that survive GUI closure.
- Reusable command presets with batch launches (1–32 terminals per batch).
- Scoped file explorer with atomic text editing, expected-hash save races, and Linux `openat2` containment.
- Private tmux server under `/tmp/minimal-<uid>/`; ordinary tmux sessions are unaffected.
- Sandboxed Electron renderer with `connect-src 'none'`, exact main-frame sender validation, and no Node integration in the renderer.
- 13 backend test cases, 3 desktop scenarios, and a packaged-runtime smoke test.

[1.2.0]: #120---2026-09-10
[1.1.0]: #110---2026-09-09

### Note on commit links

Commit SHAs reference the local baseline used during the v1.2 work log. The repository will publish its full commit history with the GitHub release.
