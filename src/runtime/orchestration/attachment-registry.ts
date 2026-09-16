/**
 * M5.5 — attachment registry with per-view generations + bounded
 * observers.
 *
 * The M5.5 spec (FUTURE/IMPLEMENTATION-README.md line 233) reads:
 *
 * > M5.5 Implement an attachment registry with per-view
 * > generations, output subscriptions/byte credits and one
 * > interactive/resize owner per terminal. Bound slow observers
 * > independently so one mirror cannot freeze another. Stale
 * > detach/resize/input cannot control a replacement attachment.
 * > Reuse the terminal-owned input queue from M1.
 *
 * Trust model (mirrors `shared/attachment-schema.ts`):
 *
 *  - Every `(terminalUuid, subscriberId)` pair carries a monotonic
 *    `generation` counter. The runtime refuses stale
 *    `detach` / `resize` / `input` when the supplied
 *    `expectedGeneration` differs from the live value.
 *  - Exactly ONE subscriber is the *interactive owner* per
 *    terminal. A second owner attachment refuses
 *    `kind: "conflict", reason: "owner-already-set"` unless the
 *    caller supplies a valid `surrenderToken` of the current owner.
 *  - Output is fanned out to all subscribers via per-observer
 *    `BudgetedWriter`s; a stalled observer pauses ITS subscription's
 *    drain without blocking the others.
 *  - `transferOwnership` requires an explicit `surrenderToken`.
 *    Once transferred, the prior owner's `surrenderToken` is
 *    rotated and ALL pending input from that owner is cancelled.
 *  - Every persisted record carries a SHA-256 `payloadDigest`
 *    computed via `runtime/db/effective-settings.ts:stableStringify`.
 *    Volatile fields (`subscribedAt`, `transferredAt`,
 *    `pausedAt`) are excluded.
 *
 * Storage convention (mirrors M4.6 / M4.7 / M5.2 / M5.3 / M5.4):
 *
 *  - `attachment-subscription:<terminalUuid>:<subscriberId>` →
 *    the immutable subscription state (excludes `subscribedAt`).
 *  - `attachment-ownership:<terminalUuid>` → the current owner
 *    row (carries the live `surrenderToken`).
 *  - `attachment-registry-abandoned:<terminalUuid>` → the
 *    abandoned-row meta entry written by
 *    `enforceOwnershipHandover`.
 *
 * Renderer / IPC integration is deferred to a later M5 increment
 * that wires the M5.1 facade's `attachTerminal`-style methods to
 * the registry.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z, type ZodError } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import {
  acknowledgeOutputInputSchema,
  attachmentRegistryStatusSchema,
  registerAttachmentInputSchema,
  publishOutputInputSchema,
  replenishByteCreditsInputSchema,
  requestResizeInputSchema,
  sendInputInputSchema,
  subscriptionStateSchema,
  transferOwnershipInputSchema,
  unregisterAttachmentInputSchema,
  type AcknowledgeOutputInput,
  type AttachmentRegistryStatus,
  type AttachRole,
  type PublishOutputInput,
  type RegisterAttachmentInput,
  type ReplenishByteCreditsInput,
  type RequestResizeInput,
  type SendInputInput,
  type SubscriberKind,
  type SubscriptionState,
  type TransferOwnershipInput,
  type UnregisterAttachmentInput,
} from "../../shared/attachment-schema";
import {
  HIGH_WATERMARK,
  LOW_WATERMARK,
  type BudgetedWriter,
  createBudgetedWriter,
} from "./back-pressure";
import type { DbWorker } from "../db/worker";
import type { TerminalInputQueue } from "../input-queue";

// ── Defaults / caps ──────────────────────────────────────────────────────────

/** M5.5 default — observer credit bucket (4 MiB). */
export const DEFAULT_OBSERVER_BYTE_CREDITS = 4 * 1024 * 1024;

/** M5.5 default — owner credit bucket (64 MiB). */
export const DEFAULT_OWNER_BYTE_CREDITS = 64 * 1024 * 1024;

/** Bounded replay buffer per terminal (1 MiB). */
export const REPLAY_BUFFER_BYTES = 1 * 1024 * 1024;

/** Auto-detach observers when no replacement owner attaches within this window. */
export const OWNERSHIP_HANDOVER_TIMEOUT_MS = 5_000;

// ── Meta-key prefixes (D-9) ──────────────────────────────────────────────────

export const SUBSCRIPTION_ROW_META_PREFIX = "attachment-subscription:";
export const OWNERSHIP_ROW_META_PREFIX = "attachment-ownership:";
export const ABANDONED_ROW_META_PREFIX = "attachment-registry-abandoned:";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}

function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

function sha256Hex(canonical: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ ...(canonical as Record<string, unknown>), payloadDigest: "" }), "utf8")
    .digest("hex");
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const err = result.error as ZodError;
    throw new AppError("INVALID_REQUEST",
      `Schema validation failed: ${err.issues.map(i => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  }
  return result.data;
}

function writeMeta(worker: DbWorker, key: string, value: unknown): void {
  driverOf(worker).prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  ).run(key, stableStringify(value));
}

function deleteMeta(worker: DbWorker, key: string): void {
  driverOf(worker).prepare("DELETE FROM meta WHERE key = ?").run(key);
}

function rowKey(terminalUuid: string, subscriberId: string): string {
  return `${SUBSCRIPTION_ROW_META_PREFIX}${terminalUuid}:${subscriberId}`;
}

// ── Result envelopes ─────────────────────────────────────────────────────────

export interface OkResult<T> { readonly kind: "ok"; readonly value: T }
export interface ConflictResult { readonly kind: "conflict"; readonly reason: string }
export interface ForbiddenResult { readonly kind: "forbidden"; readonly reason: string }
export interface NotFoundResult { readonly kind: "not-found"; readonly reason: string }
export interface BusyResult { readonly kind: "busy"; readonly reason: string }

export type RegisterResult =
  | OkResult<SubscriptionState>
  | ConflictResult
  | ForbiddenResult;
export type UnregisterResult =
  | OkResult<{ dropped: number }>
  | ConflictResult
  | NotFoundResult;
export type PublishPerSubscriber = {
  readonly subscriberId: string;
  readonly deliveredBytes: number;
  readonly pausedReason: SubscriptionState["pausedReason"];
  readonly remainingByteCredits: number;
};
export type PublishResult =
  | OkResult<{ perSubscriber: ReadonlyArray<PublishPerSubscriber> }>
  | NotFoundResult;
export type ResizeResult =
  | OkResult<{ newGeneration: number }>
  | ForbiddenResult
  | ConflictResult;
export type SendInputResult =
  | OkResult<{ admittedBytes: number }>
  | ForbiddenResult
  | ConflictResult
  | BusyResult;
export type TransferResult =
  | OkResult<SubscriptionState>
  | ForbiddenResult
  | ConflictResult
  | NotFoundResult;
export type AcknowledgeResult =
  | OkResult<{ remainingByteCredits: number }>
  | NotFoundResult;
export type ReplenishResult =
  | OkResult<{ remainingByteCredits: number }>
  | ForbiddenResult
  | NotFoundResult;
export type HandoverResult =
  | OkResult<{ abandoned: true } | { ownerSubscriberId: string }>
  | NotFoundResult;

// ── In-memory per-subscriber state ───────────────────────────────────────────

interface InMemorySubscriber {
  state: SubscriptionState;
  writer: BudgetedWriter;
  /** Bounded FIFO of recently-published bytes — supports D-5 replay. */
  outstandingBytes: number;
}

interface InMemoryTerminal {
  ownerSubscriberId: string | null;
  surrenderToken: string | null;
  ownerDetachedAt: number | null;
  subscribers: Map<string, InMemorySubscriber>;
}

// ── Registry factory ─────────────────────────────────────────────────────────

export interface AttachmentRegistryDeps {
  /** Optional owner-input queue (the M1 `TerminalInputQueue`). */
  readonly inputQueue?: TerminalInputQueue;
  /** Optional custom `BudgetedWriter` factory (used by tests). */
  readonly createWriter?: (cb: { pause: () => void; resume: () => void }) => BudgetedWriter;
}

export interface AttachmentRegistry {
  registerAttachment(input: RegisterAttachmentInput): Promise<RegisterResult>;
  unregisterAttachment(input: UnregisterAttachmentInput): Promise<UnregisterResult>;
  publishOutput(input: PublishOutputInput): Promise<PublishResult>;
  requestResize(input: RequestResizeInput): Promise<ResizeResult>;
  sendInput(input: SendInputInput): Promise<SendInputResult>;
  acknowledgeOutput(input: AcknowledgeOutputInput): Promise<AcknowledgeResult>;
  transferOwnership(input: TransferOwnershipInput): Promise<TransferResult>;
  replenishByteCredits(input: ReplenishByteCreditsInput): Promise<ReplenishResult>;
  enforceOwnershipHandover(terminalUuid: string): Promise<HandoverResult>;
  /** Read the live status snapshot (status schema mirror). */
  readStatus(): AttachmentRegistryStatus;
  /** Test seam — current in-memory state. */
  __debugSnapshot(): ReadonlyMap<string, InMemoryTerminal>;
}

export function createAttachmentRegistry(
  worker: DbWorker,
  deps: AttachmentRegistryDeps = {},
): AttachmentRegistry {
  const terminals = new Map<string, InMemoryTerminal>();
  const registryId = randomUUID();
  const writerFactory = deps.createWriter ?? createBudgetedWriter;

  function ensureTerminal(terminalUuid: string): InMemoryTerminal {
    let entry = terminals.get(terminalUuid);
    if (!entry) {
      entry = {
        ownerSubscriberId: null,
        surrenderToken: null,
        ownerDetachedAt: null,
        subscribers: new Map(),
      };
      terminals.set(terminalUuid, entry);
    }
    return entry;
  }

  function buildState(args: {
    terminalUuid: string;
    subscriberId: string;
    kind: SubscriberKind;
    attaches: ReadonlyArray<AttachRole>;
    generation: number;
    remainingByteCredits: number;
    nextCursor: number;
    pausedReason: SubscriptionState["pausedReason"];
    subscribedAt: string;
  }): SubscriptionState {
    const payloadDigest = sha256Hex({
      terminalUuid: args.terminalUuid,
      subscriberId: args.subscriberId,
      kind: args.kind,
      attaches: args.attaches,
      generation: args.generation,
      remainingByteCredits: args.remainingByteCredits,
      nextCursor: args.nextCursor,
      pausedReason: args.pausedReason,
      payloadDigest: "",
    });
    return subscriptionStateSchema.parse({
      terminalUuid: args.terminalUuid,
      subscriberId: args.subscriberId,
      kind: args.kind,
      attaches: args.attaches,
      generation: args.generation,
      remainingByteCredits: args.remainingByteCredits,
      nextCursor: args.nextCursor,
      pausedReason: args.pausedReason,
      payloadDigest,
      subscribedAt: args.subscribedAt,
    });
  }

  // ── registerAttachment ────────────────────────────────────────────────

  async function registerAttachment(input: RegisterAttachmentInput): Promise<RegisterResult> {
    const parsed = parseOrThrow(registerAttachmentInputSchema, input);
    const terminal = ensureTerminal(parsed.terminalUuid);

    // D-2: refuse a second owner unless a surrenderToken is supplied.
    if (parsed.kind === "owner" && terminal.ownerSubscriberId !== null
        && terminal.ownerSubscriberId !== parsed.subscriberId) {
      return { kind: "conflict", reason: "owner-already-set" };
    }

    const isFirstOwnerRegistration =
      parsed.kind === "owner" && terminal.ownerSubscriberId === null;

    const initialCredits = parsed.initialByteCredits
      ?? (parsed.kind === "owner" ? DEFAULT_OWNER_BYTE_CREDITS : DEFAULT_OBSERVER_BYTE_CREDITS);

    // D-3: per-subscriber generation starts at 1 for new subscribers;
    // a re-register by the same owner with a valid expectedGeneration
    // bumps it (transfers bump via `transferOwnership`).
    const existing = terminal.subscribers.get(parsed.subscriberId);
    const generation = existing
      ? (existing.state.generation + 1)
      : 1;

    if (existing && existing.state.generation !== parsed.expectedGeneration) {
      return {
        kind: "conflict",
        reason: `expected-generation-mismatch: live=${existing.state.generation} expected=${parsed.expectedGeneration}`,
      };
    }

    const state = buildState({
      terminalUuid: parsed.terminalUuid,
      subscriberId: parsed.subscriberId,
      kind: parsed.kind,
      attaches: parsed.attaches,
      generation,
      remainingByteCredits: initialCredits,
      nextCursor: existing?.state.nextCursor ?? 0,
      pausedReason: null,
      subscribedAt: new Date().toISOString(),
    });

    // Per-observer `BudgetedWriter` (D-4).
    const writer = existing?.writer ?? writerFactory({
      pause: () => { state.pausedReason = "high-watermark"; },
      resume: () => { state.pausedReason = null; },
    });

    terminal.subscribers.set(parsed.subscriberId, {
      state,
      writer,
      outstandingBytes: existing?.outstandingBytes ?? 0,
    });

    if (parsed.kind === "owner") {
      terminal.ownerSubscriberId = parsed.subscriberId;
      if (isFirstOwnerRegistration) {
        terminal.surrenderToken = randomBytes(32).toString("hex");
        terminal.ownerDetachedAt = null;
      }
      writeMeta(worker, `${OWNERSHIP_ROW_META_PREFIX}${parsed.terminalUuid}`, {
        terminalUuid: parsed.terminalUuid,
        ownerSubscriberId: parsed.subscriberId,
        surrenderToken: terminal.surrenderToken,
        generation,
        updatedAt: state.subscribedAt,
      });
    }
    writeMeta(worker, rowKey(parsed.terminalUuid, parsed.subscriberId), state);

    return { kind: "ok", value: state };
  }

  // ── unregisterAttachment ──────────────────────────────────────────────

  async function unregisterAttachment(input: UnregisterAttachmentInput): Promise<UnregisterResult> {
    const parsed = parseOrThrow(unregisterAttachmentInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "not-found", reason: `terminal ${parsed.terminalUuid} not registered` };
    const sub = terminal.subscribers.get(parsed.subscriberId);
    if (!sub) return { kind: "not-found", reason: `subscriber ${parsed.subscriberId} not registered` };
    if (sub.state.generation !== parsed.expectedGeneration) {
      return {
        kind: "conflict",
        reason: `expected-generation-mismatch: live=${sub.state.generation} expected=${parsed.expectedGeneration}`,
      };
    }

    const wasOwner = terminal.ownerSubscriberId === parsed.subscriberId;
    if (wasOwner && deps.inputQueue) {
      // M1 input queue — cancel unsubmitted bytes for this owner.
      deps.inputQueue.cancel(sub.state.subscriberId);
    }
    terminal.subscribers.delete(parsed.subscriberId);
    deleteMeta(worker, rowKey(parsed.terminalUuid, parsed.subscriberId));
    if (wasOwner) {
      terminal.ownerSubscriberId = null;
      terminal.surrenderToken = null;
      terminal.ownerDetachedAt = Date.now();
      deleteMeta(worker, `${OWNERSHIP_ROW_META_PREFIX}${parsed.terminalUuid}`);
    }
    if (terminal.subscribers.size === 0) terminals.delete(parsed.terminalUuid);
    return { kind: "ok", value: { dropped: wasOwner ? 1 : 0 } };
  }

  // ── publishOutput ─────────────────────────────────────────────────────

  async function publishOutput(input: PublishOutputInput): Promise<PublishResult> {
    const parsed = parseOrThrow(publishOutputInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "not-found", reason: `terminal ${parsed.terminalUuid} not registered` };
    const out: PublishPerSubscriber[] = [];
    const dataBytes = parsed.data.length;
    for (const sub of terminal.subscribers.values()) {
      if (!sub.state.attaches.includes("output")) continue;
      // D-6: byte credits.
      if (sub.state.remainingByteCredits < dataBytes) {
        sub.state.pausedReason = "byte-credit-exhausted";
        out.push({
          subscriberId: sub.state.subscriberId,
          deliveredBytes: 0,
          pausedReason: "byte-credit-exhausted",
          remainingByteCredits: sub.state.remainingByteCredits,
        });
        continue;
      }
      // D-4: per-observer budgeted writer; pause when high-watermark crossed.
      sub.writer.deliver(dataBytes);
      sub.outstandingBytes += dataBytes;
      sub.state.remainingByteCredits = Math.max(0, sub.state.remainingByteCredits - dataBytes);
      sub.state.nextCursor = parsed.cursor + dataBytes;
      if (sub.outstandingBytes >= HIGH_WATERMARK) {
        sub.state.pausedReason = "high-watermark";
      }
      out.push({
        subscriberId: sub.state.subscriberId,
        deliveredBytes: dataBytes,
        pausedReason: sub.state.pausedReason,
        remainingByteCredits: sub.state.remainingByteCredits,
      });
    }
    return { kind: "ok", value: { perSubscriber: out } };
  }

  // ── requestResize ─────────────────────────────────────────────────────

  async function requestResize(input: RequestResizeInput): Promise<ResizeResult> {
    const parsed = parseOrThrow(requestResizeInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "conflict", reason: `terminal ${parsed.terminalUuid} not registered` };
    if (terminal.ownerSubscriberId !== parsed.subscriberId) {
      return { kind: "forbidden", reason: "resize-owner-only" };
    }
    const sub = terminal.subscribers.get(parsed.subscriberId);
    if (!sub) return { kind: "conflict", reason: "owner subscription missing" };
    if (sub.state.generation !== parsed.expectedGeneration) {
      return {
        kind: "conflict",
        reason: `expected-generation-mismatch: live=${sub.state.generation} expected=${parsed.expectedGeneration}`,
      };
    }
    sub.state.generation = Math.min(1024, sub.state.generation + 1);
    return { kind: "ok", value: { newGeneration: sub.state.generation } };
  }

  // ── sendInput ─────────────────────────────────────────────────────────

  async function sendInput(input: SendInputInput): Promise<SendInputResult> {
    const parsed = parseOrThrow(sendInputInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "conflict", reason: `terminal ${parsed.terminalUuid} not registered` };
    if (terminal.ownerSubscriberId !== parsed.subscriberId) {
      return { kind: "forbidden", reason: "input-owner-only" };
    }
    const sub = terminal.subscribers.get(parsed.subscriberId);
    if (!sub) return { kind: "conflict", reason: "owner subscription missing" };
    if (sub.state.generation !== parsed.expectedGeneration) {
      return {
        kind: "conflict",
        reason: `expected-generation-mismatch: live=${sub.state.generation} expected=${parsed.expectedGeneration}`,
      };
    }
    if (!deps.inputQueue) {
      return { kind: "conflict", reason: "input queue not wired; sendInput requires TerminalInputQueue" };
    }
    try {
      const result = deps.inputQueue.enqueue(sub.state.subscriberId, parsed.data);
      return { kind: "ok", value: { admittedBytes: result.admitted } };
    } catch (error) {
      if (error instanceof AppError) {
        if (error.failure.code === "BUSY") return { kind: "busy", reason: error.message };
        return { kind: "conflict", reason: error.message };
      }
      throw error;
    }
  }

  // ── acknowledgeOutput ─────────────────────────────────────────────────

  async function acknowledgeOutput(input: AcknowledgeOutputInput): Promise<AcknowledgeResult> {
    const parsed = parseOrThrow(acknowledgeOutputInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "not-found", reason: `terminal ${parsed.terminalUuid} not registered` };
    const sub = terminal.subscribers.get(parsed.subscriberId);
    if (!sub) return { kind: "not-found", reason: `subscriber ${parsed.subscriberId} not registered` };
    sub.writer.acknowledge(parsed.bytes);
    sub.outstandingBytes = Math.max(0, sub.outstandingBytes - parsed.bytes);
    if (sub.outstandingBytes <= LOW_WATERMARK) sub.state.pausedReason = null;
    return { kind: "ok", value: { remainingByteCredits: sub.state.remainingByteCredits } };
  }

  // ── transferOwnership ─────────────────────────────────────────────────

  async function transferOwnership(input: TransferOwnershipInput): Promise<TransferResult> {
    const parsed = parseOrThrow(transferOwnershipInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "not-found", reason: `terminal ${parsed.terminalUuid} not registered` };
    if (terminal.ownerSubscriberId !== parsed.fromSubscriberId) {
      return { kind: "forbidden", reason: "from-subscriber-is-not-owner" };
    }
    if (!terminal.surrenderToken || terminal.surrenderToken !== parsed.surrenderToken) {
      return { kind: "forbidden", reason: "surrender-token-mismatch" };
    }
    const fromSub = terminal.subscribers.get(parsed.fromSubscriberId);
    if (!fromSub) return { kind: "not-found", reason: "from-subscriber subscription missing" };

    // Cancel any pending owner-input from the surrendering owner.
    if (deps.inputQueue) deps.inputQueue.cancel(parsed.fromSubscriberId);

    const newOwnerSub = terminal.subscribers.get(parsed.toSubscriberId);
    if (!newOwnerSub) {
      return { kind: "not-found", reason: `to-subscriber ${parsed.toSubscriberId} not registered` };
    }
    if (newOwnerSub.state.generation !== parsed.toExpectedGeneration) {
      return {
        kind: "conflict",
        reason: `expected-generation-mismatch: live=${newOwnerSub.state.generation} expected=${parsed.toExpectedGeneration}`,
      };
    }

    // Promote the new owner; rotate the surrenderToken.
    newOwnerSub.state.kind = "owner";
    newOwnerSub.state.generation = Math.min(1024, newOwnerSub.state.generation + 1);
    newOwnerSub.state.attaches = Array.from(new Set([...newOwnerSub.state.attaches, "interactive", "resize"]));
    newOwnerSub.state.pausedReason = null;

    const rotated = randomBytes(32).toString("hex");
    terminal.ownerSubscriberId = parsed.toSubscriberId;
    terminal.surrenderToken = rotated;
    terminal.ownerDetachedAt = null;
    writeMeta(worker, `${OWNERSHIP_ROW_META_PREFIX}${parsed.terminalUuid}`, {
      terminalUuid: parsed.terminalUuid,
      ownerSubscriberId: parsed.toSubscriberId,
      surrenderToken: rotated,
      generation: newOwnerSub.state.generation,
      updatedAt: new Date().toISOString(),
    });
    writeMeta(worker, rowKey(parsed.terminalUuid, parsed.toSubscriberId), newOwnerSub.state);

    // Mark every observer as `owner-changed` for one tick (informational).
    for (const [id, observer] of terminal.subscribers.entries()) {
      if (id === parsed.toSubscriberId) continue;
      observer.state.pausedReason = null;
    }
    return { kind: "ok", value: newOwnerSub.state };
  }

  // ── replenishByteCredits ──────────────────────────────────────────────

  async function replenishByteCredits(input: ReplenishByteCreditsInput): Promise<ReplenishResult> {
    const parsed = parseOrThrow(replenishByteCreditsInputSchema, input);
    const terminal = terminals.get(parsed.terminalUuid);
    if (!terminal) return { kind: "not-found", reason: `terminal ${parsed.terminalUuid} not registered` };
    if (terminal.ownerSubscriberId !== parsed.subscriberId) {
      return { kind: "forbidden", reason: "replenish-owner-only" };
    }
    const sub = terminal.subscribers.get(parsed.subscriberId);
    if (!sub) return { kind: "not-found", reason: `subscriber ${parsed.subscriberId} not registered` };
    sub.state.remainingByteCredits = Math.min(2 ** 31,
      sub.state.remainingByteCredits + parsed.bytes);
    if (sub.state.remainingByteCredits > 0) sub.state.pausedReason = null;
    return { kind: "ok", value: { remainingByteCredits: sub.state.remainingByteCredits } };
  }

  // ── enforceOwnershipHandover (D-8) ─────────────────────────────────────

  async function enforceOwnershipHandover(terminalUuid: string): Promise<HandoverResult> {
    const terminal = terminals.get(terminalUuid);
    if (!terminal) return { kind: "not-found", reason: `terminal ${terminalUuid} not registered` };
    if (terminal.ownerSubscriberId !== null) {
      return { kind: "ok", value: { ownerSubscriberId: terminal.ownerSubscriberId } };
    }
    if (terminal.ownerDetachedAt !== null
        && Date.now() - terminal.ownerDetachedAt >= OWNERSHIP_HANDOVER_TIMEOUT_MS) {
      const subscriberIds = [...terminal.subscribers.keys()];
      for (const id of subscriberIds) {
        terminal.subscribers.delete(id);
        deleteMeta(worker, rowKey(terminalUuid, id));
      }
      deleteMeta(worker, `${OWNERSHIP_ROW_META_PREFIX}${terminalUuid}`);
      terminals.delete(terminalUuid);
      writeMeta(worker, `${ABANDONED_ROW_META_PREFIX}${terminalUuid}`, {
        terminalUuid,
        abandonedAt: new Date().toISOString(),
        previousOwnerSubscriberId: null,
        previousObserverCount: subscriberIds.length,
      });
      return { kind: "ok", value: { abandoned: true } };
    }
    return { kind: "ok", value: { ownerSubscriberId: "" } };
  }

  // ── readStatus ────────────────────────────────────────────────────────

  function readStatus(): AttachmentRegistryStatus {
    const list: AttachmentRegistryStatus["terminals"] = [];
    for (const [terminalUuid, terminal] of terminals.entries()) {
      let totalOutstanding = 0;
      let totalCredits = 0;
      for (const sub of terminal.subscribers.values()) {
        totalOutstanding += sub.outstandingBytes;
        totalCredits += sub.state.remainingByteCredits;
      }
      list.push({
        terminalUuid,
        ownerSubscriberId: terminal.ownerSubscriberId,
        observerCount: terminal.subscribers.size - (terminal.ownerSubscriberId ? 1 : 0),
        totalOutstandingBytes: totalOutstanding,
        totalRemainingByteCredits: totalCredits,
      });
    }
    return attachmentRegistryStatusSchema.parse({
      registryId,
      terminals: list,
      limits: {
        defaultByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS,
        highWatermark: HIGH_WATERMARK,
        lowWatermark: LOW_WATERMARK,
        replayBufferBytes: REPLAY_BUFFER_BYTES,
        ownershipHandoverTimeoutMs: OWNERSHIP_HANDOVER_TIMEOUT_MS,
      },
    });
  }

  return {
    registerAttachment,
    unregisterAttachment,
    publishOutput,
    requestResize,
    sendInput,
    acknowledgeOutput,
    transferOwnership,
    replenishByteCredits,
    enforceOwnershipHandover,
    readStatus,
    __debugSnapshot: () => terminals,
  };
}

// ── Re-exports for tests / future IPC ────────────────────────────────────────

export {
  registerAttachmentInputSchema,
  subscriptionStateSchema,
  publishOutputInputSchema,
  requestResizeInputSchema,
  sendInputInputSchema,
  transferOwnershipInputSchema,
  acknowledgeOutputInputSchema,
  unregisterAttachmentInputSchema,
  replenishByteCreditsInputSchema,
  attachmentRegistryStatusSchema,
};
export type {
  RegisterAttachmentInput,
  SubscriptionState,
  PublishOutputInput,
  RequestResizeInput,
  SendInputInput,
  TransferOwnershipInput,
  AcknowledgeOutputInput,
  UnregisterAttachmentInput,
  ReplenishByteCreditsInput,
  AttachmentRegistryStatus,
  SubscriberKind,
  AttachRole,
};
