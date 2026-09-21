# Runbooks

Step-by-step recovery procedures for the supported prefix of MINIMAL
1.2.3. Each runbook is a self-contained recipe; the index below lists
them by the failure mode they cover.

## Recovery

- [Recovery — interrupted install](recovery-interrupted-install.md)
  The staged-pointer design means a half-published release is
  recoverable. Walks through `npm run package:rollback` and what it
  changes; documents the safety guarantee.
- [Recovery — corrupted DB](recovery-corrupted-db.md)
  How to recognise and recover from a corrupted `state.json` or DB.
  References [`src/runtime/db/backup.ts`](../../src/runtime/db/backup.ts).
- [Recovery — failed migration](recovery-failed-migration.md)
  When `validateImportedStore` or `activateStore` reports an issue,
  the steps to keep your data intact while opening the profile with a
  compatible binary.

## Verification

- [Verify release integrity](verify-release-integrity.md)
  Walks through `npm run verify:release` and what each line of output
  means.

## See also

- [`docs/recovery.md`](../recovery.md) — top-level persistence +
  filesystem caveats.
- [`docs/update-rollback.md`](../update-rollback.md) — when an in-place
  rollback to a previous release is safe (and when it is not).
- [`src/runtime/db/backup.ts`](../../src/runtime/db/backup.ts) — the
  backup / restore / verify primitives that the corrupted-DB runbook
  quotes.
- [`scripts/release.mts`](../../scripts/release.mts) — the rollback +
  integrity primitives the install / integrity runbooks quote.
