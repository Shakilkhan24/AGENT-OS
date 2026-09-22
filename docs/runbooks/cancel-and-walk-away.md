# Cancel-and-walk-away — portability drill

> **Status (M9.6):** operator runbook. The portability commitment
> that the
> [commercial-decision record](../commercial-decision.md)
> §5 pins in writing, made concrete as a step-by-step drill. This
> runbook assumes the operator has decided to walk away from this
> MINIMAL installation entirely. It does **not** describe a partial
> uninstall; it describes a full export → verify → diagnostics →
> restore onto a clean supported machine.
>
> If the operator is restoring to the same machine, see
> [`docs/runbooks/recovery-corrupted-db.md`](recovery-corrupted-db.md)
> and [`docs/recovery.md`](../recovery.md) instead.

## 1. Scope

This runbook exists to make the M9.6 portability commitment
operational. It walks the four phases of an export-and-rehome
exercise:

1. **Backup.** Take a sealed snapshot of the current installation's
   state and artifacts.
2. **Verify.** Re-read every byte of the snapshot and refuse any
   digest or length mismatch.
3. **Diagnostics.** Walk the operational logs through the allowlist
   + canary scrubber and emit a clean bundle + audit report.
4. **Restore.** Apply the snapshot onto a clean supported machine
   using the restore-mode tokens that disable dispatch for the
   duration.

The drill is end-to-end on a clean supported machine: it deliberately
does not assume the source and target are the same machine. The
target machine does not need to share an account, host, or provider
relationship with the source machine. What transfers is what the
runtime itself exports. §6 names what does **not** transfer.

## 2. Backup

The runtime's primary export primitive is
[`takeBackup`](../../src/runtime/db/backup.ts) in
`src/runtime/db/backup.ts:166`. The function:

- Refuses to clobber an existing manifest in the destination
  directory (line 169-176).
- Walks every row of `session, terminal, preset, env_profile, hook,
  launch, event, draft, meta` (line 114-119) and serialises to
  `state.rows.json` with the schema version stamped on the front.
- Pins every draft, preset, env_profile, and hook as a separate
  artifact under `artifacts/<kind>-<sha256>.json`. The artifact
  filename carries the SHA-256 of the JSON bytes so the file is
  content-addressed (line 130-145).
- Writes a manifest with per-row counts, per-artifact digests, a
  state digest, the schema version, and a per-export nonce
  (line 234-254).
- Writes every output file with mode `0o600` (or `0o700` for the
  artifact directory). The output directory is created with
  `0o700` (line 168, 178).

**What the backup deliberately omits** (line 114-119 lists only the
nine internal tables; nothing outside that list is touched):

- Provider profiles (Codex / Claude account state).
- OAuth tokens, API keys, credentials.
- Provider-owned hidden state (conversations, cached inference,
  per-account rate-limit counters).

§6 below restates this boundary verbatim.

**CLI seam.** If the desktop UI is reachable, use its
**Export workspace** affordance. If it is not, the primitive is
directly available as
`takeBackup({ worker, outputDir, schemaVersion })` from the runtime's
own exports — see `src/runtime/db/backup.ts:165-166` for the
signature. There is **no `npm run backup` script** by design: backup
is a runtime-internal primitive, not a workspace command.

**Step.**

1. Stop dispatch (close any in-flight launches; cancel batch
   launches between items per `docs/recovery.md`).
2. Pick an empty destination directory. The export refuses to write
   into a non-empty directory.
3. Invoke the primitive. Confirm `manifest.json` was written and
   that `artifacts/` contains one file per draft, preset, env
   profile, and hook.
4. `chmod` the destination to `0o700` if you intend to keep it on
   disk; the runtime sets this for you when it creates the
   directory, but a manual copy may not preserve the mode.

## 3. Verify

`verifyBackup` (`src/runtime/db/backup.ts:263-287`) re-reads every
file in the backup directory and confirms the manifest's digests
are still valid. The function returns one of three failure reasons:

| Reason | When |
| --- | --- |
| `MISSING_FILE` | The manifest is missing, the state file is missing, or one of the pinned artifacts is missing. |
| `DIGEST_MISMATCH` | The state file's SHA-256 differs from the manifest, an artifact's SHA-256 differs from the manifest, or an artifact's byte-length differs from the manifest. |
| `MANIFEST_INVALID` | `manifest.json` could not be parsed as JSON, or it failed `backupManifestSchema.parse(...)`. |

A clean verification returns `{ ok: true, manifest, fileCount: N }`.

**Step.**

1. Run `verifyBackup` against the backup directory immediately
   after `takeBackup`. Do not skip this step — disk corruption,
   partial copies, and write-time truncation are all possible.
2. If verification returns `ok: true`, copy the backup directory
   off the source machine using a transport you trust (rsync over
   SSH, encrypted archive, etc.). The backup is self-contained and
   does not require any external reference to be useful.
3. If verification returns `ok: false`, do **not** trust the
   snapshot. The backup primitive is atomic at the manifest level
   (it writes the manifest last), so a verified mismatch usually
   indicates the destination storage is lossy or the manifest was
   tampered with after the fact. Re-take the backup from the source.

## 4. Diagnostics

The diagnostics export is separate from the backup. The backup is
state; the diagnostics export is the operational-log scrubber. They
serve different purposes and have different threat models.

**Command.**

```bash
npm run diagnostics:export <data-dir> \
  --out <out-dir> \
  --canary reviewer-marker=MINIMAL-CANARY-9aa31be9
```

`<data-dir>` is the profile root (typically `~/.config/MINIMAL` or
the path in `$MINIMAL_DATA_DIR`). The script (`scripts/diagnostics-export.mts`)
walks `<data-dir>/logs/` and `<data-dir>/logs/runtime/`, parses each
NDJSON record, and runs the 22-key allowlist scrubber from
[`src/release/diagnostic-scrubber.ts`](../../src/release/diagnostic-scrubber.ts)
over every record. The default reviewer canary is hard-coded at
`MINIMAL-CANARY-9aa31be9` (`scripts/diagnostics-export.mts:70`).

**Exit codes.**

| Code | Meaning |
| --- | --- |
| `0` | Clean: every canary token was scrubbed; at least one record was processed. |
| `1` | At least one canary token was NOT scrubbed. The bundle is unsafe to share; the reviewer must inspect. |
| `2` | No records were found under `<data-dir>/logs/`. |

The script never claims "all secrets removed". It claims "all canary
tokens removed", with a count. Free-form text in the `message`
field is not scrubbed by this layer — see `docs/diagnostics.md` for
the disclosure of the scrubber's limit.

**Outputs.**

- `<out-dir>/diagnostics-<timestamp>.ndjson` — one line per record,
  containing both the scrubbed record and the per-record
  `redactionCount` / `canaryMatches` report.
- `<out-dir>/scrub-report.json` — aggregate audit surface
  (total records, total redactions, per-class counts, list of
  failed canaries).

**Step.**

1. Run the export with the default canary. The bundle is safe to
   share only if the exit code is `0`.
2. Add `--canary name=token` for any additional token you suspect
   the scrubber might have missed. The canary mechanism is the
   authoritative check: if your canary survives, the scrubber
   refused to scrub the bundle itself.
3. Inspect the `scrub-report.json`. The four `perClassCounts`
   buckets (`operational`, `pending-decision`, `live-intent`,
   `recoverable-candidate`) come from
   `classifySourceForRetention()` — the M9.4 retention floor. The
   aggregate does not invent records; if any class is unexpectedly
   zero, the source log directory may have been corrupted.

## 5. Restore

The restore path is bracketed by
[`beginRestore`](../../src/runtime/db/backup.ts) / `endRestore`
tokens (`src/runtime/db/backup.ts:318-344`) so no command can be
dispatched while restore is in progress. Re-entering restore mode
without `endRestore` raises `CONFLICT`.

The restore itself is `restoreFromBackup` (`src/runtime/db/backup.ts:380`).
It:

1. Confirms restore mode is active and the supplied token matches
   `meta.restore_mode_token` (line 385-389).
2. Calls `verifyBackup` again on the input directory before mutating
   anything. A tampered manifest, missing file, or digest mismatch
   raises `CONFLICT` and the live state is **not** swapped
   (line 391-394).
3. Inside a single transaction, clears the eight replaceable tables
   (`session`, `terminal`, `preset`, `env_profile`, `hook`,
   `launch`, `event`, `draft`), then re-inserts every row in
   declaration order — parents first so the foreign-key from
   `session_id` / `session_uuid` resolves cleanly on reinsert.
4. Re-checks the restore-mode token inside the transaction so a
   concurrent `beginRestore` cannot race (line 404-408).
5. Rolls back to the original state if any step fails.

The target machine **must** be running a binary whose `stateSchema`
is at least the schema version stamped on the backup. A newer
schema than the binary can read will fail the same
`schema-too-new` startup refusal described in `docs/recovery.md`;
the backup is preserved across upgrades.

**Step.**

1. Install MINIMAL on the target machine using the supported
   install path (Linux-only per `scripts/package.mjs`; see
   [`docs/distribution.md`](../distribution.md) §3).
2. Launch once so the profile directory is created. Then close the
   window and stop the runtime via the topbar button or
   `kill <pid-of-minimal-runtime>`. Do **not** use SIGKILL — the
   graceful shutdown handler drains the IPC queue.
3. Copy the backup directory from §2 into the profile directory
   (or anywhere on disk; the restore primitive accepts any
   directory).
4. From the runtime's own IPC seam, call `beginRestore(worker)` to
   receive a token. Pass that token to `restoreFromBackup` with
   the backup directory. On success, call `endRestore(worker,
   token)`; on failure, the transaction rolls back and dispatch
   remains disabled until you call `endRestore` anyway.
5. Re-launch. The restored sessions, terminals, presets, env
   profiles, hooks, events, and drafts should all be visible.

## 6. What does NOT transfer

The M9.6 portability commitment is honest about its limits. The
following do **not** transfer, by design:

- **Provider accounts.** Codex, Claude, or any other provider
  account is owned by the user, not by MINIMAL. The runtime does
  not store account credentials; it consults the user's existing
  provider authentication at the OS layer (browser session, keyring,
  env var) per the provider adapter. Walking away from MINIMAL does
  not affect the provider relationship; starting fresh on a new
  machine requires the user to authenticate again at the provider.
- **Provider-owned hidden state.** Conversations, cached inference,
  per-account rate-limit counters, and any other state the
  provider keeps server-side stays with the provider. MINIMAL has
  no read or write access to it. The user keeps access to that
  state through the provider's own UI, not through MINIMAL.
- **Credentials.** OAuth tokens, API keys, and any secret material
  are excluded from both the backup and the diagnostics export.
  The 22-key allowlist in
  [`src/release/diagnostic-scrubber.ts`](../../src/release/diagnostic-scrubber.ts)
  redacts them; the backup never reads them.
- **Anything outside the 22-key allowlist.** The backup records
  what's in the nine internal tables (line 114-119); the
  diagnostics export redacts everything outside the 22-key
  allowlist. Both surfaces are deliberately narrow.
- **Provider binaries and SDKs.** The release artifact bundles
  Chromium per `release/current-linux-x64/LICENSES.chromium.html`;
  provider binaries and SDKs are loaded at runtime, not bundled.
  Walking away from this MINIMAL install does not affect the
  provider's own installation on the user's machine.

Research doc 12 line 82 makes this boundary explicit:

> Keep project files, already-created results, essential recovery,
> and export accessible after cancellation. Export readable
> task/recipe manifests, handoffs, artifact references, review
> evidence, and schema versions; exclude credentials. Document what
> cannot transfer, including provider-owned hidden state.
> Demonstrate import on a clean supported machine and continued
> access if MINIMAL's service disappears.

This runbook is the demonstration that research doc 12 line 82
asks for: a clean-machine restore from a real backup, with the
"does NOT transfer" boundary stated verbatim.

## 7. Freshness rule

Every release bump re-validates this runbook. The regression test
at `tests/release/cancel-walkaway.test.ts` asserts:

1. This runbook exists and walks the four phases (backup, verify,
   diagnostics, restore) in order.
2. `src/runtime/db/backup.ts` still exports `takeBackup`,
   `verifyBackup`, `beginRestore`, `endRestore`, and
   `restoreFromBackup` — guards against future removal of the
   portability primitives.
3. `scripts/diagnostics-export.mts` still exists and still walks
   `<data-dir>/logs/` and `<data-dir>/logs/runtime/` — guards
   against future removal of the diagnostics seam.
4. `docs/recovery.md` still exists — guards against dangling
   cross-references to the recovery contract.

A future commit that changes the backup schema, the diagnostics
scrubber's allowlist, or the restore transaction MUST update this
runbook and the cited code. The test failure is the signal.

## See also

- [`docs/commercial-decision.md`](../commercial-decision.md) — the
  explicit no-commercialization record (the portability commitment
  this runbook implements).
- [`docs/distribution.md`](../distribution.md) — distribution
  surface + update-mechanism statement.
- [`docs/security.md`](../security.md) — local-only principal model.
- [`docs/provider-economics.md`](../provider-economics.md) —
  separation commitment.
- [`docs/runbooks/recovery-corrupted-db.md`](recovery-corrupted-db.md) —
  same-machine recovery drill.
- [`docs/recovery.md`](../recovery.md) — recovery contract.
- [`docs/diagnostics.md`](../diagnostics.md) — scrubber limit
  disclosure.
- [`src/runtime/db/backup.ts`](../../src/runtime/db/backup.ts) —
  backup / verify / restore primitives.
- [`src/release/diagnostic-scrubber.ts`](../../src/release/diagnostic-scrubber.ts) —
  22-key allowlist scrubber.
- [`scripts/diagnostics-export.mts`](../../scripts/diagnostics-export.mts) —
  diagnostics CLI seam.
- [`FUTURE/docs/research/12-commercial-positioning.md`](../../FUTURE/docs/research/12-commercial-positioning.md)
  — research doc 12 line 82 (portability commitment, quoted
  verbatim in §6 above).
