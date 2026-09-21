# Recovery — corrupted DB / state

If startup reports a `state-recovered` notice, your data is **not
lost**. The runtime writes a private, content-addressed
`state.recovery-<digest>.backup.json` containing the exact original
bytes of the malformed `state.json` before any new writes are
admitted.

This runbook covers the cases where the notice surfaces, the cases
where it does not, and the deeper fallback path via
[`src/runtime/db/backup.ts`](../../src/runtime/db/backup.ts).

## Symptoms

- A typed `state-recovered` notice appears at startup.
- The window opens with an empty workspace.
- A `.json.recovery-<digest>.backup` file exists under your profile
  directory (typically `~/.config/MINIMAL` or `$MINIMAL_DATA_DIR`).

## Recovery steps

1. **Stop the runtime.** Closing the window does **not** stop the
   runtime (see [`docs/recovery.md`](../recovery.md) — M1 separation).
   Use the **Stop runtime** button in the topbar, or
   `kill <pid-of-minimal-runtime>` if the topbar is unreachable.
2. **Preserve the backup copy.** Do not delete
   `state.recovery-<digest>.backup.json`. It is the only durable
   byte-for-byte copy of the malformed state.
3. **Decide which direction to take.**

   **A. Trust the empty workspace and move on.** The recovery notice
   means the empty workspace is writable. New edits replace
   `state.json` (atomically) and the recovery copy is left intact as
   a forensic record. This is the right choice if your state was
   small and you are happy starting fresh.

   **B. Restore the prior state into a copy, then validate it.**
   ```bash
   cp state.json state.work.json
   cp state.recovery-<digest>.backup.json state.json
   ```
   Then re-launch MINIMAL with the same profile. If startup
   succeeds, your prior state is restored and the recovery copy
   becomes the forensic record of the byte that triggered the
   recovery in the first place. If startup still reports
   `state-recovered`, the original `state.json` was malformed at the
   schema level; proceed to **C**.

   **C. Validate the recovery bytes against the published schema.**
   Open `state.recovery-<digest>.backup.json` against the schemas in
   [`src/shared/models.ts`](../../src/shared/models.ts). If the
   schema is too new for the running binary, you need a newer
   MINIMAL release; the recovery copy is preserved across upgrades.

## The M2.7 backup primitive (deeper fallback)

The runtime ships a sealed backup primitive that captures the DB
state + every referenced artifact with a per-file SHA-256 digest:
[`takeBackup`](../../src/runtime/db/backup.ts). The runtime also
exposes a [`verifyBackup`](../../src/runtime/db/backup.ts) that
re-reads every byte and reports the first mismatch.

If you have a prior backup directory, the restore path is bracketed
by [`beginRestore`](../../src/runtime/db/backup.ts) /
[`endRestore`](../../src/runtime/db/backup.ts) tokens so no
command can be dispatched while restore is in progress.

```
takeBackup({ worker, outputDir, schemaVersion })
  → manifest.json (state digest + per-artifact digests)
  → artifacts/<id>.bin

verifyBackup(outputDir)
  → { ok: true, fileCount: N } | { ok: false, reason, detail }

beginRestore(worker) → token
  … apply the manifest …
endRestore(worker, token)
```

## What this runbook is **not**

- A way to recover a profile whose state file was deleted
  intentionally. The recovery copy only exists if the runtime
  detected a malformed file before deleting it.
- A way to migrate an unsupported schema forward. The recovery copy
  preserves the original bytes; a newer binary is needed to read
  them.
