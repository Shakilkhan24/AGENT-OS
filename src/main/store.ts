import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { State } from "../shared/types";
export const nameSchema = z.string().trim().min(1).max(80);
export const presetSchema = z.object({
  id: z.string().uuid(),
  name: nameSchema,
  command: z
    .string()
    .max(8192)
    .refine((s) => !s.includes("\0")),
});
const terminalSchema = z.object({
  id: z.string().uuid(),
  label: nameSchema,
  cwd: z.string(),
  command: z.string(),
  createdAt: z.string(),
  deleting: z.boolean().optional(),
  launchError: z.string().optional(),
});
const stateSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema).max(100),
  sessions: z.array(
    z.object({
      id: z.string().uuid(),
      name: nameSchema,
      directory: z.string(),
      identity: z.string(),
      createdAt: z.string(),
      deleting: z.boolean().optional(),
      terminals: z.array(terminalSchema),
    }),
  ),
});
export class Store {
  constructor(readonly directory: string) {}
  async load(): Promise<State> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      return stateSchema.parse(
        JSON.parse(
          await readFile(path.join(this.directory, "state.json"), "utf8"),
        ),
      );
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new Error(
          `Cannot read saved state. Your file has been preserved: ${error.message}`,
        );
      return {
        version: 1,
        sessions: [],
        presets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Shell",
            command: "",
          },
        ],
      };
    }
  }
  async save(state: State): Promise<void> {
    const destination = path.join(this.directory, "state.json");
    const temporary = `${destination}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(stateSchema.parse(state), null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
