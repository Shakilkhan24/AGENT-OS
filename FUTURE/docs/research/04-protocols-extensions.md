# 04 — Protocols, extensions, and the MINIMAL boundary

Research accessed 2026-09-10. These findings use MCP revision 2026-07-28 and the opened ACP v1 documentation. Installed Codex/Claude Code compatibility has not been tested. Product controls below are proposals, not guarantees supplied by those protocols.

MINIMAL should expose a small, typed local management interface to an installed orchestrating CLI. An optional MCP facade can make selected operations available as model tools. Keep this separate from any future ACP adapter for the UI. The baseline remains Electron/React/TypeScript, persistent tmux processes, JSON state, and the scoped Python file helper; the CLI supplies agent reasoning.

## Different contracts

| Mechanism | Documented contract | Proposed MINIMAL use | Limit |
| --- | --- | --- | --- |
| MCP | Model-accessible named tools with schemas. | Selected supervisor/helper operations. | Tool availability does not establish application authority. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) |
| ACP | Client/agent requests, updates, permissions, and capability negotiation. | Optional editor-style interface to a supported agent. | Requires an agent implementation and tested capabilities. [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview) |
| Agent Skills | SKILL.md instructions with optional supporting files. | Versioned task playbooks. | Instruction packaging does not provide process isolation. [Agent Skills specification](https://agentskills.io/specification) |
| Native extensions | Claude plugins can bundle skills, agents, hooks, MCP servers, and other components. | Provider-specific configuration adapter. | A provider package is not automatically portable. [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference) |
| MINIMAL control API | Proposed application contract, not an external standard. | Resource handles, job lifecycle, observations, and scoped changes. | Enforces only operations that pass through it. |

ACP v1 includes agent authentication, permission requests, and optional file/terminal capabilities; session loading is optional. Its client usually provides the user interface. Consequently, adopting ACP does not establish MCP transport compatibility or prove complete control over an agent's independently available tools. This is an architectural inference from the documented interface. [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)

Agent Skills requires name and description metadata; compatibility metadata is descriptive, while allowed-tools remains experimental and implementation-dependent. MINIMAL should inventory these fields without converting them into enforceable grants. [Agent Skills specification](https://agentskills.io/specification)

Claude's documented plugin scopes include user, project, local, and managed; hooks respond to native lifecycle events. Keep these identities in the adapter instead of mapping them to one universal plugin scope or hook vocabulary. [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)

## Protocol and authentication facts

MCP 2026-07-28 defines stdio subprocess streams and Streamable HTTP. Requests carry protocol metadata individually; earlier revisions used connection initialization and permitted server requests. Supporting both requires explicit compatibility behavior. MINIMAL must record the actual supported revision, not infer it from an MCP label. [MCP transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

The current HTTP binding removes protocol sessions and the GET stream endpoint. It uses POST with JSON or request-scoped SSE responses; subscriptions carry ongoing change notifications. Servers must reject invalid Origin values when present; localhost binding and authentication are recommended. A missing Origin is not proof of an authorized caller. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

MCP authorization is optional; its HTTP scheme uses OAuth discovery and resource-bound tokens. Stdio instead obtains credentials from its environment. Client ID Metadata Documents are preferred; dynamic registration is deprecated compatibility support. Clients validate returned issuers before redeeming codes, rejecting a missing issuer when advertised. Resource parameters bind requests; bearer credentials belong in headers, not URLs. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Security requirements include PKCE support verification, S256 when possible, HTTPS authorization endpoints, exact registered redirects, secure token storage, and audience validation. Forwarding an incoming MCP token to an upstream API is forbidden: that API needs its own token. Metadata fetching also creates SSRF concerns. [Authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

Tools may change over time or with authorization. In this revision, list-change notifications require an appropriate subscription. Tool annotations are untrusted unless their server is trusted; servers must validate inputs and apply access controls. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

The official registry hosts discovery metadata, including installation information; package registries host executable artifacts. Namespace authentication establishes publishing ownership, while security scanning belongs to package registries and aggregators. The registry remains preview infrastructure and recommends host consumption through downstream registries. [MCP Registry](https://modelcontextprotocol.io/registry/about)

## Proposed model-facing surface

Use one supervisor interface for the UI and MCP facade. Start with read operations: list authorized workspaces/jobs, obtain capabilities, inspect status, and retrieve bounded output by cursor. Provide opaque IDs, typed results, timestamps, and explicit truncation markers. Let the CLI plan and decide what to request; the supervisor validates the request against stored authority.

Mutation tools should be narrowly shaped: start a job from an approved provider profile, submit task text to a specific job, cancel a job, and request a scoped file patch through the Python helper. A start operation takes a workspace handle, profile handle, task, budget, and request ID. It must not accept unrestricted executable paths, shell commands, environment overrides, or model-invented permission modes. Stable request IDs prevent duplicate starts during retries.

Return a job handle immediately and observe completion separately. Distinguish queued, running, waiting for input, cancelled, failed, and completed states. Acknowledging cancellation means the supervisor accepted the request; only observed process state proves termination. Output is bounded data, including exit status and provenance, never executable configuration. Avoid exposing raw tmux commands or unrestricted terminal keystrokes as management tools.

Use local stdio for the initial MCP facade, connecting to a user-owned supervisor endpoint if needed. Resolve executable, arguments, working directory, and allowed environment from an approved profile. Keep credentials out of JSON state, transcripts, and tool responses; retain secret references only. Remote HTTP support should be a later, explicitly tested option, with HTTPS endpoint policy, constrained discovery/redirect destinations, native login flows where supported, and reviewed scope increases. Do not make MINIMAL a generic OAuth proxy.

Treat tool descriptions, results, prompts, repository text, and skill content as untrusted input. They cannot install extensions, modify grants, change credential destinations, or approve their own effects. Scope output access to the caller's jobs. Cap payloads and redact secrets before persistence or display. File patches require a permitted canonical path and an expected base hash, so stale or redirected writes fail clearly.

## Proposed manifest and native configuration handling

Store an application-owned extension manifest and reference its digest from the proposed control-state database. Record: internal ID; provider and extension kind; source URL/namespace; immutable commit or package version plus artifact digest; dependency digests; native manifest location and hash; installation scope; transport or executable profile; secret references; requested capabilities; approved grant ID; reviewer/time; and compatibility test results. Keep a remote service's claimed version separate from verified artifact identity: a URL cannot pin its deployed code.

Separate discovered, approved, installed, enabled, and active states. Downloading or trusting a namespace must not enable code execution. Updates create a new candidate revision and capability diff; keep the previous approved revision available for rollback. Resolve dependencies before approval, and never silently execute an unpinned latest package because a registry entry suggests it.

The adapter should show source scope, effective value, and provenance while preserving provider-native fields. Inspect and validate configuration using the provider's documented mechanism. For supported edits, preview a scoped diff, compare the source hash before writing, retain a recovery copy, and preserve unrelated/unknown fields. Refuse an edit that cannot be represented safely; expose it as provider-specific. Provider agents should define the exact Codex/Claude paths and precedence rules. Shared SKILL.md syntax does not justify copying hook events, permission settings, subagent definitions, or credential stores between providers.

On tool-list notification, authorization change, reconnect, or cache expiry, refresh discovery and compare a digest of approved names, descriptions, and schemas. Newly introduced or materially changed tools remain unavailable pending review. Pin the approved description/schema snapshot as well as the server identity; a stable name alone is insufficient.

## Proposed grants and recursive delegation

A grant binds a caller to workspace roots, job IDs, provider profiles, operations, argument constraints, expiry, and concurrency/delegation budgets. Children receive an intersection of their parent's remaining authority and the requested subset. They cannot extend expiry, increase depth, broaden paths, or edit the grant store. Track the parent chain; revocation prevents new descendant operations, and cancellation targets the recorded descendants. Already completed external effects cannot be undone by revocation.

These controls cover supervisor/helper-mediated work. A CLI with native shell access can launch processes independently; its internal subagents may inherit capabilities outside MINIMAL's grant model. Do not promise isolation until native restrictions or an OS boundary enforce it and tests demonstrate the result. tmux persistence and a scoped helper alone do not provide that isolation.

## Five acceptance tests

1. **Version and capability matrix:** exercise each supported installed CLI/server pair over the selected transport. Cover older initialization behavior and July 2026 requests where supported. Unsupported ACP capabilities produce explicit unavailable states; they never silently fall back to unrestricted shell execution.
2. **Discovery drift:** change a tool's description/schema, add a tool, and change caller authorization. Discovery refreshes; unapproved definitions cannot execute. Embed grant-expansion instructions in results and skill text; they cannot change authority. Previously approved unaffected tools remain usable.
3. **Transport/authentication:** reject wrong issuer/audience, absent advertised issuer, unsupported PKCE, malicious redirects, invalid Origin, and unauthorized local connections. Capture test traffic and logs to confirm there is no token passthrough or credential leakage.
4. **Delegation boundary:** a child attempts a sibling's files, broader grant, extra descendant, expired operation, and post-revocation call. Each fails at the enforcement point. Repeat through native CLI tools to identify any bypass; a bypass blocks an isolation claim.
5. **Reproducibility and configuration:** reinstall a pinned extension, simulate changed artifacts and concurrent native-config edits, then roll back. Digests detect drift, unrelated settings survive, missing native capabilities are reported, and registry discovery never auto-enables execution.
