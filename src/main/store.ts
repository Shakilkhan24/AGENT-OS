import { mkdir, readFile, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { State } from "../shared/types";
import { legacyStateSchema, stateSchema } from "../shared/models";
import { atomicJson } from "./atomic";
export { nameSchema, presetSchema } from "../shared/models";

export class Store {
  constructor(readonly directory: string) {}
  async load(): Promise<State> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "state.json");
    let original: string;
    try {
      original = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
        await this.save(next);
        return next;
      }
      return stateSchema.parse(raw);
    } catch (error) {
      throw new Error(
        `Cannot read saved state. Your file has been preserved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async save(state: State) {
    await atomicJson(
      path.join(this.directory, "state.json"),
      stateSchema.parse(state),
    );
  }
}
