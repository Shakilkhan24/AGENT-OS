# Control protocol

The named `window.minimal` methods are a compatibility facade. `src/shared/protocol.ts` is the operation manifest: Zod request tuples, result shapes, time budgets and versioned request/reply envelopes. API version **1**, file-worker protocol **2**, state schema **2** and application semver are independent contracts.

The preload performs a `hello` handshake before admitting calls. Electron checks the trusted main-frame sender, then `ProtocolDispatcher` validates version, channel, payload, deadline and capacity before invoking a service. The preload validates the reply ID/version and operation-specific result, including the selected file action. Terminal output, exit, resize, byte-credit acknowledgements and workspace refresh hints use validated versioned envelopes too. Malformed incoming signals produce a visible error instead of entering xterm.

Requests carry UUID request and correlation IDs and an absolute deadline. The maximum JSON frame is 32 MiB **encoded UTF-8**, accounting for escaping. Each dispatcher permits at most 128 pending operations and 64 MiB of retained request frames. Ordinary calls have a 30-second budget; file calls allow 125 seconds; batch launches, session deletion and the native directory chooser allow up to ten minutes. These are reply/admission budgets, not a claim that every effect can be interrupted.

Cancellation reaches the file worker and batch coordinator. A batch finishes its current member and cancels later members; it never kills a successfully started terminal as cancellation compensation. A timeout/cancel reply can precede the actual operation settling. That operation keeps its admission allocation and remains part of shutdown draining. Invalid or oversized results after execution return an uncertain outcome. Callers must refresh before deciding whether to retry a mutation; transport code does not retry it automatically.

Concurrent duplicate request IDs are refused. This is not durable exactly-once execution. Semantic launch idempotency remains the coordinator's separate persisted key/digest/TTL mechanism. Correlation IDs appear in structured protocol failures and reach file operations; request arguments, clipboard content and pasted text are excluded from protocol logs.

Committed domain events coalesce into a workspace refresh hint. The renderer refreshes after the hint, shares overlapping refreshes and rejects old snapshot sequences. Four-second polling remains a fallback. This fixes compounded backend/renderer polling delays in displaying terminal exits. The hint is not a durable cursor subscription; snapshot/replay synchronization belongs to M2.

The desktop still owns the services at this increment. Independent runtime ownership, authenticated transport integration and terminal-owned accepted-paste queues are the remaining M1 work. No state migration or active-profile conversion occurs here.
