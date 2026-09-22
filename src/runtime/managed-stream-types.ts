/**
 * M3c.1 — managed work event stream type whitelist.
 *
 * The renderer-side managed projection surfaces every persisted event
 * whose `type` carries an M3a/M3b semantic. We deliberately *exclude*
 * M2 lifecycle events (`terminal-status`, `terminal-output`, etc.) so the
 * read-only review shell doesn't compete with the xterm stream, and we
 * exclude the importer's `restore.*` audit events so a freshly-restored
 * backup doesn't flood the reviewer with replay history.
 *
 * Adding a new event type is a deliberate, two-sided change: server
 * callers (orchestration, observation) commit a row, the renderer knows
 * how to colour the dot for the new type. Keep the lists in sync with
 * `runStreamEntrySchema`'s `type` enum in `src/shared/managed-view.ts`.
 */
export const MANAGED_STREAM_TYPES = new Set<RunStreamType>([
  "provider.observation",
  "cursor.committed",
  "stop.requested",
  "dispatch.ambiguous",
  "execution.reconciled",
  "runtime.dispatched",
  "runtime.claimed",
  "runtime.spawned",
  "stop.escalated",
]);

export type RunStreamType =
  | "provider.observation"
  | "cursor.committed"
  | "stop.requested"
  | "dispatch.ambiguous"
  | "execution.reconciled"
  | "runtime.dispatched"
  | "runtime.claimed"
  | "runtime.spawned"
  | "stop.escalated";

/**
 * Renderer-side colour hint. Kept server-side so a future M3c.2 verifier
 * UI doesn't need to fork the same palette.
 */
export function colourForStreamType(type: RunStreamType): "blue" | "green" | "orange" | "red" | "yellow" | "slate" {
  switch (type) {
    case "provider.observation": return "blue";
    case "cursor.committed": return "green";
    case "stop.requested": return "orange";
    case "dispatch.ambiguous": return "red";
    case "execution.reconciled": return "yellow";
    case "runtime.dispatched": return "slate";
    case "runtime.claimed": return "slate";
    case "runtime.spawned": return "slate";
    case "stop.escalated": return "orange";
  }
}
