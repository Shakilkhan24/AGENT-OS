/**
 * M4.5.b — MCP authority + drift + added-powers tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  approveEndpointSnapshot,
  computeAddedPowers,
  isEndpointAuthorized,
  isPowerAuthorized,
  refreshEndpointDiscovery,
} from "../../src/runtime/db/mcp-authority";
import {
  MCP_TRANSPORT_REVISION,
  recordEndpointDiscovery,
} from "../../src/runtime/db/mcp-endpoint";
import { decideGrant, requestGrant } from "../../src/runtime/db/grants";
import { ownedDbFixture } from "../support";
import { AppError } from "../../src/shared/errors";

const TOOL_A = { name: "list_files", description: "List files", inputSchema: { type: "object", properties: {} } };
const TOOL_B = { name: "read_file", description: "Read file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

async function seedEndpoint(t: import("node:test").TestContext, owned: Awaited<ReturnType<typeof ownedDbFixture>>, tools = [TOOL_A, TOOL_B]) {
  const result = recordEndpointDiscovery(owned.worker, {
    url: "https://mcp.example.com/v1",
    transportRevision: MCP_TRANSPORT_REVISION,
    tools,
  });
  t.after(() => owned.close());
  return result;
}

test("approveEndpointSnapshot flips the row's approvedSnapshotDigest", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  const updated = approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  assert.equal(updated.approvedSnapshotDigest, seeded.snapshotDigest);
});

test("approveEndpointSnapshot refuses a snapshot digest that is not recorded", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  assert.throws(
    () => approveEndpointSnapshot(owned.worker, {
      endpointId: seeded.endpointId,
      snapshotDigest: "f".repeat(64),
      approvedBy: "user",
    }),
    (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
  );
});

test("approveEndpointSnapshot refuses an unknown endpointId", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  assert.throws(
    () => approveEndpointSnapshot(owned.worker, {
      endpointId: randomUUID(),
      snapshotDigest: "f".repeat(64),
      approvedBy: "user",
    }),
    (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND",
  );
});

test("isEndpointAuthorized returns false before approval, true after", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  assert.equal(isEndpointAuthorized(owned.worker, seeded.endpointId), false);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  assert.equal(isEndpointAuthorized(owned.worker, seeded.endpointId), true);
});

test("isPowerAuthorized returns 'power-unlisted' for a tool not in the snapshot", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  // `write_file` is not in the approved snapshot (TOOL_A / TOOL_B only).
  const result = await isPowerAuthorized(owned.worker, { endpointId: seeded.endpointId, powerName: "write_file" });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "power-unlisted");
});

test("isPowerAuthorized returns 'no-grant' when no authority grant exists for the endpoint", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  const result = await isPowerAuthorized(owned.worker, { endpointId: seeded.endpointId, powerName: TOOL_A.name });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "no-grant");
});

test("isPowerAuthorized returns 'grant-pending' when an authority grant is pending", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  await requestGrant(owned.worker, {
    taskId: null,
    kind: "authority",
    scope: { endpointId: seeded.endpointId, addedPowers: [TOOL_A.name] },
    principal: "user",
    digests: {},
    restrictions: [],
  });
  const result = await isPowerAuthorized(owned.worker, { endpointId: seeded.endpointId, powerName: TOOL_A.name });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "grant-pending");
});

test("isPowerAuthorized returns 'ok' when an approved authority grant lists the power", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  const grant = await requestGrant(owned.worker, {
    taskId: null,
    kind: "authority",
    scope: { endpointId: seeded.endpointId, addedPowers: [TOOL_A.name, TOOL_B.name] },
    principal: "user",
    digests: {},
    restrictions: [],
  });
  await decideGrant(owned.worker, grant.id, { decision: "approve", decidedBy: "owner" });
  const result = await isPowerAuthorized(owned.worker, { endpointId: seeded.endpointId, powerName: TOOL_A.name });
  assert.equal(result.authorized, true);
  assert.equal(result.reason, "ok");
});

test("isPowerAuthorized returns 'no-endpoint' for an unknown endpoint", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const result = await isPowerAuthorized(owned.worker, { endpointId: randomUUID(), powerName: "anything" });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "no-endpoint");
});

test("isPowerAuthorized returns 'no-snapshot' when the endpoint exists but has no approved snapshot", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  // Note: no approveEndpointSnapshot call.
  const result = await isPowerAuthorized(owned.worker, { endpointId: seeded.endpointId, powerName: TOOL_A.name });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, "no-snapshot");
});

test("computeAddedPowers returns the snapshot's tool names (empty-baseline diff)", () => {
  const snap = {
    endpointId: randomUUID(),
    transportRevision: MCP_TRANSPORT_REVISION,
    capturedAt: new Date().toISOString(),
    tools: [
      { name: "a", descriptionDigest: "0".repeat(64), inputSchemaDigest: "0".repeat(64) },
      { name: "b", descriptionDigest: "0".repeat(64), inputSchemaDigest: "0".repeat(64) },
    ],
    snapshotDigest: "f".repeat(64),
  };
  assert.deepEqual(computeAddedPowers(snap), ["a", "b"]);
});

test("refreshEndpointDiscovery reports 'unchanged' when the fresh discovery matches the approved snapshot", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  const result = refreshEndpointDiscovery(owned.worker, {
    endpointId: seeded.endpointId,
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_A, TOOL_B],
  });
  assert.equal(result.kind, "unchanged");
  assert.equal(result.previousDigest, seeded.snapshotDigest);
  assert.equal(result.newDigest, seeded.snapshotDigest);
  assert.equal(result.addedTools.length, 0);
  assert.equal(result.removedTools.length, 0);
  assert.equal(result.changedTools.length, 0);
});

test("refreshEndpointDiscovery reports 'drift' with added/removed/changed tools", async (t) => {
  const owned = await ownedDbFixture();
  const seeded = await seedEndpoint(t, owned);
  approveEndpointSnapshot(owned.worker, {
    endpointId: seeded.endpointId,
    snapshotDigest: seeded.snapshotDigest,
    approvedBy: "user",
  });
  // Fresh discovery: TOOL_A unchanged, TOOL_B description changed,
  // TOOL_C is brand new. TOOL_A was kept verbatim.
  const TOOL_B_DRIFTED = { ...TOOL_B, description: "Read a file by path (now supports ranges)" };
  const TOOL_C = { name: "write_file", description: "Write a file", inputSchema: { type: "object" } };
  const result = refreshEndpointDiscovery(owned.worker, {
    endpointId: seeded.endpointId,
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_A, TOOL_B_DRIFTED, TOOL_C],
  });
  assert.equal(result.kind, "drift");
  assert.deepEqual(result.addedTools, ["write_file"]);
  assert.deepEqual(result.removedTools, []);
  assert.deepEqual(result.changedTools, ["read_file"]);
});
