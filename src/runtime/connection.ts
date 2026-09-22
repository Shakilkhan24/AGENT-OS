import type { Duplex } from "node:stream";
import { AppError } from "../shared/errors";
import { MAX_FRAME_BYTES } from "../shared/protocol";
import { FrameDecoder, encodeFrame } from "./framing";

/** Bounded socket buffering; no unbounded JS queues and no transparent message retry. */
export class FrameConnection {
  private decoder: FrameDecoder;
  private partialTimer?: ReturnType<typeof setTimeout>;
  private failure?: Error;
  constructor(readonly socket: Duplex, receive: (value: unknown) => void,
    closed: (error: Error) => void, private limit = () => MAX_FRAME_BYTES,
    private partialMs = 5000, private queueBytes = MAX_FRAME_BYTES + 65536) {
    this.decoder = new FrameDecoder(receive, limit);
    socket.on("data", chunk => {
      try {
        const completed = this.decoder.completed;
        this.decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        if (!this.decoder.partial || completed !== this.decoder.completed) {
          clearTimeout(this.partialTimer); this.partialTimer = undefined;
        }
        if (this.decoder.partial && !this.partialTimer) this.partialTimer = setTimeout(() => {
          this.destroy(new AppError("TIMEOUT", "Incomplete runtime frame timed out"));
        }, this.partialMs);
      } catch (error) { this.destroy(error as Error); }
    });
    socket.on("end", () => {
      try { this.decoder.end(); } catch (error) { this.failure = error as Error; }
    });
    socket.on("error", error => { this.failure ??= error; });
    socket.once("close", () => {
      clearTimeout(this.partialTimer);
      closed(this.failure ?? new AppError("UNAVAILABLE", "Runtime connection closed", { outcomeUnknown: true }));
    });
  }
  send(value: unknown) {
    if (this.socket.destroyed || this.socket.writableEnded) throw new AppError("UNAVAILABLE", "Runtime connection is closed");
    const frame = encodeFrame(value, this.limit());
    if (this.socket.writableLength + frame.length > this.queueBytes) {
      const error = new AppError("BUSY", "Runtime peer is not consuming output", { outcomeUnknown: true });
      this.destroy(error); throw error;
    }
    this.socket.write(frame);
  }
  destroy(error?: Error) { this.failure ??= error; this.socket.destroy(); }
}
