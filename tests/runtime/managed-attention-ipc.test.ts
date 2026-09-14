/**
 * M3c.3 — `transition-attention` / `snooze-attention` / `preview-artifact`
 * IPC dispatcher tests.
 *
 * Coverage:
 *  1. `transition-attention` calls `transitionAttention` and surfaces the
 *     updated view as `ok=true` with the new state.
 *  2. `snooze-attention` widens a `new` row's FSM in a single call (the
 *     row leaves as `snoozed` with the requested `snoozedUntil`).
 *  3. `preview-artifact` returns the bounded base64 preview when an
 *     approved grant covers the digest + kind.
 *  4. `preview-artifact` surfaces a `FORBIDDEN` failure when no grant
 *     matches; the dispatcher converts to a CONFLICT-style response so
 *     the renderer can show the reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { API_VERSION, type Request } from "../../src/shared/protocol";
import { ProtocolDispatcher } from "../../src/main/protocol-dispatcher";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { raiseAttention, transitionAttention, snoozeAttention } from "../../src/runtime/db/attention-items";
import { pinArtifact, previewArtifact } from "../../src/runtime/db/artifact-references";
import { requestGrant, decideGrant } from "../../src/runtime/db/grants";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function requestFor(method: string, args: unknown[]): Request {
  return {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: method as Request["method"],
    deadlineAt: Date.now() + 60_000,
    args,
  };
}

/** Mirror of `RuntimeWorkspace`'s three M3c.3 handler shapes. */
function dispatcherFor(worker: DbWorker): ProtocolDispatcher {
  const dispatcher = new ProtocolDispatcher();
  dispatcher.register("transition-attention", async ([id, to]) => {
    try {
      const item = await transitionAttention(worker, id, to);
      return {
        id: item.id, taskId: item.taskId, kind: item.kind,
        issueIdentity: item.issueIdentity, revision: item.revision,
        state: item.state, payloadJson: item.payloadJson,
        snoozedUntil: item.snoozedUntil,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
      };
    } catch (error) {
      if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
      throw error;
    }
  });
  dispatcher.register("snooze-attention", async ([id, until]) => {
    try {
      const item = await snoozeAttention(worker, { id, until: new Date(until) });
      return {
        id: item.id, taskId: item.taskId, kind: item.kind,
        issueIdentity: item.issueIdentity, revision: item.revision,
        state: item.state, payloadJson: item.payloadJson,
        snoozedUntil: item.snoozedUntil,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
      };
    } catch (error) {
      if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
      throw error;
    }
  });
  dispatcher.register("preview-artifact", async ([id, principal, scopeJson]) => {
    try {
      const preview = await previewArtifact(worker, { id, principal, scopeJson });
      return {
        id: preview.id, sha256: preview.sha256, mime: preview.mime,
        bytes: preview.bytes, truncated: preview.truncated,
        truncatedBase64Content: preview.truncatedBase64Content,
      };
    } catch (error) {
      if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
      throw error;
    }
  });
  return dispatcher;
}

function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

test("IPC transition-attention returns the updated item view", async () => {
  const worker = freshWorker();
  try {
    const item = await raiseAttention(worker, { kind: "decision", issueIdentity: "i1", revision: 0 });
    const dispatcher = dispatcherFor(worker);
    try {
      const response = await dispatcher.dispatch("transition-attention",
        requestFor("transition-attention", [item.id, "seen"]));
      assert.equal(response.ok, true);
      if (!response.ok) throw new Error("expected ok");
      const result = response.result as { state: string; id: string };
      assert.equal(result.state, "seen");
      assert.equal(result.id, item.id);
    } finally { await dispatcher.close(); }
  } finally { await worker.close(); }
});

test("IPC snooze-attention widens new → snoozed in a single call", async () => {
  const worker = freshWorker();
  try {
    const item = await raiseAttention(worker, { kind: "decision", issueIdentity: "widen", revision: 0 });
    const dispatcher = dispatcherFor(worker);
    try {
      const until = new Date(Date.now() + 60 * 60_000).toISOString();
      const response = await dispatcher.dispatch("snooze-attention",
        requestFor("snooze-attention", [item.id, until]));
      assert.equal(response.ok, true);
      if (!response.ok) throw new Error("expected ok");
      const result = response.result as { state: string; snoozedUntil: string | null };
      assert.equal(result.state, "snoozed");
      assert.equal(result.snoozedUntil, until);
    } finally { await dispatcher.close(); }
  } finally { await worker.close(); }
});

test("IPC preview-artifact returns base64 preview when a grant covers the digest + kind", async () => {
  const worker = freshWorker();
  try {
    const body = Buffer.from("previewable\n");
    const dir = join(tmpdir(), `minimal-ipc-prev-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "hello.txt");
    writeFileSync(path, body);
    const digest = sha256Of(body);
    const artifact = await pinArtifact(worker, {
      uri: `file://${path}`,
      sha256: digest,
      kind: "context",
      bytes: body.byteLength,
      mime: "text/plain",
    });
    const grant = await requestGrant(worker, {
      taskId: null,
      kind: "capability",
      principal: "user",
      scope: { artifactKinds: ["context"] },
      digests: { sha256: digest },
    });
    await decideGrant(worker, grant.id, { decision: "approve", decidedBy: "operator" });
    const dispatcher = dispatcherFor(worker);
    try {
      const response = await dispatcher.dispatch("preview-artifact",
        requestFor("preview-artifact", [artifact.id, "user", null]));
      assert.equal(response.ok, true);
      if (!response.ok) throw new Error("expected ok");
      const result = response.result as { truncated: boolean; truncatedBase64Content: string; bytes: number };
      assert.equal(result.truncated, false);
      assert.equal(result.bytes, body.byteLength);
      const decoded = Buffer.from(result.truncatedBase64Content, "base64").toString("utf8");
      assert.equal(decoded, body.toString("utf8"));
    } finally { await dispatcher.close(); }
  } finally { await worker.close(); }
});

test("IPC preview-artifact fails with FORBIDDEN when no grant covers the digest", async () => {
  const worker = freshWorker();
  try {
    const body = Buffer.from("forbidden\n");
    const dir = join(tmpdir(), `minimal-ipc-forb-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "no.txt");
    writeFileSync(path, body);
    const digest = sha256Of(body);
    const artifact = await pinArtifact(worker, {
      uri: `file://${path}`,
      sha256: digest,
      kind: "context",
      bytes: body.byteLength,
      mime: "text/plain",
    });
    const dispatcher = dispatcherFor(worker);
    try {
      // No grant was approved → dispatcher must surface as CONFLICT.
      const response = await dispatcher.dispatch("preview-artifact",
        requestFor("preview-artifact", [artifact.id, "user", null]));
      assert.equal(response.ok, false);
      if (response.ok) throw new Error("expected conflict");
      assert.equal(response.error.code, "CONFLICT");
      assert.match(response.error.message, /No approved grant/);
    } finally { await dispatcher.close(); }
  } finally { await worker.close(); }
});
