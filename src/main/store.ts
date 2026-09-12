import { mkdir, readFile, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { State } from "../shared/types";
import { legacyStateSchema, stateSchema } from "../shared/models";
import { atomicJson, type Durability } from "./atomic";
import { Debouncer } from "./debouncer";
export { nameSchema, presetSchema } from "../shared/models";

function emptyState(): State {
  return { version: 2, sessions: [], envProfiles: [], hooks: [], launches: [],
    presets: [{ id: "00000000-0000-4000-8000-000000000001", name: "Shell", command: "" }] };
}

/** Writes are serialized and acknowledged after persistence. */
export class Store {
  private readonly file: string;
  private readonly writes: Debouncer<State>;
  recoveredFromInvalid?: string;
  constructor(readonly directory: string, options: { debounceMs?: number; durability?: Durability } = {}) {
    this.file = path.join(directory, "state.json");
    this.writes = new Debouncer<State>(
      latest => atomicJson(this.file, latest, { durability: options.durability ?? "strong" }),
      options.debounceMs ?? 0,
    );
  }
  /** Preserve exact bytes before migration/recovery, including invalid UTF-8. */
  private async backup(original: Buffer, kind: string) {
    const digest = createHash("sha256").update(original).digest("hex");
    const backup = path.join(this.directory, `state.${kind}-${digest}.backup.json`);
    try {
      const handle = await open(backup, "wx", 0o600);
      try { await handle.writeFile(original); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(backup)).equals(original))
        throw new Error("State backup contents differ; original state preserved");
    }
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return backup;
  }
  async load(): Promise<State> {
    this.recoveredFromInvalid = undefined;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let original: Buffer;
    try { original = await readFile(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyState();
    }
    let next: State;
    let migrate = false;
    try {
      const raw = JSON.parse(original.toString("utf8"));
      migrate = raw?.version === 1;
      next = migrate ? stateSchema.parse({ ...legacyStateSchema.parse(raw), version: 2,
        envProfiles: [], hooks: [], launches: [] }) : stateSchema.parse(raw);
    } catch {
      // Backup failure is fatal: never enable writes over an unprotected original.
      const backup = await this.backup(original, "recovery");
      this.recoveredFromInvalid = `Saved state could not be read; original file preserved. Recovery copy: ${backup}. Opened an empty workspace; saved commands were not replayed.`;
      return emptyState();
    }
    if (migrate) {
      await this.backup(original, "v1");
      // I/O failures here must not be mistaken for corrupt user data.
      await atomicJson(this.file, next);
    }
    return next;
  }
  save(state: State): Promise<void> { return this.writes.schedule(stateSchema.parse(state)); }
  flush(): Promise<void> { return this.writes.flush(); }
  close(): Promise<void> { return this.writes.close(); }
}
