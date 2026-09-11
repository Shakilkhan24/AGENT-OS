import { mkdir, readFile, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { State } from "../shared/types";
import { legacyStateSchema, stateSchema } from "../shared/models";
import { atomicJson, type Durability } from "./atomic";
import { Debouncer } from "./debouncer";
export { nameSchema, presetSchema } from "../shared/models";

/** Empty default for a fresh install or for recovery from unreadable state. */
function emptyState(): State {
  return {
    version: 2,
    sessions: [],
    envProfiles: [],
    hooks: [],
    launches: [],
    presets: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Shell",
        command: "",
      },
    ],
  };
}

/**
 * Persistence facade for the workspace document.
 *
 * Writes are coalesced through a trailing-edge debouncer so a burst of
 * `update()` calls only pays one `fsync`. The most recent state is
 * always the one that lands on disk; intermediate revisions are skipped.
 *
 * Crash safety:
 *  - `save()` returns when the debouncer **accepts** the write, not when
 *    it's on disk. A clean process exit calls `flush()` which drains the
 *    pending write before the event loop quits.
 *  - A power loss within the debounce window can lose the latest mutation,
 *    which is consistent with how desktop apps conventionally treat typing
 *    in flight.
 */
export class Store {
  private readonly file: string;
  private readonly writes: Debouncer<State>;
  /**
   * Populated by `load()` when the on-disk state.json was unreadable. The
   * original file is preserved on disk; callers can read this string after
   * `load()` to surface the recovery to the user. `undefined` on a clean
   * load.
   */
  recoveredFromInvalid?: string;
  constructor(readonly directory: string, options: { debounceMs?: number; durability?: Durability } = {}) {
    this.file = path.join(this.directory, "state.json");
    const durability = options.durability ?? "async-strong";
    this.writes = new Debouncer<State>(
      (latest) => atomicJson(this.file, latest, { durability }),
      options.debounceMs ?? 50,
    );
  }
  async load(): Promise<State> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let original: string;
    try {
      original = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyState();
    }
    try {
      const raw: unknown = JSON.parse(original);
      const version = z.object({ version: z.number() }).parse(raw).version;
      if (version === 1) {
        const legacy = legacyStateSchema.parse(raw);
        const next = stateSchema.parse({
          ...legacy,
          version: 2,
          envProfiles: [],
          hooks: [],
          launches: [],
        });
        const digest = createHash("sha256")
          .update(original)
          .digest("hex")
          .slice(0, 16);
        const backup = path.join(
          this.directory,
          `state.v1-${digest}.backup.json`,
        );
        try {
          const handle = await open(backup, "wx", 0o600);
          try {
            await handle.writeFile(original);
            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if ((await readFile(backup, "utf8")) !== original)
            throw new Error(
              "Migration backup contents differ; state preserved",
            );
        }
        // Migration is a one-shot, must survive a crash mid-way: bypass the
        // debouncer and use the strongest durability.
        await atomicJson(this.file, next, { durability: "strong" });
        return next;
      }
      return stateSchema.parse(raw);
    } catch (error) {
      // The on-disk file is preserved by construction: we read it once
      // above and never wrote anything before this point. Continue with
      // the empty default so the renderer can open a window. Callers can
      // inspect `recoveredFromInvalid` to surface the reason to the user.
      // This used to throw and trigger `dialog.showErrorBox`, which
      // blocks indefinitely on a headless system (no display server).
      this.recoveredFromInvalid =
        `Saved state could not be read; original file preserved. ` +
        (error instanceof Error ? error.message : String(error));
      return emptyState();
    }
  }
  /** Coalesce `state` into the next write window. Resolves on accept. */
  save(state: State): Promise<void> {
    return this.writes.schedule(stateSchema.parse(state));
  }
  /** Block until the in-flight write (if any) lands on disk. */
  flush(): Promise<void> { return this.writes.flush(); }
  /** Flush and disarm. Use on shutdown to avoid losing pending writes. */
  close(): Promise<void> { return this.writes.close(); }
}
