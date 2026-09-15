/**
 * M4.7.a — hook activation + authority gate tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  activateHook,
  deactivateHook,
  isHookActive,
  listActiveHookIds,
  readHookActivation,
  readHookRow,
  activationKey,
  digestActivation,
} from "../../src/runtime/db/hook-activation";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function insertHook(
  worker: DbWorker,
  fields: {
    uuid?: string;
    name?: string;
    event?: string;
    action?: unknown;
    session_uuid?: string | null;
    terminal_uuid?: string | null;
    match?: string | null;
    enabled?: number;
  } = {},
): string {
  const driver = (worker as unknown as { driver: {
    prepare(sql: string): { run(...b: unknown[]): void };
  } }).driver;
  const uuid = fields.uuid ?? randomUUID();
  driver.prepare(
    "INSERT INTO hook (uuid, name, event, action_json, session_uuid, terminal_uuid, match, enabled) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    uuid,
    fields.name ?? "Test Hook",
    fields.event ?? "terminal-status",
    JSON.stringify(fields.action ?? { type: "notify", message: "hi" }),
    fields.session_uuid ?? null,
    fields.terminal_uuid ?? null,
    fields.match ?? null,
    fields.enabled ?? 1,
  );
  return uuid;
}

async function insertGrant(
  worker: DbWorker,
  fields: {
    uuid?: string;
    task_id?: string | null;
    principal?: string;
    state?: string;
    decided_by?: string | null;
    scope_json?: string;
  } = {},
): Promise<string> {
  const driver = (worker as unknown as { driver: {
    prepare(sql: string): { run(...b: unknown[]): void };
  } }).driver;
  const uuid = fields.uuid ?? randomUUID();
  const now = new Date().toISOString();
  driver.prepare(
    "INSERT INTO grant (uuid, task_id, kind, scope_json, principal, digests_json, state, " +
    "requested_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    uuid,
    fields.task_id ?? null,
    "authority",
    fields.scope_json ?? JSON.stringify({ hookKinds: ["notify"] }),
    fields.principal ?? "user-1",
    "{}",
    fields.state ?? "approved",
    now,
    fields.state === "pending" ? null : now,
    fields.decided_by ?? "user-2",
  );
  return uuid;
}

test("activateHook writes the activation meta row; isHookActive returns true; payloadDigest is deterministic", async () => {
  const worker = freshWorker();
  try {
    const hookId = insertHook(worker, { action: { type: "notify", message: "hi" } });
    const grantId = await insertGrant(worker, {
      scope_json: JSON.stringify({ hookKinds: ["notify"] }),
      principal: "user-1",
      decided_by: "user-2",
    });
    const record = await activateHook(worker, {
      hookId,
      principal: "user-2",
      authorityGrantId: grantId,
    });
    assert.equal(record.hookId, hookId);
    assert.equal(record.activatedBy, "user-2");
    assert.equal(record.authorityGrantId, grantId);
    assert.equal(record.hookKind, "notify");
    assert.match(record.payloadDigest, /^[0-9a-f]{64}$/);
    assert.equal(await isHookActive(worker, hookId), true);

    // Determinism: re-activate with identical inputs yields the same digest.
    const second = await activateHook(worker, {
      hookId,
      principal: "user-2",
      authorityGrantId: grantId,
    });
    assert.equal(second.payloadDigest, record.payloadDigest);
    // The digest function itself is deterministic regardless of activatedAt.
    const expectedDigest = digestActivation({
      hookId,
      activatedBy: "user-2",
      authorityGrantId: grantId,
      hookKind: "notify",
    });
    assert.equal(record.payloadDigest, expectedDigest);
  } finally { await worker.close(); }
});

test("activateHook refuses an unknown hookId with NOT_FOUND", async () => {
  const worker = freshWorker();
  try {
    const grantId = await insertGrant(worker);
    await assert.rejects(
      activateHook(worker, { hookId: randomUUID(), principal: "user-2", authorityGrantId: grantId }),
      (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND",
    );
  } finally { await worker.close(); }
});

test("activateHook refuses missing / non-approved / wrong-scope authority grant with FORBIDDEN", async () => {
  const worker = freshWorker();
  try {
    const hookId = insertHook(worker, { action: { type: "run-command-in-terminal", command: "echo" } });

    // Missing grant.
    await assert.rejects(
      activateHook(worker, { hookId, principal: "user-2", authorityGrantId: randomUUID() }),
      (err: unknown) => err instanceof AppError && err.failure.code === "FORBIDDEN",
    );

    // Non-approved grant.
    const pendingGrantId = await insertGrant(worker, { state: "pending" });
    await assert.rejects(
      activateHook(worker, { hookId, principal: "user-2", authorityGrantId: pendingGrantId }),
      (err: unknown) => err instanceof AppError && err.failure.code === "FORBIDDEN",
    );

    // Approved but scope_json does not cover the action kind.
    const narrowGrantId = await insertGrant(worker, {
      state: "approved",
      scope_json: JSON.stringify({ hookKinds: ["notify"] }),
    });
    await assert.rejects(
      activateHook(worker, { hookId, principal: "user-2", authorityGrantId: narrowGrantId }),
      (err: unknown) => err instanceof AppError && err.failure.code === "FORBIDDEN"
        && /hookKinds/.test((err as AppError).message),
    );
  } finally { await worker.close(); }
});

test("activateHook refuses self-activation: activator must equal the grant's decidedBy, not its principal", async () => {
  const worker = freshWorker();
  try {
    const hookId = insertHook(worker);
    // Grant was requested by user-1 and approved by user-2.
    const grantId = await insertGrant(worker, {
      principal: "user-1",
      decided_by: "user-2",
      state: "approved",
    });
    // Activator == requester principal (self-activation) ⇒ FORBIDDEN.
    await assert.rejects(
      activateHook(worker, { hookId, principal: "user-1", authorityGrantId: grantId }),
      (err: unknown) => err instanceof AppError && err.failure.code === "FORBIDDEN",
    );
    // Activator != decidedBy ⇒ FORBIDDEN.
    await assert.rejects(
      activateHook(worker, { hookId, principal: "user-3", authorityGrantId: grantId }),
      (err: unknown) => err instanceof AppError && err.failure.code === "FORBIDDEN",
    );
    // Activator == decidedBy ⇒ OK.
    const ok = await activateHook(worker, { hookId, principal: "user-2", authorityGrantId: grantId });
    assert.equal(ok.activatedBy, "user-2");
  } finally { await worker.close(); }
});

test("deactivateHook removes the row; isHookActive returns false; listActiveHookIds excludes the id", async () => {
  const worker = freshWorker();
  try {
    const hookId = insertHook(worker);
    const grantId = await insertGrant(worker);
    await activateHook(worker, { hookId, principal: "user-2", authorityGrantId: grantId });
    assert.equal(await isHookActive(worker, hookId), true);
    const before = await listActiveHookIds(worker);
    assert.ok(before.includes(hookId));

    const receipt = await deactivateHook(worker, { hookId, principal: "user-2" });
    assert.match(receipt.deactivatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(receipt.payloadDigest, /^[0-9a-f]{64}$/);
    assert.equal(await isHookActive(worker, hookId), false);
    const after = await listActiveHookIds(worker);
    assert.equal(after.includes(hookId), false);

    // Idempotent: deactivating an already-inactive hook returns empty digest.
    const second = await deactivateHook(worker, { hookId, principal: "user-2" });
    assert.equal(second.payloadDigest, "");

    // readHookActivation returns undefined for the inactive hook.
    assert.equal(await readHookActivation(worker, hookId), undefined);
  } finally { await worker.close(); }
});

test("activationKey and readHookRow helpers return the expected shapes", async () => {
  const worker = freshWorker();
  try {
    const hookId = insertHook(worker, { name: "open AGENTS.md", action: { type: "open-file", path: "AGENTS.md" } });
    const row = await readHookRow(worker, hookId);
    assert.ok(row);
    assert.equal(row!.name, "open AGENTS.md");
    assert.equal(row!.action.type, "open-file");
    // unknown hook
    assert.equal(await readHookRow(worker, randomUUID()), undefined);
    // activationKey shape
    assert.equal(activationKey(hookId), `hook-activation:${hookId}`);
  } finally { await worker.close(); }
});
