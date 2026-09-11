import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Durability levels for an atomic write. Higher levels cost more `fsync`
 * syscalls; pick the lowest level your caller can tolerate.
 *
 * - `"strong"`: fsync the data file **and** the parent directory. Recovers
 *   correctly after a power loss at any point in the write. This is the
 *   default for backwards compatibility.
 * - `"async-strong"`: fsync the data file only. The `rename(2)` is still
 *   atomic, so a power loss leaves either the old or the new file in place
 *   but never a torn write. Recommended for the hot save path: the old
 *   file is a strictly older version of the same logical document, so
 *   recovering to it is always safe.
 * - `"crash"`: write-then-rename with no fsync. Survives a clean process
 *   crash but **not** a power loss. Use only for cache-style state where
 *   the next launch can recompute.
 */
export type Durability = "strong" | "async-strong" | "crash";

/**
 * Atomically write `value` as JSON to `file`. Callers serialize changes to
 * the same logical document via an outer mutex; this function only handles
 * the byte-level rename.
 *
 * Returns once the rename has been issued and (when requested) the relevant
 * `fsync`s have completed. Pending writes are not observed by readers until
 * the rename happens, which is the point at which the file's contents swap.
 */
export async function atomicJson(
  file: string,
  value: unknown,
  options: { durability?: Durability } = {},
): Promise<void> {
  const durability = options.durability ?? "strong";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      if (durability !== "crash") await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    if (durability === "strong") {
      // fsync the parent directory so the rename is durable. This costs an
      // extra syscall on every save and is unnecessary for documents that
      // are version-on-version (the previous version is still safe to load).
      const directory = await open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
