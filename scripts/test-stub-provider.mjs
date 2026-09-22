#!/usr/bin/env node
/**
 * In-repo adapter stub for `framed-runner.test.ts`.
 *
 * The runner spawns this script as a subprocess; the runner wraps its
 * stdout in a `FrameDecoder` and its stdin in a `BudgetedWriter`. The
 * stub's job is to:
 *
 *  - accept framed JSON envelopes on stdout (`started`, `output`,
 *    `exit`),
 *  - read framed JSON requests from stdin,
 *  - reply with one `output` frame per request,
 *  - on EOF, emit `exit` and exit 0.
 *
 * The stub uses newline-delimited JSON frames with a 4-byte big-endian
 * length prefix (matching `runtime/framing.ts`).
 */
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buffer = Buffer.alloc(0);

function emit(frame) {
  const json = JSON.stringify(frame);
  const len = Buffer.byteLength(json);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(len);
  process.stdout.write(Buffer.concat([header, Buffer.from(json)]));
}

function parseFrames(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE();
    if (length > 4 * 1024 * 1024) {
      process.stderr.write("frame too large");
      process.exit(2);
    }
    if (buffer.length < 4 + length) return;
    const json = decoder.write(buffer.subarray(4, 4 + length));
    buffer = buffer.subarray(4 + length);
    const req = JSON.parse(json);
    handle(req);
  }
}

let seq = 0;
function handle(req) {
  if (req && req.kind === "input") {
    seq += 1;
    emit({ kind: "output", bytes: req.bytes || 0, seq });
  }
}

// Defer `started` so the runner's caller has time to attach its
// lifecycle listener (EventEmitter drops events that arrive before
// subscription).
setImmediate(() => emit({ kind: "started", at: new Date().toISOString() }));

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  // The runner may emit line-delimited envelopes; parse them.
  try {
    const value = JSON.parse(line);
    handle(value);
  } catch {
    // Not a JSON line — treat as raw bytes sent to input.
    handle({ kind: "input", bytes: Buffer.byteLength(line) });
  }
});
rl.on("close", () => {
  emit({ kind: "exit", at: new Date().toISOString(), code: 0, signal: null });
  process.exit(0);
});
process.on("SIGTERM", () => {
  emit({ kind: "exit", at: new Date().toISOString(), code: null, signal: "SIGTERM" });
  process.exit(143);
});
