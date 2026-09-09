import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { draftInputSchema, draftSchema, type DraftInput, type Draft, type DraftSummary } from "../shared/drafts";
import { hashSchema } from "../shared/files";
import { AppError } from "../shared/errors";
import { atomicJson } from "./atomic";
import { Mutex } from "./mutex";

export class DraftStore {
  readonly directory: string;
  private mutex = new Mutex();
  constructor(profile: string, private limit = 50) { this.directory = path.join(profile, "drafts"); }
  private file(id: string) { return path.join(this.directory, `${hashSchema.parse(id)}.json`); }
  async read(id: string): Promise<Draft> {
    const draft = draftSchema.parse(JSON.parse(await readFile(this.file(id), "utf8")));
    if (draft.id !== id) throw new AppError("IO_ERROR", "Draft identity mismatch; draft preserved");
    return draft;
  }
  async list(): Promise<DraftSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await opendir(this.directory), drafts: DraftSummary[] = [];
    let count = 0;
    for await (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      if (++count > 100) throw new AppError("BUSY", "Draft recovery directory exceeds its limit; existing drafts were preserved");
      const { content: _content, ...summary } = await this.read(entry.name.slice(0, -5));
      drafts.push(summary);
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save(input: DraftInput): Promise<DraftSummary> {
    input = draftInputSchema.parse(input);
    if (Buffer.byteLength(input.content) > 2 * 1024 * 1024) throw new AppError("INVALID_REQUEST", "Draft exceeds 2 MiB");
    return this.mutex.run(async () => {
      const id = createHash("sha256").update(`${input.sessionId}\0${input.path}`).digest("hex");
      const drafts = await this.list();
      if (!drafts.some(draft => draft.id === id) && drafts.length >= this.limit) throw new AppError("BUSY", "Draft storage is full. Restore or discard an older draft first");
      const draft = { ...input, id, updatedAt: new Date().toISOString() };
      await atomicJson(this.file(id), draft);
      const { content: _content, ...summary } = draft;
      return summary;
    });
  }
  remove(id: string) {
    return this.mutex.run(async () => {
      await unlink(this.file(id)).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
  }
}
