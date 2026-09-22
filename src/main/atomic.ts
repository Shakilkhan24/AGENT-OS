import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * strong (default) syncs the data and parent directory; async-strong skips
 * directory sync; crash skips both. We rely on the filesystem honoring fsync.
 * Without directory sync, power-loss durability of the rename is not promised.
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
      // Persist the directory entry as well as the file contents.
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
