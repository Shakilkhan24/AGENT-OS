#!/usr/bin/env node
/**
 * In-repo Codex adapter stub for `codex-framed-runner.test.ts`.
 *
 * The M4.1 second-provider stub mirrors `test-stub-provider.mjs` (the
 * M3b.3 Claude stub) but emits codex-flavoured startup metadata. The
 * wire shape is identical — length-prefixed JSON envelopes
 * (`{kind: "started" | "output" | "exit", …}`) — but the startup
 * envelope records `metadata.scheme = "codex"` and
 * `metadata.bidirectionalInput = false` to make the non-claim
 * explicit. The runner test asserts that the `startup` payload
 * distinguishes the two providers so future audit code cannot
 * silently treat them as symmetric.
 *
 * Behavioural difference from the Claude stub:
 *  - Startup metadata records `scheme: "codex"` and
 *    `bidirectionalInput: false`. (The Claude stub does not emit any
 *    `metadata` field at all — M4.1 makes the asymmetry observable.)
 *  - Otherwise the wire shape is identical: line-delimited JSON
 *    envelopes on stdin (the framed runner's `encodeFrame` writes
 *    such envelopes), `output` frames per `input` frame, clean exit
 *    on EOF, `SIGTERM` triggers `exit` then process exit 143.
 */
import { createInterface } from "node:readline";

function emit(frame) {
  const json = JSON.stringify(frame);
  const len = Buffer.byteLength(json);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(len);
  process.stdout.write(Buffer.concat([header, Buffer.from(json)]));
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
// subscription). `setImmediate` matches `test-stub-provider.mjs`.
setImmediate(() =>
  emit({
    kind: "started",
    at: new Date().toISOString(),
    metadata: {
      scheme: "codex",
      bidirectionalInput: false,
    },
  }),
);

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
