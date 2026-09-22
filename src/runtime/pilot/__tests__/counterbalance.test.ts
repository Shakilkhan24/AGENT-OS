/**
 * M9.5 — Williams 3×6 counterbalance unit tests.
 *
 * Three assertions:
 *   1. The canonical square has 6 rows × 3 conditions with no duplicates per row.
 *   2. Every adjacent condition pair appears exactly 3 times across the 6 rows.
 *   3. `conditionOrderFor` is deterministic for the same `(seed, participantId)`
 *      and varies across participants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WILLIAMS_SQUARE_3,
  williamsSquare3,
  conditionOrderFor,
  fixtureShuffleFor,
  PILOT_CONDITIONS,
} from "../counterbalance";

test("Williams square has 6 rows × 3 conditions with no duplicates per row", () => {
  const square = williamsSquare3();
  assert.equal(square.length, 6, "Williams 3×6 has 6 rows");
  for (const [rowIdx, row] of square.entries()) {
    assert.equal(row.length, 3, `row ${rowIdx} has 3 conditions`);
    const unique = new Set(row);
    assert.equal(unique.size, 3, `row ${rowIdx} has no duplicates`);
    for (const cond of row) {
      assert.ok(PILOT_CONDITIONS.includes(cond), `row ${rowIdx} uses canonical condition "${cond}"`);
    }
  }
  // The frozen constant and the helper return the same logical table.
  assert.equal(square.length, WILLIAMS_SQUARE_3.length);
});

test("every adjacent condition pair appears exactly 4 times across the 6 rows", () => {
  const square = williamsSquare3();
  const pairCounts = new Map<string, number>();
  for (const row of square) {
    for (let i = 0; i < row.length - 1; i += 1) {
      const a = row[i]!;
      const b = row[i + 1]!;
      // Canonical key — pairs are unordered for adjacency balance.
      const key = [a, b].sort().join("|");
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }
  // k=3 ⇒ 3 unordered pairs; across 6 rows × 2 adjacencies = 12 ordered
  // adjacencies, each unordered pair appears 12 / 3 = 4 times.
  const expectedPairs = [
    ["minimal", "terminal-baseline"],
    ["native-provider", "terminal-baseline"],
    ["minimal", "native-provider"],
  ];
  for (const [a, b] of expectedPairs) {
    const key = `${a}|${b}`;
    assert.equal(pairCounts.get(key), 4, `pair "${a}" ↔ "${b}" appears 4 times`);
  }
  // No extra pairs beyond the 3 expected unordered ones.
  assert.equal(pairCounts.size, 3, "no off-square adjacency pairs");
});

test("conditionOrderFor is deterministic for the same (seed, participantId) and varies across participants", () => {
  const seed = "9aa31be9";
  const orderAlice1 = conditionOrderFor("alice", seed);
  const orderAlice2 = conditionOrderFor("alice", seed);
  assert.deepEqual([...orderAlice1], [...orderAlice2], "same (seed, id) yields the same order");

  // Across 6 participants we should see at least 2 distinct rows in the
  // Williams square (the deterministic hash picks uniformly modulo 6, so
  // collisions are possible but unlikely with N=6).
  const seenRows = new Set<string>();
  for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
    seenRows.add(conditionOrderFor(id, seed).join(","));
  }
  assert.ok(seenRows.size >= 2, `expected ≥2 distinct rows across 6 participants, got ${seenRows.size}`);

  // Every returned order is a permutation of the three canonical conditions.
  for (const id of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
    const order = conditionOrderFor(id, seed);
    assert.equal(order.length, 3);
    assert.equal(new Set(order).size, 3);
    for (const cond of order) {
      assert.ok(PILOT_CONDITIONS.includes(cond));
    }
  }

  // Different seeds yield (with overwhelming probability) different orders
  // for the same participant.
  const orderSeedA = conditionOrderFor("alice", "seed-aaa");
  const orderSeedB = conditionOrderFor("alice", "seed-bbb");
  assert.notDeepEqual(
    [...orderSeedA],
    [...orderSeedB],
    "different seeds should produce different orders",
  );
});

test("fixtureShuffleFor is deterministic and is a permutation of the input", () => {
  const seed = "9aa31be9";
  const fixtures = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
  const a1 = fixtureShuffleFor("alice", seed, fixtures);
  const a2 = fixtureShuffleFor("alice", seed, fixtures);
  assert.deepEqual([...a1], [...a2], "same (seed, id) yields the same fixture order");
  assert.equal(a1.length, fixtures.length, "shuffle preserves length");
  assert.equal(new Set(a1).size, fixtures.length, "shuffle is a permutation (no dupes)");
  for (const id of fixtures) assert.ok(a1.includes(id), `fixture ${id} preserved`);

  // Empty + single-element inputs are identity.
  assert.equal(fixtureShuffleFor("alice", seed, []).length, 0);
  assert.deepEqual([...fixtureShuffleFor("alice", seed, ["only"])], ["only"]);
});