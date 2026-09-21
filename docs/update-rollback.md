# Update + rollback

MINIMAL ships a **staged pointer** design. A release directory lives
under `release/builds/minimal-linux-<arch>-<version>-<uuid>/`, and
two symlinks point at it:

- `release/current-linux-<arch>` — the directory the desktop
  launches from. The topbar's **Stop runtime** runs against this
  tree.
- `release/previous-linux-<arch>` — the directory that was current
  *before* the most recent successful publish.

The pointer moves happen at the end of [`publishRelease`](scripts/release.mts);
the staged tree is `fsync`-d before any pointer move, so a crash
mid-publish leaves the running release untouched.

## Update (in-place)

```bash
npm run package
```

The publisher runs five checkpoints in order:

1. `staged` — assembled under `release/builds/.staging-<id>/`.
2. `verified` — `tests/package-smoke.ts` launched against the
   staged binary; exits 0 ⇒ pass.
3. `retained` — staging renamed to its canonical name; integrity
   manifest written (`MANIFEST.sha256`).
4. `previous-updated` — `previous-linux-<arch>` repointed to the
   directory that *was* current.
5. `published` — `current-linux-<arch>` repointed to the new
   directory.

If any checkpoint throws, the `current` symlink is never touched.
See the [interrupted-install runbook](runbooks/recovery-interrupted-install.md).

## Rollback (swap to previous)

```bash
npm run package:rollback
```

This calls [`scripts/release.mts:rollbackRelease`](scripts/release.mts),
which:

1. Reads the `previous-linux-<arch>` symlink target.
2. Throws `"No previous verified release is available"` if the
   symlink is missing or dangling.
3. Atomically repoints `current-linux-<arch>` to the previous
   directory. The `previous` symlink is **not** changed.

Application data under `/tmp/minimal-<uid>/` is never touched.

## When rollback is safe

Rollback is safe when:

- The previously-current directory's state schema is still readable
  by the running binary.
- No migration step ran *between* the rollback target and `current`
  that wrote a new schema. The locator (`<profile>/active.json`)
  refuses a downgrade past a schema bump.

## When rollback is **not** safe

- You have a profile that was opened with a newer-schema binary
  between publishes. The `active.json` will be on the new schema;
  rolling back to an older binary that doesn't understand the new
  schema refuses to start.
- The `previous-linux-<arch>` symlink is dangling or missing. This
  happens on a fresh install (no prior publish) and on a manual
  `release/` cleanup. The error message is intentional; do not
  force-rollback by symlinking the current tree to itself.
- The integrity manifest in either the current or the previous tree
  reports a mismatch. Run `npm run verify:release -- <tree>` first;
  if it returns non-zero, do not switch to a corrupted tree. See the
  [verify-release-integrity runbook](runbooks/verify-release-integrity.md).

## What this document is **not**

- An atomic-rollback claim. Rollback changes the symlink; it does
  not snapshot the data directory. Always run `npm run package` to
  verify the new tree before declaring an upgrade done.
- A multi-arch rollback guide. The pointer design supports one
  architecture per install; cross-arch rollback (e.g. `x86_64` →
  `aarch64`) is out of scope for the supported prefix.
