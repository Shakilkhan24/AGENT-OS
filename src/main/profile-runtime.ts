import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export function profilePaths(directory: string, uid = process.getuid!()) {
  const key = createHash("sha256").update(directory).digest("hex").slice(0, 20);
  const parent = `/tmp/minimal-${uid}`;
  return { key, parent, socket: `${parent}/${key}.sock`, lock: `${parent}/${key}.lock`,
    runtime: `${parent}/${key}`, config: path.join(directory, "tmux.conf") };
}

export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077))
    throw new Error("The private tmux directory has unsafe ownership or permissions");
}

/** Refuse symlinks, hard links and shared configuration before writing engine commands. */
export async function privateConfig(file: string, content: string) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077))
      throw new Error("The private tmux configuration has unsafe ownership or permissions");
    await handle.truncate(0);
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * Create the per-profile OS lock file before spawning the runtime.
 * The desktop holds the inode so `helpers/runtime_lock.py` can `flock` it without
 * racing another launcher. The validation matches the helper's checks exactly:
 * regular file, single link, current uid, mode 0600 (no group/other bits).
 * Re-creating an existing lock file is allowed only when the previous instance is
 * gone (the helper's `LOCK_NB` catches an in-flight owner); we do not unlink here.
 */
export async function createPrivateLockFile(file: string) {
  const handle = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077))
      throw new Error("The runtime lock has unsafe ownership, links or permissions");
  } finally { await handle.close(); }
}
