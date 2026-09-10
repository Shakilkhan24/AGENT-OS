# Changelog

All notable changes to MINIMAL are recorded here. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Hardening and fixes accumulated after the v1.1.0 baseline. **This version has not been tagged or released yet.** Use the same v1.1.0 tag for now; a release will be cut once the work in this section is reviewed and accepted.

### Hardening

The seven commits between v1.1.0 and this snapshot are recorded in [`docs/v1.2-work.md`](docs/v1.2-work.md) and summarised below.

- Bounded FIFO mutex with cancellation, atomic JSON writes, structured error envelopes, daily NDJSON logs with payload redaction, and Zod-validated profile settings.
- Bounded, atomically persisted event bus with sequence validation, replay-gap detection, and delivery only after persistence.
- Explicit schema migration to v2 records (launch intents, environment profiles, hook definitions, session metadata, terminal lifecycle). Original v1 bytes are content-addressed and preserved on disk.
- Separated `EngineAdapter` contract, tmux implementation, and disposable PTY transport. Length-prefixed tmux metadata preserves tabs, newlines, and UTF-8. PTY queue accounting is now byte-based.
- Profile runtime/configuration ownership checks, explicit environment propagation, clean-shell mode, and bounded `/proc`-based stop policies.
- Replaced the global work queue with short state commits, a launch coordinator, coalesced reconciliation, and a stop coordinator. Per-item launch progress, cancellation between items, and idempotent retries are now explicit.
- File operations with typed request/response envelopes, a bounded cancellable mutex, deadlines, expected-hash save races, draft recovery across restart, descriptor-cursor listings, header-first binary classification, and recursive deletion with bounds.

### Fixes since the v1.1.0 baseline

- **Right-click paste with multi-line content.** The clipboard handler now wraps pasted text that contains newlines, carriage returns, or tabs in the standard bracketed-paste escape sequences (`\x1b[200~ … \x1b[201~`), so a pasted multi-line script arrives at the shell as a single atomic edit instead of being split by Enter. tmux's `escape-time` was also restored to the documented default of 500 ms so multi-byte escape sequences are reassembled correctly. The change is covered by a regression scenario in `tests/desktop.spec.ts`.

### Test coverage

41 backend scenarios and 4 desktop scenarios pass. The packaged-runtime smoke test runs 12 active output-producing terminals with the renderer sandbox enabled, switches all 12 tabs, and verifies every PID survives GUI closure.

### Repository hygiene

`LICENSE` (ISC), `SECURITY.md`, `.github/workflows/ci.yml`, and this `CHANGELOG.md` were added so the repository is publishable on GitHub. `FUTURE/` (planning material for work beyond v1.x) is excluded from the published tree.

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

