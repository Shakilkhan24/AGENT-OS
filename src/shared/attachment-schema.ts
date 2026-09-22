/**
 * M5.5 — attachment registry schemas.
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
 * The trust model:
 *
 *  - Every `(terminalUuid, subscriberId)` pair carries a monotonic
 *    `generation` counter. The runtime refuses stale
 *    `detach` / `resize` / `input` when the supplied
 *    `expectedGeneration` differs from the live value — the
 *    "stale detach/resize/input cannot control a replacement
 *    attachment" line is enforced by construction.
 *  - Any number of observers may subscribe for output, but exactly
 *    ONE subscriber is the *interactive owner* per terminal at
 *    any time. Only the owner may call `resize`; `input` flows
 *    through the existing `TerminalInputQueue` and the queue is
 *    bound to the current owner. A stale owner detachment cancels
 *    unsubmitted bytes for that owner only.
 *  - Output is fanned out to all subscribers via per-observer
 *    `BudgetedWriter`s. A stalled observer's `BudgetedWriter`
 *    pauses ITS subscription's drain without blocking the others.
 *  - Ownership transfer requires an explicit `surrenderToken`
 *    (SHA-256). Once transferred, the prior owner has its
 *    `surrenderToken` rotated and ALL pending input from that
 *    owner is cancelled.
 *  - Every persisted record carries a SHA-256 `payloadDigest`
 *    computed via `runtime/db/effective-settings.ts:stableStringify`.
 *    Volatile fields (`subscribedAt`, `transferredAt`,
 *    `pausedAt`) are excluded.
 *
 * Storage convention (mirrors M4.6 / M4.7 / M5.2 / M5.3 / M5.4):
 *
 *  - `attachment-subscription:<terminalUuid>:<subscriberId>` →
 *    the subscription state (excludes `subscribedAt` from digest).
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
import { z } from "zod";

const subscriberKindSchema = z.enum(["owner", "observer"]);
export type SubscriberKind = z.infer<typeof subscriberKindSchema>;

const attachRoleSchema = z.enum(["interactive", "resize", "output"]);
export type AttachRole = z.infer<typeof attachRoleSchema>;

export const registerAttachmentInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  kind: subscriberKindSchema,
  attaches: z.array(attachRoleSchema).default(["output"]),
  initialByteCredits: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
  expectedGeneration: z.number().int().min(0).max(1024).default(0),
}).strict();
export type RegisterAttachmentInput = z.input<typeof registerAttachmentInputSchema>;

export const subscriptionStateSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  kind: subscriberKindSchema,
  attaches: z.array(attachRoleSchema),
  generation: z.number().int().min(0).max(1024),
  remainingByteCredits: z.number().int().min(0).max(2 ** 31),
  nextCursor: z.number().int().min(0).max(2 ** 31),
  pausedReason: z.enum(["byte-credit-exhausted", "high-watermark", "owner-changed"]).nullable(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  subscribedAt: z.string().datetime(),
}).strict();
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>;

export const publishOutputInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  data: z.string().min(1).max(2 * 1024 * 1024),
  cursor: z.number().int().min(0).max(2 ** 31),
}).strict();
export type PublishOutputInput = z.input<typeof publishOutputInputSchema>;

export const requestResizeInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  cols: z.number().int().min(1).max(1024),
  rows: z.number().int().min(1).max(1024),
  expectedGeneration: z.number().int().min(0).max(1024),
}).strict();
export type RequestResizeInput = z.input<typeof requestResizeInputSchema>;

export const sendInputInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  data: z.string().min(1).max(4 * 1024 * 1024),
  expectedGeneration: z.number().int().min(0).max(1024),
}).strict();
export type SendInputInput = z.input<typeof sendInputInputSchema>;

export const transferOwnershipInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  fromSubscriberId: z.string().uuid(),
  toSubscriberId: z.string().uuid(),
  surrenderToken: z.string().regex(/^[0-9a-f]{64}$/),
  toExpectedGeneration: z.number().int().min(0).max(1024).default(0),
}).strict();
export type TransferOwnershipInput = z.input<typeof transferOwnershipInputSchema>;

export const acknowledgeOutputInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  bytes: z.number().int().min(1).max(2 * 1024 * 1024),
}).strict();
export type AcknowledgeOutputInput = z.input<typeof acknowledgeOutputInputSchema>;

export const unregisterAttachmentInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  expectedGeneration: z.number().int().min(0).max(1024),
}).strict();
export type UnregisterAttachmentInput = z.input<typeof unregisterAttachmentInputSchema>;

export const replenishByteCreditsInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  subscriberId: z.string().uuid(),
  bytes: z.number().int().min(1).max(2 * 1024 * 1024),
}).strict();
export type ReplenishByteCreditsInput = z.input<typeof replenishByteCreditsInputSchema>;

export const attachmentRegistryStatusSchema = z.object({
  registryId: z.string().uuid(),
  terminals: z.array(z.object({
    terminalUuid: z.string().uuid(),
    ownerSubscriberId: z.string().uuid().nullable(),
    observerCount: z.number().int().min(0).max(1024),
    totalOutstandingBytes: z.number().int().min(0).max(2 ** 31),
    totalRemainingByteCredits: z.number().int().min(0).max(2 ** 31),
  })).max(1024),
  limits: z.object({
    defaultByteCredits: z.number().int().min(1024),
    highWatermark: z.number().int().min(1024),
    lowWatermark: z.number().int().min(1024),
    replayBufferBytes: z.number().int().min(1024),
    ownershipHandoverTimeoutMs: z.number().int().min(1000),
  }),
}).strict();
export type AttachmentRegistryStatus = z.infer<typeof attachmentRegistryStatusSchema>;
