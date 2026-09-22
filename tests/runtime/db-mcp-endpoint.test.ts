/**
 * M4.5.b — MCP endpoint identity + snapshot tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  deriveEndpointId,
  listEndpointSnapshots,
  MCP_ENDPOINT_META_PREFIX,
  MCP_TOOL_SNAPSHOT_META_PREFIX,
  MCP_TRANSPORT_REVISION,
  readEndpointRow,
  recordEndpointDiscovery,
  endpointKey,
  snapshotKey,
} from "../../src/runtime/db/mcp-endpoint";
import { ownedDbFixture } from "../support";
import { AppError } from "../../src/shared/errors";

const TOOL_A = { name: "list_files", description: "List files in a directory", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
const TOOL_B = { name: "read_file", description: "Read a file by path", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

test("deriveEndpointId is deterministic — same input ⇒ same endpointId", () => {
  const a = deriveEndpointId("https://mcp.example.com/v1", MCP_TRANSPORT_REVISION);
  const b = deriveEndpointId("https://mcp.example.com/v1", MCP_TRANSPORT_REVISION);
  assert.equal(a.endpointId, b.endpointId);
  assert.equal(a.urlHash, b.urlHash);
  // Format check (UUID v4 shape).
  assert.match(a.endpointId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("deriveEndpointId does not collide for different URLs or transportRevisions", () => {
  const url1 = deriveEndpointId("https://a.example.com", MCP_TRANSPORT_REVISION);
  const url2 = deriveEndpointId("https://b.example.com", MCP_TRANSPORT_REVISION);
  const rev1 = deriveEndpointId("https://a.example.com", MCP_TRANSPORT_REVISION);
  const rev2 = deriveEndpointId("https://a.example.com", "2025-01-01");
  assert.notEqual(url1.endpointId, url2.endpointId);
  assert.notEqual(url1.urlHash, url2.urlHash);
  assert.notEqual(rev1.endpointId, rev2.endpointId);
  // But the urlHash is shared for the same URL regardless of revision.
  assert.equal(rev1.urlHash, rev2.urlHash);
});

test("recordEndpointDiscovery writes an identity row and a snapshot row", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const result = recordEndpointDiscovery(owned.worker, {
    url: "https://mcp.example.com/v1",
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_A, TOOL_B],
  });
  assert.ok(result.endpointId);
  assert.equal(result.snapshot.tools.length, 2);
  assert.match(result.snapshotDigest, /^[0-9a-f]{64}$/);
  const row = readEndpointRow(owned.worker, result.endpointId);
  assert.ok(row);
  assert.equal(row.url, "https://mcp.example.com/v1");
  assert.equal(row.transportRevision, MCP_TRANSPORT_REVISION);
  assert.equal(row.approvedSnapshotDigest, null);
});

test("recordEndpointDiscovery is idempotent for identical tool descriptors (same digest, one snapshot row)", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  // First capture.
  const first = recordEndpointDiscovery(owned.worker, {
    url: "https://mcp.example.com/v1",
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_A, TOOL_B],
  });
  // Second capture with identical input — same tools ⇒ same
  // snapshot digest (capturedAt is intentionally NOT part of the
  // canonical input, see `buildSnapshot`). The snapshot row
  // collapses to one via `INSERT OR REPLACE` on the
  // content-addressed key.
  const second = recordEndpointDiscovery(owned.worker, {
    url: "https://mcp.example.com/v1",
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_A, TOOL_B],
  });
  assert.equal(first.endpointId, second.endpointId);
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  const snaps = listEndpointSnapshots(owned.worker, first.endpointId);
  assert.equal(snaps.length, 1);
});

test("recordEndpointDiscovery rejects a non-pinned transportRevision with INVALID_REQUEST", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  assert.throws(
    () => recordEndpointDiscovery(owned.worker, {
      url: "https://mcp.example.com/v1",
      transportRevision: "2025-01-01",
      tools: [TOOL_A],
    }),
    (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
  );
});

test("listEndpointSnapshots returns snapshots in capturedAt order", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const endpointId = recordEndpointDiscovery(owned.worker, {
    url: "https://mcp.example.com/v1",
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_A],
  }).endpointId;
  await new Promise((resolve) => setTimeout(resolve, 5));
  recordEndpointDiscovery(owned.worker, {
    url: "https://mcp.example.com/v1",
    transportRevision: MCP_TRANSPORT_REVISION,
    tools: [TOOL_B],
  });
  const snaps = listEndpointSnapshots(owned.worker, endpointId);
  assert.equal(snaps.length, 2);
  // First snapshot is the earlier capture.
  assert.equal(snaps[0].tools[0].name, TOOL_A.name);
  assert.equal(snaps[1].tools[0].name, TOOL_B.name);
  assert.ok(snaps[0].capturedAt <= snaps[1].capturedAt);
});

test("listEndpointSnapshots returns [] for an unknown endpointId", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const snaps = listEndpointSnapshots(owned.worker, randomUUID());
  assert.equal(snaps.length, 0);
});

test("readEndpointRow returns undefined for an unknown endpointId", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const row = readEndpointRow(owned.worker, randomUUID());
  assert.equal(row, undefined);
});

test("meta-key builders are correct", () => {
  const eid = randomUUID();
  assert.equal(endpointKey(eid), `${MCP_ENDPOINT_META_PREFIX}${eid}`);
  const dig = "f".repeat(64);
  assert.equal(snapshotKey(eid, dig), `${MCP_TOOL_SNAPSHOT_META_PREFIX}${eid}:${dig}`);
});
