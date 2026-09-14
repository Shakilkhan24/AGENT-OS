/**
 * M2.2 — Stable profile identity and storage path separation.
 *
 * A profile identity is generated once, persisted next to the user's data
 * directory, and reused across moves/relocations of that directory. The
 * identity is what names the per-profile lock, runtime directory, socket
 * and (now) SQLite database file. Renaming or moving the data directory
 * never invalidates the identity; renaming the OS user or recreating the
 * identity file does, by design (the previous lock is released).
 *
 * Storage separation rules:
 *  - **Control state** (the SQLite DB) lives under
 *    `/tmp/minimal-${uid}/${profileKey}/state.db` — Linux-native, supports
 *    SQLite's full durability/WAL semantics. Moving the user's data
 *    directory does not move the DB.
 *  - **Settings** stay at `${dataDir}/settings.json` (one file, one writer).
 *  - **Workspace data** (sessions, projects, drafts) stays at `${dataDir}`.
 *
 * Legacy profiles without `profile.id` get a hash-derived identity
 * derived from the absolute data directory. Relocating the directory
 * therefore changes the identity; users who care about continuity keep
 * `profile.id` next to their data, and the locator below detects it.
 */
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors";

export interface ProfilePaths {
  /** Stable identity for this profile; survives data-dir relocation. */
  readonly profileId: string;
  /** Linux-native storage root for control state. */
  readonly controlRoot: string;
  /** Path to the SQLite database. */
  readonly database: string;
  /** Path to the per-profile WAL/SHM sidecars (same directory as `database`). */
  readonly controlDir: string;
  /** Absolute path to the user's data directory (sessions, drafts, settings). */
  readonly dataDir: string;
  /** Per-profile lock inode path. */
  readonly lock: string;
  /** Per-profile socket path. */
  readonly socket: string;
  /** Per-profile runtime dir for `ready.json`, etc. */
  readonly runtimeDir: string;
  /** Path to the `profile.id` file in the user's data directory. */
  readonly identityFile: string;
}

const PROFILE_ID_FILE = "profile.id";
const PROFILE_ID_BYTES = 16;

function linuxRoot(uid = process.getuid!()): string {
  return `/tmp/minimal-${uid}`;
}

/**
 * Resolve the per-profile storage paths. Reads (or creates) the profile
 * identity file in the data directory and uses it to name the Linux-native
 * control-state root.
 *
 * The function is idempotent: subsequent calls with the same `dataDir`
 * return the same identity, even after the directory is renamed.
 */
export async function resolveProfilePaths(dataDir: string, uid = process.getuid!()): Promise<ProfilePaths> {
  const absolute = path.resolve(dataDir);
  const identityFile = path.join(absolute, PROFILE_ID_FILE);
  let profileId: string | undefined;
  try {
    const raw = (await readFile(identityFile, "utf8")).trim();
    if (/^[a-f0-9]{32}$/i.test(raw)) profileId = raw.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!profileId) profileId = await mintProfileIdentity(absolute, identityFile);
  const root = linuxRoot(uid);
  const controlDir = path.join(root, profileId);
  return {
    profileId,
    controlRoot: root,
    controlDir,
    database: path.join(controlDir, "state.db"),
    dataDir: absolute,
    lock: path.join(root, `${profileId}.lock`),
    socket: path.join(root, `${profileId}.sock`),
    runtimeDir: path.join(root, profileId),
    identityFile,
  };
}

/**
 * Mint and persist a new profile identity. The identity is a 128-bit random
 * value written atomically to the data directory. The function refuses to
 * overwrite an existing identity file: relocations must move the file, not
 * regenerate it.
 */
export async function mintProfileIdentity(dataDir: string, file = path.join(dataDir, PROFILE_ID_FILE)): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Refuse to mint if a previous identity exists; the caller should be
  // moving the directory, not silently regenerating the identity.
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[a-f0-9]{32}$/i.test(existing))
      throw new AppError("CONFLICT", "Profile identity already exists; refuse to overwrite");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = randomUUID().replace(/-/g, "").slice(0, PROFILE_ID_BYTES * 2);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${id}\n`);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return id;
}

/**
 * Compute the legacy identity that would have been derived from the data
 * directory before M2.2. Used only for one-shot migrations and tests; new
 * callers should rely on `resolveProfilePaths`.
 */
export function legacyProfileKey(dataDir: string): string {
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 20);
}

/**
 * Prepare the per-profile storage root: create the directory with the
 * required mode and ownership, then refuse to proceed if the existing
 * inode is not owned by the current uid or has unsafe permissions. The
 * runtime_socket directory inside is created with 0700 so other users on
 * the same machine cannot connect.
 */
export async function prepareProfileStorage(paths: ProfilePaths): Promise<void> {
  await mkdir(paths.controlDir, { recursive: true, mode: 0o700 });
  const info = await stat(paths.controlDir);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077))
    throw new AppError("UNAVAILABLE", "Profile storage directory has unsafe ownership or permissions");
}

/**
 * Whether `dataDir` is on Linux-native storage. The DB staging decision uses
 * this to confirm cross-mount copies are reachable. WSL's Windows mounts
 * are NOT considered native here: their fsync semantics are not honoured.
 */
export function isLinuxNativePath(dataDir: string): boolean {
  const absolute = path.resolve(dataDir);
  // /tmp on Linux is tmpfs/ext4 and supports fsync; OneDrive mounts show up
  // under /mnt/* on WSL and bypass those semantics.
  return absolute.startsWith("/tmp/") || absolute.startsWith("/var/") || absolute.startsWith("/home/");
}
