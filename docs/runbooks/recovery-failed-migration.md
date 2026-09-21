# Recovery — failed migration

If a legacy import (`importLegacyState`), validate
(`validateImportedStore`), or activate (`activateStore`) step fails,
the source `state.json`, `events.json`, `settings.json`, and the
drafts directory are **not** modified. The destination DB may carry
partial rows from the failed transaction; the publisher treats the
transaction as all-or-nothing.

This runbook covers the three concrete failure surfaces and the
recovery path for each.

## Symptoms

- `importLegacyState` reports a typed error from
  [`src/runtime/db/import.ts`](../../src/runtime/db/import.ts).
- `validateImportedStore` returns issues with
  `foreignKeys / uniqueness / contentReferences / counts`.
- `activateStore` refuses with `"activateStore refused: validation
  failed inside the transaction"`.

## Recovery

1. **Do not delete the source files.** `importLegacyState` does not
   touch them; they are the only durable copy of the legacy state.
2. **Read the typed error.** Each of the three surfaces uses an
   `AppError` with a stable `failure.code`:
   - `INVALID_REQUEST` — schema-level mismatch in the source files.
   - `CONFLICT` — a foreign-key or uniqueness violation; the manifest
     reports which tables/columns.
   - `NOT_FOUND` — a referenced row was missing; the manifest names
     the target.
   - `UNAVAILABLE` — the active store could not be loaded; activation
     is required first.
3. **Pick the path below based on the `failure.code`.**

   **`INVALID_REQUEST`** — open the malformed source file against
   the schemas in [`src/shared/models.ts`](../../src/shared/models.ts)
   and repair a copy. Do **not** overwrite the original until you
   have validated the patched copy.

   **`CONFLICT` / `NOT_FOUND`** — the legacy state references rows
   that are missing in the destination. This usually means a prior
   partial import succeeded against a different profile; verify the
   `MINIMAL_DATA_DIR` you are running against and re-run.

   **`UNAVAILABLE`** — open the profile with a compatible MINIMAL
   binary. The control store locator
   (`<profile>/active.json`) refuses newer schemas (a deliberate
   refusal-capable compatibility) and an empty profile refuses any
   state write.

4. **Re-run the import.** Once the failure is addressed,
   `npm start` (or `npm run start:built` for a packaged build) will
   re-attempt the migration automatically.

## What this runbook is **not**

- A way to recover data lost before the M2.7 backup primitive. Older
  1.x binaries used a different store layout; opening that profile
  with 1.2.x may surface a `state-recovered` notice (see the
  [corrupted-DB runbook](recovery-corrupted-db.md)).
- A way to migrate across an unsupported schema upgrade. The locator
  refuses newer schemas and an empty workspace is the only writable
  state.
