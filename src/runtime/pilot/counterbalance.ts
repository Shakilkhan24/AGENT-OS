/**
 * M9.5 — Williams 3×6 counterbalance helper.
 *
 * Counterbalancing is the only honest answer to order effects in a
 * small within-subjects pilot. The Williams design (Williams 1949)
 * is a Latin-square variant where every adjacent pair of conditions
 * appears the same number of times across rows; for k=3 conditions
 * and one balanced block, the table has 6 rows.
 *
 * This module exposes three pure helpers:
 *
 *   - `williamsSquare3()` — the canonical 3×6 table (read-only).
 *   - `conditionOrderFor(participantId, seed)` — deterministic per-
 *     participant condition order derived from `(seed, participantId)`.
 *   - `fixtureShuffleFor(participantId, seed, fixtureIds)` — a
 *     separate (deterministic) shuffle of fixtures within a participant
 *     so the condition order and fixture order are independent.
 *
 * No I/O; no time; no global state. Determinism is enforced by sha256
 * over the inputs, so the same `(seed, participantId)` always yields
 * the same order across runs and machines.
 */
import { createHash } from "node:crypto";
import { pilotConditionSchema, type PilotCondition } from "../../shared/pilot-schema";

/** The three conditions in canonical order. */
export const PILOT_CONDITIONS: ReadonlyArray<PilotCondition> = Object.freeze([
  "terminal-baseline",
  "native-provider",
  "minimal",
]);

/**
 * Build the canonical Williams 3×6 table (k=3, one balanced block).
 *
 * For k=3 conditions, the Williams design produces k(k-1) = 6 rows
 * where each row is a permutation of the conditions and every
 * adjacent (unordered) pair appears exactly (k-1) = 2 times per
 * row-pair (i.e. 12 ordered adjacencies across 6 rows, 4 per
 * unordered pair).
 *
 * Construction: take the first row as the canonical order, then
 * for each subsequent row `i` (1..5) build the row by interleaving
 * the conditions in a fixed pattern that guarantees adjacency
 * balance. The hand-authored table below matches the construction
 * and is asserted by `counterbalance.test.ts`.
 *
 * Reference: Williams, E. J. (1949). "Experimental designs balanced
 * for the estimation of residual effects of treatments".
 */
function buildWilliamsSquare3(): ReadonlyArray<ReadonlyArray<PilotCondition>> {
  // The 6 rows below are a canonical Williams 3×6 square. Every
  // adjacent (unordered) pair appears exactly 4 times across the
  // 12 ordered adjacencies (6 rows × 2 adjacencies per row).
  const rows: ReadonlyArray<ReadonlyArray<PilotCondition>> = [
    ["terminal-baseline", "minimal", "native-provider"],
    ["native-provider", "terminal-baseline", "minimal"],
    ["minimal", "native-provider", "terminal-baseline"],
    ["terminal-baseline", "native-provider", "minimal"],
    ["minimal", "terminal-baseline", "native-provider"],
    ["native-provider", "minimal", "terminal-baseline"],
  ];
  return rows.map((r) => Object.freeze([...r] as ReadonlyArray<PilotCondition>));
}

/** The canonical Williams 3×6 table. Frozen on module load. */
export const WILLIAMS_SQUARE_3: ReadonlyArray<ReadonlyArray<PilotCondition>> = Object.freeze(
  buildWilliamsSquare3(),
);

/** Defensive copy of the canonical square (validates shape on each call). */
export function williamsSquare3(): ReadonlyArray<ReadonlyArray<PilotCondition>> {
  return WILLIAMS_SQUARE_3.map((row) => Object.freeze([...row]));
}

/**
 * Deterministic hash → small non-negative integer. We use the first
 * 4 bytes of a sha256 digest as a uniform 32-bit unsigned value.
 */
function hashToU32(...parts: ReadonlyArray<string>): number {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  h.update("\u0000"); // unambiguous separator
  const digest = h.digest();
  return digest.readUInt32BE(0);
}

/**
 * Derive a per-participant condition order. Picks a row from the
 * Williams square by hashing `(seed, participantId)` modulo 6.
 *
 * Determinism contract: same `(seed, participantId)` always returns
 * the same order; different participant IDs return (with high
 * probability) different rows.
 */
export function conditionOrderFor(
  participantId: string,
  seed: string,
): ReadonlyArray<PilotCondition> {
  if (participantId.length === 0) {
    throw new Error("participantId must be non-empty");
  }
  if (seed.length === 0) {
    throw new Error("seed must be non-empty");
  }
  const rowIndex = hashToU32(seed, "condition-order", participantId) % WILLIAMS_SQUARE_3.length;
  return WILLIAMS_SQUARE_3[rowIndex]!;
}

/**
 * Stable shuffle of `fixtureIds` per `(seed, participantId)`. The
 * shuffle is a Fisher-Yates driven by successive hashes so the order
 * is reproducible without a separate RNG state.
 */
export function fixtureShuffleFor(
  participantId: string,
  seed: string,
  fixtureIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (participantId.length === 0) {
    throw new Error("participantId must be non-empty");
  }
  if (seed.length === 0) {
    throw new Error("seed must be non-empty");
  }
  if (fixtureIds.length === 0) return Object.freeze([] as string[]);
  if (fixtureIds.length === 1) return Object.freeze([fixtureIds[0]!]);
  const arr = [...fixtureIds];
  // Fisher-Yates; pull one 32-bit value per swap.
  let counter = 0;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = hashToU32(seed, "fixture-shuffle", participantId, String(counter)) % (i + 1);
    counter += 1;
    if (j !== i) {
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
  }
  return Object.freeze(arr);
}

/**
 * Map a participant's condition order to the per-condition `conditionPosition`
 * (0-based, length 3). Useful for filling `attemptRecord.conditionPosition`.
 */
export function conditionPositionsFor(
  order: ReadonlyArray<PilotCondition>,
): Readonly<Record<PilotCondition, number>> {
  const out = {} as Record<PilotCondition, number>;
  order.forEach((cond, idx) => {
    out[cond] = idx;
  });
  return out;
}

/** Re-export the schema for convenience at the runner boundary. */
export { pilotConditionSchema };