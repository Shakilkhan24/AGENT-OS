# MINIMAL 1.2.3 — release qualification cut

This release closes the M9.2 qualification bullet from
[`FUTURE/IMPLEMENTATION-README.md`](../FUTURE/IMPLEMENTATION-README.md).
It is a documentation + integrity-manifest cut; the supported prefix
of user-facing features is unchanged from 1.2.2.

## Supported prefix (advertised workflows)

The following user-facing workflows are exercised by automated tests
and may be relied on:

- Project sessions with persistent terminals across GUI closure.
- Custom commands and reusable presets; batch launch of 1–32 terminals.
- Up to 128 terminals per session; add, rename, close and reconnect
  individual terminals; remembered selection and explorer visibility.
- Scoped file navigation and editing with reviewed save conflicts.
- Recoverable editor drafts.
- Paged virtual directory lists; image and binary previews.
- Persistent tmux work that survives GUI closure.
- Visible exit and failure state.
- SQLite-backed runtime database with import + validate + activate.
- Backup / restore with sealed `manifest.json` (`takeBackup`,
  `verifyBackup`, `beginRestore` / `endRestore`).
- Workflow runs with content-addressed step outputs.
- Schedules (daily rules), seeded and fired by the `Scheduler`.
- Owned-remote host registry with fingerprint pinning and SSH probe.

The connected-workflow gate
[`tests/runtime/m9-gate.test.ts`](../tests/runtime/m9-gate.test.ts)
walks nine end-to-end sub-bullets in a single test and asserts
evidence at each gate. Prior gate tests remain:

- [`tests/runtime/m6-gate.test.ts`](../tests/runtime/m6-gate.test.ts)
  — recipes, run/pause/recover/cancel, restricted fixture.
- [`tests/runtime/m7-gate.test.ts`](../tests/runtime/m7-gate.test.ts)
  — schedules, capability probe, host-off behaviour, artifact pin.

## Unsupported prefix (explicitly out of scope)

The following are **not** part of the 1.2.3 advertised surface; do not
treat absence of a failure as endorsement:

- One global visible terminal attachment; registry of attachments;
  split panes.
- Full versioned Electron IPC manifest / handshake.
- Prompt detector; memory panels; notification center; command palette;
  settings / profile management UI.
- AI orchestration, marketplace, scheduling beyond the daily rule,
  native Windows / macOS runtime.
- Independent-build equivalence: integrity is attested only within a
  single build run. See [verify-release-integrity](runbooks/verify-release-integrity.md).
- Cryptographic signing of the release tarball (planned follow-up).
- aarch64 Linux packaging; macOS / Windows-native packaging.

## What changed since 1.2.2

- **M9.0** connected-workflow complete-scope rehearsal
  ([`tests/runtime/m9-gate.test.ts`](../tests/runtime/m9-gate.test.ts)).
- **M9.1** regression sweep across the full current suite.
- **M9.2** aggregated release documentation:
  - Release notes (this file).
  - [Dependencies](dependencies.md).
  - [Licenses](licenses.md).
  - [Compatibility](compatibility.md).
  - [Update rollback](../update-rollback.md).
  - [Recovery runbooks](runbooks/index.md).
- **M9.2** single-source version export
  ([`src/shared/version.ts`](../src/shared/version.ts)) and SHA-256
  integrity manifest emitted at the `retained` release phase
  ([`scripts/release.mts:writeIntegrityManifest`](../scripts/release.mts)).

## Known follow-ups

- Tarball-of-the-staged-tree + `.sha256` sidecar (currently the manifest
  lives inside the staged tree; a single-file tarball digest is a
  follow-up).
- Out-of-band signing of the release artifact.
- Independent rebuild comparison (would require a second build host;
  not claimed).

## Verification

```bash
npx tsc --noEmit
npx tsx --test tests/release/release-checksum.test.ts
npx tsx --test tests/runtime/m9-gate.test.ts \
  tests/runtime/m6-gate.test.ts \
  tests/runtime/m7-gate.test.ts
```

Final acceptance: typecheck clean; release-checksum red on tamper;
prior gates green.
