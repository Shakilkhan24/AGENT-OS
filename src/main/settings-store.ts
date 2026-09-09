import { readFile } from "node:fs/promises";
import path from "node:path";
import { settingsSchema, type Settings } from "../shared/settings";
import { atomicJson } from "./atomic";
import { Mutex } from "./mutex";

export class SettingsStore {
  private mutex = new Mutex();
  readonly file: string;
  constructor(directory: string) {
    this.file = path.join(directory, "settings.json");
  }
  async load(): Promise<Settings> {
    try {
      return settingsSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const defaults = settingsSchema.parse({});
      await this.save(defaults);
      return defaults;
    }
  }
  save(value: unknown): Promise<Settings> {
    return this.mutex.run(async () => {
      const settings = settingsSchema.parse(value);
      await atomicJson(this.file, settings);
      return settings;
    });
  }
}
