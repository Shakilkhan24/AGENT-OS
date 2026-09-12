const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

/** One acknowledged chunk at a time; cancellation never redirects queued input. */
export class TerminalInputQueue {
  private tail = Promise.resolve();
  private queued = 0;
  private cancelled = false;
  constructor(private send: (text: string) => Promise<void>, private budget = 2 * 1024 * 1024) {}
  enqueue(text: string): Promise<void> {
    if (this.cancelled) return Promise.reject(new Error("Terminal input was cancelled"));
    const bytes = utf8Bytes(text);
    if (this.queued + bytes > this.budget)
      return Promise.reject(new Error("Paste is too large or input is busy. Wait, then paste a smaller selection."));
    this.queued += bytes;
    const task = this.tail.then(async () => {
      for (let offset = 0; offset < text.length;) {
        if (this.cancelled) throw new Error("Terminal input was cancelled");
        let end = Math.min(offset + 16384, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        await this.send(text.slice(offset, end));
        offset = end;
      }
    }).finally(() => { this.queued -= bytes; });
    // A failed delivery must not poison subsequent input or replay the failed chunk.
    this.tail = task.catch(() => {});
    return task;
  }
  cancel() { this.cancelled = true; }
}
