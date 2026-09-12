# MINIMAL — v1.2.1 bug-fix baseline

This snapshot describes the current working foundation. It supersedes the completion claims in the old v1.2 work log. The [September 12 review](review-2026-09-12.md) remains a historical record of the defects that led to this repair.

**Stack:** Electron 44, React 19, TypeScript 7, Vite 8/esbuild, xterm.js 6, Zod 4, Node 22+, Bash, tmux and Python. Supported runtime: Linux and WSL2 with WSLg. Persistence uses JSON files and filesystem drafts, with no database.

**Working features:** project sessions; custom commands and reusable presets; batch launch of 1–32 terminals; up to 128 terminals per session; add, rename, close and reconnect individual terminals; remembered selection and explorer visibility; scoped file navigation/editing; reviewed save conflicts; recoverable editor drafts; paged virtual directory lists; image/binary previews; persistent tmux work across GUI closure; visible exit/failure state.

**Backend boundaries:** `EngineAdapter` separates tmux from application services. `WorkspaceState`, `LaunchCoordinator`, `StopCoordinator` and `Reconciler` separate persistence, process effects and observation. File-worker requests have validated, versioned envelopes, bounded queues and deadlines. A main-process event bus persists bounded replay history. Environment profiles, session metadata and disabled-by-default hook definitions have validated records.

**Repairs in this version:**

- Active writes are serialized and included in flush/close. Failures reach callers and shutdown; older writes cannot overtake newer ones.
- State and events become visible after successful persistence. Normal saves use file and directory sync, with no fixed 50 ms debounce delay.
- Invalid/future-schema state has a durable byte-for-byte recovery copy before an empty workspace becomes writable. Startup recovery notices no longer depend on a one-shot load event.
- Terminal input is acknowledged and byte-bounded; queue failures are surfaced and remaining chunks cancel on disposal. xterm handles bracketed paste once. Output acknowledgements use UTF-8 bytes, so large Unicode output resumes correctly. Disposed frame callbacks are cancelled.
- Shutdown drains accepted requests, active launch work and persistence. Failures are distinct from successful shutdown. tmux processes survive GUI closure.
- Closing during page load drains work before Chromium window teardown, with no blocking startup-error dialog. Repeated quit requests cannot bypass the drain. Restart tests await renderer readiness and application cleanup.
- Polling can recover an unreaped tmux child exit using verified server ownership, preserving actual exit status and native notifications.
- Tests now verify multiline command results, large Unicode output, immediate post-acknowledgement force-kill recovery, preserved backups and deterministic persistence races. The existing resize test sends a real Enter and distinguishes output from echoed input.

**Verification (2026-09-13):** 73 backend tests, all 89 desktop tests, typechecking, production build, packaging and packaged-runtime smoke pass. The desktop runner exits cleanly. Tests use isolated temporary profiles and private sockets. Commands, timings and the scope of each check are recorded in [verification](verification.md).

The microbenchmark uses 36 simulated terminals. It measures state persistence, snapshot construction and event persistence, not real terminal startup or end-to-end UI latency. In this environment, repaired state mutation measured 11.14 ms p95 (review baseline 56.70 ms), durable single-event publication measured 12.42 ms p95 and simulated concurrent snapshots measured 2.15 ms p95. The original 128-terminal / first-prompt / warm-switch targets are not certified by this benchmark.

**Remaining scope:** one global visible terminal attachment; no registry or split panes; no full versioned Electron IPC manifest/handshake; no prompt detector; no hook execution, memory panels, notification center, command palette or settings/profile management UI. Some settings fields reserve future behavior, including attachment caching and file watching. `App.tsx` remains large. Packaging still copies into the release directory, so stage/atomic publication remains planned; the current package smoke verifies the resulting runtime only. No AI orchestration, marketplace, scheduling, native Windows/macOS runtime or database is implemented.

New ordinary feature tabs can use focused React components and the service facade. Multiple simultaneous terminal panes need attachment ownership and resize/input policy first. Keep this distinction when planning future work.

See [architecture](architecture.md), [recovery](recovery.md), [verification](verification.md), [security boundaries](../SECURITY.md) and [changelog](../CHANGELOG.md).
