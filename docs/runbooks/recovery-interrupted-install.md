# Recovery — interrupted install

If `npm run package` is interrupted (Ctrl+C, machine reboot, lost
connection, `flock` failure) the staged release tree under
`release/builds/.staging-<release-id>` is left in place. The
`current-linux-x64` symlink is **not** moved until the `published`
checkpoint, which is the last step of [`publishRelease`](../../scripts/release.mts).
So your running MINIMAL install is unaffected; only the staged half
was discarded.

## Symptoms

- `npm run package` exits non-zero.
- `release/builds/.staging-*` directory exists but the matching
  `minimal-linux-<arch>-<version>-<uuid>` directory does not.
- `release/current-linux-<arch>` still points at the prior release.

## Recovery

1. **Do not run MINIMAL from the staging directory.** It is not a
   published release; its lock-inode contract does not apply and the
   integrity manifest has not been written.
2. **Remove the stale staging directory.** The next run of
   `npm run package` will refuse to start if the lock is still held:
   ```bash
   rm -rf release/builds/.staging-*
   ```
   This is safe; `.staging-` is the documented prefix that
   `scripts/package.mjs` uses, and any leftover tree was never
   repointed.
3. **Re-run the package step.**
   ```bash
   npm run package
   ```
   The publisher starts from a clean staging directory, runs the
   documented checkpoints (`staged → verified → retained →
   previous-updated → published`), and only then moves the
   `current-linux-<arch>` symlink.

## If you have already published and want to roll back

See [`docs/update-rollback.md`](../update-rollback.md). The summary:

```bash
npm run package:rollback
```

This swaps the `current-linux-<arch>` symlink back to the directory
the `previous-updated` checkpoint recorded. Application data under
`/tmp/minimal-<uid>/` is never touched.

## What this runbook is **not**

- A way to "fix" a half-published release. The pointer is
  deliberately only moved at the very end; there is no intermediate
  state that can be resumed.
- A way to recover a corrupted filesystem. If your `release/` tree is
  itself corrupt (missing files, bad symlinks, etc.), start from a
  fresh `npm run package` after `rm -rf release/`.
