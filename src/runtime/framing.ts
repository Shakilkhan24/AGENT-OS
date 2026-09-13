import { AppError } from "../shared/errors";
import { MAX_FRAME_BYTES } from "../shared/protocol";

const decoder = new TextDecoder("utf-8", { fatal: true });
/** One length prefix and one bounded body; fragmented peers cannot accumulate buffer arrays. */
export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  private failed = false;
  private completedFrames = 0;
  constructor(private receive: (value: unknown) => void, private limit = () => MAX_FRAME_BYTES) {}
  get partial() { return this.headerBytes !== 0 || this.body !== undefined; }
  get completed() { return this.completedFrames; }
  push(chunk: Buffer) {
    if (this.failed) throw new AppError("INVALID_REQUEST", "Protocol decoder is closed");
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count; offset += count;
          if (this.headerBytes < 4) continue;
          const length = this.header.readUInt32BE();
          if (!length || length > this.limit()) throw new AppError("INVALID_REQUEST", "Protocol frame length exceeds the limit");
          this.body = Buffer.allocUnsafe(length); this.bodyBytes = 0;
        }
        const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + count);
        this.bodyBytes += count; offset += count;
        if (this.bodyBytes === this.body.length) {
          const value: unknown = JSON.parse(decoder.decode(this.body));
          this.headerBytes = 0; this.body = undefined; this.bodyBytes = 0;
          this.completedFrames++;
          this.receive(value);
        }
      }
    } catch (error) {
      this.failed = true; this.body = undefined;
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_REQUEST", "Protocol frame is not valid UTF-8 JSON");
    }
  }
  end() {
    const partial = this.headerBytes !== 0 || this.body !== undefined;
    this.failed = true; this.body = undefined;
    if (partial) throw new AppError("INVALID_REQUEST", "Protocol stream ended inside a frame");
  }
}

export function encodeFrame(value: unknown, limit = MAX_FRAME_BYTES): Buffer {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { /* Reject non-JSON data below. */ }
  if (json === undefined) throw new AppError("INVALID_REQUEST", "Protocol frame must be JSON serializable");
  const length = Buffer.byteLength(json);
  if (!length || length > limit) throw new AppError("INVALID_REQUEST", "Protocol frame length exceeds the limit");
  const frame = Buffer.allocUnsafe(length + 4);
  frame.writeUInt32BE(length); frame.write(json, 4, "utf8");
  return frame;
}
