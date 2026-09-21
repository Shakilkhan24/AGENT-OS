# Verify release integrity

Every release tree at `release/minimal-linux-<arch>/` ships with a
`MANIFEST.sha256` file — one `sha256  <relative-path>` line per
file, sorted by path, written at the `retained` phase of
[`publishRelease`](../../scripts/release.mts). The manifest is
excluded from itself and from the `.package.lock` flock file the
release tooling holds.

## How to verify

```bash
npm run verify:release -- release/minimal-linux-x64
```

Output on a clean tree:

```
verified <N> file(s) under release/minimal-linux-x64
```

Exit code `0`.

Output on a tampered file:

```
integrity check failed: DIGEST_MISMATCH
  path/to/file expected=<expected-sha256> actual=<actual-sha256>
```

Exit code `1`.

Output on a missing file:

```
integrity check failed: ENTRY_MISSING
  path/to/file
```

Exit code `1`.

Output on a missing manifest:

```
integrity check failed: MANIFEST_MISSING
  release/minimal-linux-x64/MANIFEST.sha256
```

Exit code `1`.

## What the verifier proves

- Every byte of every file in the tree is byte-identical to the
  bytes that were present when the manifest was written.
- No file has been added or removed since the manifest was written.
- The manifest itself is well-formed.

## What the verifier does **not** prove

- That the manifest itself is authentic. A malicious party could
  replace both the tree and the manifest. Cryptographic signing of
  the manifest (GPG, sigstore, cosign) is a planned follow-up — see
  [`docs/release-notes-1.2.3.md`](../release-notes-1.2.3.md)'s
  "Known follow-ups".
- That the bytes are reproducible from a second build. M9.2
  explicitly **does not** make a reproducible-build claim.
- That the application is bug-free. The manifest attests to the
  tree's integrity, not its correctness.

## Programmatic use

```ts
import { verifyIntegrityManifest } from "../scripts/release.mts";
const result = await verifyIntegrityManifest("release/minimal-linux-x64");
if (result.ok) {
  console.log(`verified ${result.fileCount} files`);
} else {
  console.error(`${result.reason}: ${result.detail}`);
}
```

The verifier returns:

- `{ ok: true, fileCount: N }` — clean.
- `{ ok: false, reason: "MANIFEST_MISSING" | "ENTRY_MISSING" |
   "DIGEST_MISMATCH", detail: string }` — first failure with the
  exact offending path and digests.

## See also

- [`scripts/release.mts`](../../scripts/release.mts) — the
  `writeIntegrityManifest` and `verifyIntegrityManifest` exports.
- [`scripts/verify-release.mts`](../../scripts/verify-release.mts) —
  the CLI wrapper.
- [`tests/release/release-checksum.test.ts`](../../tests/release/release-checksum.test.ts)
  — round-trip + tamper-detection test coverage.
