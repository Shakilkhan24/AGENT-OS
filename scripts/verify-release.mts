#!/usr/bin/env node
/**
 * M9.2 — verify the SHA-256 integrity manifest of a published release tree.
 *
 * Usage:
 *   npx tsx scripts/verify-release.mts <release-dir>
 *
 * Walks every entry in `<release-dir>/MANIFEST.sha256`, recomputes the
 * SHA-256 of the file on disk, and reports the first mismatch. Exits
 * 0 on clean verification, 1 on any mismatch or missing manifest.
 *
 * The manifest is written by `scripts/release.mts:writeIntegrityManifest`
 * at the `retained` checkpoint of `publishRelease`.
 *
 * This script does **not** verify a cryptographic signature; the
 * release artifact is currently unsigned (see
 * `docs/release-notes-1.2.3.md`'s "Known follow-ups").
 */
import { verifyIntegrityManifest } from "./release.mts";

const args = process.argv.slice(2);
if (args.length !== 1) {
  process.stderr.write("Usage: verify-release.mts <release-dir>\n");
  process.exit(2);
}
const [root] = args;

try {
  const result = await verifyIntegrityManifest(root);
  if (result.ok) {
    process.stdout.write(`verified ${result.fileCount} file(s) under ${root}\n`);
    process.exit(0);
  }
  process.stderr.write(`integrity check failed: ${result.reason}\n  ${result.detail}\n`);
  process.exit(1);
} catch (error) {
  process.stderr.write(`verify-release: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
}
