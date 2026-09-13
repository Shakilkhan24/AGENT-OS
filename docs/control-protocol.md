# Control protocol

The named `window.minimal` methods are a compatibility facade. `src/shared/protocol.ts` is the operation manifest: Zod request tuples, result shapes, time budgets and versioned request/reply envelopes. API version **1**, file-worker protocol **2**, state schema **2** and application semver are independent contracts.

The preload performs a `hello` handshake before admitting calls. Electron checks the trusted main-frame sender, then `ProtocolDispatcher` validates version, channel, payload, deadline and capacity before invoking a service. The preload validates the reply ID/version and operation-specific result, including the selected file action. Terminal output, exit, resize, byte-credit acknowledgements and workspace refresh hints use validated versioned envelopes too. Malformed incoming signals produce a visible error instead of entering xterm.

Requests carry UUID request and correlation IDs and an absolute deadline. The maximum JSON frame is 32 MiB **encoded UTF-8**, accounting for escaping. Each dispatcher permits at most 128 pending operations and 64 MiB of retained request frames. Ordinary calls have a 30-second budget; file calls allow 125 seconds; batch launches, session deletion and the native directory chooser allow up to ten minutes. These are reply/admission budgets, not a claim that every effect can be interrupted.

Cancellation reaches the file worker and batch coordinator. A batch finishes its current member and cancels later members; it never kills a successfully started terminal as cancellation compensation. A timeout/cancel reply can precede the actual operation settling. That operation keeps its admission allocation and remains part of shutdown draining. Invalid or oversized results after execution return an uncertain outcome. Callers must refresh before deciding whether to retry a mutation; transport code does not retry it automatically.

Concurrent duplicate request IDs are refused. This is not durable exactly-once execution. Semantic launch idempotency remains the coordinator's separate persisted key/digest/TTL mechanism. Correlation IDs appear in structured protocol failures and reach file operations; request arguments, clipboard content and pasted text are excluded from protocol logs.

Committed domain events coalesce into a workspace refresh hint. The renderer refreshes after the hint, shares overlapping refreshes and rejects old snapshot sequences. Four-second polling remains a fallback. This fixes compounded backend/renderer polling delays in displaying terminal exits. The hint is not a durable cursor subscription; snapshot/replay synchronization belongs to M2.

The desktop still owns the services at this increment. Independent runtime ownership, authenticated transport integration and terminal-owned accepted-paste queues are the remaining M1 work. No state migration or active-profile conversion occurs here.

## Local runtime transport

`src/runtime/control-server.ts` and `control-client.ts` carry the same manifest over a Unix socket. Frames are a four-byte big-endian length followed by UTF-8 JSON. The decoder validates the length before allocating a single bounded body and rejects malformed UTF-8, invalid JSON and torn streams. Partial frames expire after five seconds. Completing a frame starts a fresh deadline for any following partial frame, including when both share one socket chunk; a peer cannot renew the deadline just by dripping bytes.

Authentication has a three-second deadline and a 64 KiB frame limit. A private profile key and random 256-bit token select a server-assigned desktop principal; operation payloads cannot supply a different principal. The listener checks that its immediate parent is an owned private directory, creates a mode-0600 socket and never unlinks an existing socket. There are at most eight peers, including disconnected peers whose accepted work is still draining. Each connection owns its dispatcher, so request IDs and cancellation on one connection cannot affect another. Outbound buffers have a byte cap; a stalled peer is disconnected without an unbounded application queue.

Successful authentication reports runtime incarnation and application version. Replies/signals are validated by the client before delivery. The client never reconnects and resends a request automatically: a missing reply may mean the mutation already happened. Closing the server stops admission and drains accepted operations; drain failures remain visible.

This is a local same-user transport, not a sandbox or remote/multi-user authentication service. It does not claim OS peer-credential inspection. Production integration still needs the verified profile-lock launcher, validation of all parent paths, protected token publication and upgrade fencing. The module's caller must own that lock before exposing a real profile. Tests use disposable profiles; no production socket or daemon is enabled by this increment.
