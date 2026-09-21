import { lstat, mkdir, open, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

type Phase = "staged" | "verified" | "retained" | "previous-updated" | "published";
export interface ReleaseOptions {
  root: string;
  arch: string;
  version: string;
  assemble(directory: string): Promise<void>;
  smoke(executable: string): Promise<void>;
  checkpoint?(phase: Phase): Promise<void>;
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Sync files and directory entries before publishing a durable pointer to them. */
async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(file);
    else if (entry.isFile()) {
      const handle = await open(file, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  await syncDirectory(directory);
}

async function pointer(root: string, name: string): Promise<string | undefined> {
  try {
    const target = await readlink(path.join(root, name));
    if (path.dirname(target) !== "builds" || path.basename(target).startsWith("."))
      throw new Error(`Unrecognized release pointer: ${name}`);
    if (!(await lstat(path.join(root, target))).isDirectory()) throw new Error(`Missing release: ${name}`);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling link is an error, not an empty publication slot.
      try { await lstat(path.join(root, name)); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw missing;
      }
    }
    throw error;
  }
}

async function replacePointer(root: string, name: string, target: string) {
  const temporary = path.join(root, `.${name}-${randomUUID()}`);
  try {
    await symlink(target, temporary);
    await rename(temporary, path.join(root, name));
    await syncDirectory(root);
  } finally { await rm(temporary, { force: true }); }
}

/** Caller holds the build lock. Published build directories are never modified or pruned. */
export async function publishRelease(options: ReleaseOptions) {
  const { root, arch, version, assemble, smoke } = options;
  if (arch.trim() !== arch || version.trim() !== version) throw new Error("Invalid release architecture or semantic version");
  if (!/^[a-z0-9_]+$/.test(arch) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(version))
    throw new Error("Invalid release architecture or semantic version");
  const current = `current-linux-${arch}`, previous = `previous-linux-${arch}`;
  await mkdir(path.join(root, "builds"), { recursive: true });
  await syncDirectory(root);
  const old = await pointer(root, current);
  await pointer(root, previous); // Refuse unexpected entries before doing any work.
  const releaseId = `minimal-linux-${arch}-${version}-${randomUUID()}`;
  const staging = path.join(root, "builds", `.staging-${releaseId}`);
  const target = path.join("builds", releaseId);
  await mkdir(staging);
  try {
    await assemble(staging);
    await writeFile(path.join(staging, "release.json"), JSON.stringify({
      formatVersion: 1, releaseId, version, arch, createdAt: new Date().toISOString(),
    }, null, 2) + "\n");
    await syncTree(staging);
    await options.checkpoint?.("staged");
    await smoke(path.join(staging, "minimal"));
    await options.checkpoint?.("verified");
    await rename(staging, path.join(root, target));
    await syncDirectory(path.join(root, "builds"));
    // M9.2: write the SHA-256 integrity manifest before any pointer moves,
    // so the manifest is durable alongside the retained tree. The manifest
    // is excluded from itself, so a later re-run is idempotent.
    await writeIntegrityManifest(path.join(root, target));
    await syncDirectory(path.join(root, target));
    await options.checkpoint?.("retained");
    if (old) await replacePointer(root, previous, old);
    await options.checkpoint?.("previous-updated");
    await replacePointer(root, current, target);
    await options.checkpoint?.("published");
    return path.join(root, current, "minimal");
  } finally {
    // Once renamed, the build may be referenced even if directory fsync failed.
    // Never remove it or roll back a possibly published pointer on an error.
    await rm(staging, { recursive: true, force: true });
  }
}

/** CLI holds the same build lock; rollback changes the pointer, never application data. */
export async function rollbackRelease(root: string, arch: string) {
  if (arch.trim() !== arch || !/^[a-z0-9_]+$/.test(arch)) throw new Error("Invalid architecture");
  const target = await pointer(root, `previous-linux-${arch}`);
  if (!target) throw new Error("No previous verified release is available");
  await replacePointer(root, `current-linux-${arch}`, target);
  return path.join(root, `current-linux-${arch}`, "minimal");
}

/**
 * Walk every regular file under `root` and write a sorted
 * `MANIFEST.sha256` of `<sha256>  <relative-path>` lines.
 * Excludes any prior `MANIFEST.sha256` itself so re-running the
 * writer on a manifest-bearing tree is idempotent.
 *
 * Returns the manifest path. The caller is responsible for
 * `fsync`-ing the file before any `current-linux-` symlink move.
 */
export async function writeIntegrityManifest(root: string): Promise<string> {
  const lines: string[] = [];
  await collectLines(root, root, lines);
  lines.sort((a, b) => (a.split("  ", 2)[1]! < b.split("  ", 2)[1]! ? -1 : 1));
  const manifestPath = path.join(root, "MANIFEST.sha256");
  const payload = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const handle = await open(manifestPath, "wx", 0o644);
  try { await handle.writeFile(payload); await handle.sync(); }
  finally { await handle.close(); }
  return manifestPath;
}

async function collectLines(
  currentDir: string,
  rootDir: string,
  out: string[],
): Promise<void> {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".package.lock") continue;
      await collectLines(abs, rootDir, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "MANIFEST.sha256") continue;
    const rel = path.relative(rootDir, abs);
    const digest = await sha256OfFile(abs);
    out.push(`${digest}  ${rel}`);
  }
}

async function sha256OfFile(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/**
 * Verify the manifest against the current bytes of the tree.
 * Returns the first mismatch (or `undefined` on success).
 * Designed to be exercised by `scripts/verify-release.mts`.
 */
export async function verifyIntegrityManifest(root: string): Promise<
  | { ok: true; fileCount: number }
  | { ok: false; reason: "MANIFEST_MISSING" | "ENTRY_MISSING" | "DIGEST_MISMATCH"; detail: string }
> {
  const manifestPath = path.join(root, "MANIFEST.sha256");
  let raw: string;
  try {
    const handle = await open(manifestPath, "r");
    try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, reason: "MANIFEST_MISSING", detail: manifestPath };
    throw error;
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let fileCount = 0;
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) {
      return { ok: false, reason: "MANIFEST_MISSING", detail: `Malformed manifest line: ${line}` };
    }
    const [, expected, rel] = match as unknown as [string, string, string];
    const abs = path.join(root, rel);
    try { await lstat(abs); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ok: false, reason: "ENTRY_MISSING", detail: rel };
      throw error;
    }
    const actual = await sha256OfFile(abs);
    if (actual !== expected)
      return { ok: false, reason: "DIGEST_MISMATCH", detail: `${rel} expected=${expected} actual=${actual}` };
    fileCount += 1;
  }
  return { ok: true, fileCount };
}
