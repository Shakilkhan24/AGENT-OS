import { lstat, mkdir, open, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
