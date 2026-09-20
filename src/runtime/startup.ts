import { fstatSync } from "node:fs";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { privateDirectory, profilePaths } from "../main/profile-runtime";

/** Only the flock owner may open storage or remove endpoints left by a crash. */
export async function prepareRuntimeStartup(dataDir: string, runtimeDir: string, socket: string): Promise<void> {
  await privateDirectory(path.dirname(socket));
  await privateDirectory(runtimeDir);
  const rawFd = process.env.MINIMAL_LOCK_FD;
  if (!rawFd || !/^[0-9]+$/.test(rawFd) || Number(rawFd) < 3)
    throw new Error("Runtime must start through the OS lock helper");
  const fd = Number(rawFd);
  const held = fstatSync(fd);
  const lockPath = path.join(path.dirname(socket), `${profilePaths(dataDir).key}.lock`);
  const expected = await lstat(lockPath);
  const locks = await readFile(`/proc/self/fdinfo/${fd}`, "utf8");
  if (!held.isFile() || held.nlink !== 1 || held.uid !== process.getuid!() || (held.mode & 0o077)
      || !expected.isFile() || held.dev !== expected.dev || held.ino !== expected.ino
      || !new RegExp(`\\bFLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s`).test(locks))
    throw new Error("Runtime does not hold the exclusive profile lock");
  // The kernel released the old owner's flock before granting ours. A stale
  // socket may be unlinked now; never do this from a competing GUI launcher.
  await removeStale(socket, "socket");
  await removeStale(path.join(runtimeDir, "ready.json"), "file");
}

async function removeStale(file: string, kind: "socket" | "file") {
  try {
    const info = await lstat(file);
    if (info.uid !== process.getuid!() || (kind === "socket" ? !info.isSocket() : !info.isFile()))
      throw new Error(`Refusing unexpected runtime endpoint: ${file}`);
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
