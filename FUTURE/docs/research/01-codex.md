# Codex integration research for MINIMAL

Research date and source access date: **2026-09-10**. This is documentation research and a proposed architecture, not a tested integration. The only supplied application evidence is `ins.md`; MINIMAL's implementation is unavailable in this workspace. Source summaries below deliberately distinguish vendor documentation from decisions for the future product.

The recommended starting point is an installed Codex CLI, a narrow MINIMAL tool bridge, and structured execution for bounded jobs. Add a rich Codex client as a separately gated capability after compatibility and support questions are resolved. Codex remains responsible for reasoning and delegation; MINIMAL owns execution records, authority, resources, and recovery.

## Capability comparison

“Verified” means explicitly documented, not exercised against an account or binary.

| Surface | Evidence status | Proposed use |
| --- | --- | --- |
| Interactive CLI and `exec --json` | Verified [S2] | Terminal fallback and bounded automation |
| TypeScript SDK | Verified [S3] | Optional convenience in the trusted backend |
| Python SDK | Stable release documented [S3] | Evaluate only if its benefits justify another integration runtime |
| App-server | Verified interface; production caveat [S1] | Version-gated local pilot |
| WebSocket and external-token auth | Experimental [S1] | Excluded from the initial product contract |
| Codex exposed through `mcp-server` | Deprecated [S4] | No new dependency |
| MCP tools consumed by Codex | Verified [S5] | MINIMAL's narrow control bridge |
| Provider-native subagents | Verified [S6] | Codex handles delegation |
| Commercial resale or pooled subscription access | Not established | Separate launch decision |

## Fetched primary evidence

All eight pages were fetched from official OpenAI documentation on the access date above. Section names are stable locators when a page contains several relevant anchors. No source was runtime-tested.

**[S1] [Codex App Server](https://learn.chatgpt.com/docs/app-server#connect-a-remote-code-mode-host).** Locators: Connect a remote Code Mode host; Protocol; Message schema; Experimental API opt-in; Approvals; Auth endpoints.

App-server exposes JSON-RPC, default stdio, threads/turns/items, bidirectional approvals, managed login, and account telemetry. Schemas are generated for the installed version. Ungated methods are called stable, yet the remote-host section labels the app-server command and WebSocket transport experimental and unsupported for production, without explicitly exempting stdio. External ChatGPT tokens require experimental opt-in. Token-activity telemetry excludes API-key-only authentication. **Inference:** stable method classification does not establish production support.

**[S2] [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).** Locators: Permissions and safety; Make output machine-readable; Create structured outputs with a schema; Authenticate in automation; Resume a non-interactive session.

`codex exec --json` emits JSONL lifecycle and item events, including completed-turn token usage. A final-response schema and an explicit session ID support structured results and continuation. The default sandbox is read-only. Saved CLI authentication is reused. API keys are the automation default; advanced ChatGPT-managed automation is also documented for trusted environments. Credentials must not reach untrusted repository processes. The deprecated `--full-auto` flag should not appear in new examples. Give these job events their own validated decoder.

**[S3] [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk#typescript-library).** Locators: TypeScript library; Python library; Sandbox presets.

The TypeScript SDK supports starting, continuing, and resuming local threads, and requires server-side Node.js 18+. The Python SDK is documented as a stable release, uses local app-server JSON-RPC, requires Python 3.10+, and ships with a pinned CLI runtime dependency. The guide directs rich custom clients toward app-server. It does not specify TypeScript transport internals; identical transport, approval, or recovery behavior across SDKs is not established. Select the SDK by verified behavior and runtime fit.

**[S4] [Running Codex as an MCP server](https://learn.chatgpt.com/docs/mcp-server#running-codex-as-an-mcp-server).** Locator: Running Codex as an MCP server.

`codex mcp-server` is explicitly deprecated. The page retains the older two-tool integration for existing users and directs new integrations toward app-server. For Claude Code calling Codex, it points to OpenAI's Codex plugin for Claude Code, which uses app-server. Older examples involving the Agents SDK are therefore migration context, not a suitable foundation for this product. The linked plugin itself was not fetched or evaluated in this research.

**[S5] [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp#supported-mcp-features).** Locators: Supported MCP features; Connect Codex to an MCP server; Other configuration options; Plugin-provided MCP servers.

Codex can consume local stdio and Streamable HTTP MCP servers. Configuration can be shared across local clients or scoped to trusted projects. It supports tool allow/deny lists, timeouts, approval settings, and required-server startup failure. Plugin-provided servers have their own configuration ownership. This direction of integration remains supported: MINIMAL supplies tools to Codex. It is distinct from the deprecated command that exposes Codex itself as an MCP server.

**[S6] [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents#availability).** Locators: Availability; Orchestration and thread controls; Approvals and sandbox controls; Global settings.

Current local Codex releases enable native subagents. Direct requests or applicable project/skill instructions initiate delegation. Codex handles spawning, follow-up, waiting, and result collection. Child work consumes additional tokens and inherits sandbox controls; live parent overrides also matter. In non-interactive flows, actions needing fresh approval fail when approval cannot be surfaced. Configurable role instructions do not make the desktop application a new LLM framework. Subagents sharing writable files still need coordination.

**[S7] [Authentication](https://learn.chatgpt.com/docs/auth#openai-authentication).** Locators: OpenAI authentication; Login caching; Credential storage; Enforce a login method or workspace.

Local Codex supports ChatGPT subscription sign-in and API-key access. Each uses different account administration and data-handling settings. Codex manages cached credentials and refreshes active ChatGPT sessions. Storage can use a file, OS credential store, automatic selection, or ephemeral memory. CLI and IDE credentials are shared, so logout has effects beyond one client. Administrators can constrain login method and workspace. The documentation recommends API keys for programmatic CLI workflows and warns against exposing execution in untrusted/public environments.

**[S8] [Pricing](https://learn.chatgpt.com/docs/pricing#what-are-the-usage-limits-for-my-plan).** Locators: What are the usage limits for my plan?; What happens when you hit usage limits?; Where can I see my current usage limits?; What are tokens and credits?

ChatGPT Work and Codex share usage. Consumption depends on model, context, reasoning, tools, retrieval, and caching; message counts are estimates rather than fixed entitlements. Local and cloud work share allowances, and weekly limits can apply. The dashboard reports current limits; API-key execution uses separate usage-based billing. Tokens, credits, and currency are different units. Active work can continue after a limit is reached subject to fair-use constraints, so a local budget cannot assume the service will stop a running task immediately.

## Proposed smallest safe integration

These are MINIMAL design decisions, not promises made by the provider.

Begin with two adapter modes: **interactive terminal** and **structured job**. Preserve the working tmux experience for arbitrary Codex interaction. For structured jobs, give the installed CLI a fixed argument vector, separate stdout/stderr pipes, and a bounded event journal. Capture protocol output directly; terminal screen scraping must never determine semantic completion. Let the existing terminal view remain available for troubleshooting.

Introduce a small durable supervisor independently of Electron's window lifetime. Its journal should record launch intent before process creation, provider identifiers when learned, output references, approval decisions, and terminal outcome. Reopening the window reconciles these records with surviving processes. It must never infer that a missing connection authorizes rerunning a prompt. This is an extension of the snapshot's no-implicit-replay invariant.

Keep identities explicit: a MINIMAL session selects a project, a task describes an outcome, and a run identifies one execution attempt. The adapter stores provider conversation and exchange identifiers separately. Multiple attempts can belong to one task; one conversation can support several attempts. A terminal ID identifies a launch/view resource. Neither a PID nor a conversation ID proves successful delivery of the user's outcome.

The first MCP bridge should expose project inventory, task status, terminal inspection, and bounded artifact reads. Add mutation tools only with explicit authority checks inside MINIMAL. Each call should carry project/run identity, an action identifier, and constraints; the backend validates these independently of agent text. Codex proposes actions and performs its own native delegation. MINIMAL grants capabilities and records their effects. It should not create a second recursive agent hierarchy.

A richer adapter can later implement the same product contract through a pinned local process. Keep provider schemas behind that adapter, retain unfamiliar events for diagnosis, and advertise capabilities by tested version. Do not turn the Python file helper into an agent runtime merely because a Python SDK exists: file containment and provider execution are separate responsibilities. A newer SDK is a candidate for evaluation, not an automatic dependency upgrade.

Make authentication visible as an account mode, never as stored credential text. Start with user-owned local accounts. A job must not silently switch from subscription access to billable API access, change accounts, buy credits, or notify a workspace owner. Provide a resumable blocked state with a concrete reason. Charge for MINIMAL's management value only after the distribution and account model has been reviewed against the applicable terms.

## Five contract acceptance tests

These are required future tests; none was run here.

1. **Event truth.** Feed split JSON records, Unicode boundaries, unfamiliar events, truncated output, failure, and exit-without-result fixtures. The UI must distinguish process exit, provider completion, and validated task outcome. A summary that fails the result contract must not advance dependent work.
2. **Recovery without duplication.** Close the GUI during execution, restart it, and then separately crash the supervisor around launch acknowledgement. The surviving attempt retains its identity. Ambiguous attempts become unknown pending reconciliation; no automatic second execution occurs. Preserve captured evidence after process loss.
3. **Approval scope.** Present concurrent requests from separate work items. Approving one must authorize only its recorded action and scope. Expired, stale, disconnected, or unanswered requests never become approval. Mutating tools must reject out-of-project targets even when the agent requests them confidently.
4. **Authentication and budget boundaries.** Exercise login cancellation, expired credentials, account changes, missing usage fields, quota exhaustion, and a requested spending cap. Redact secrets from logs. Preserve an explicit unknown usage value. Block new work when its budget cannot be authorized; never change billing mode automatically.
5. **Compatibility and dependency failure.** Test every supported runtime version against recorded fixtures and an isolated local project. Unknown versions disable unverified capabilities. A missing required tool bridge prevents the dependent workflow. Verify that the interactive fallback still works, and that provider-native delegation respects MINIMAL's assigned write ownership and total resource budget.

## Open questions and release gates

Resolve app-server's production-support scope directly before advertising a supported managed Codex client. Establish the minimum CLI version, upgrade policy, and authenticated transport expectations. Verify rich child-agent observability and cancellation against that version rather than assuming every native-client feature is public integration API.

Confirm distribution rights, branding, commercial account arrangements, and whether MINIMAL's chosen sign-in presentation needs provider registration. The fetched technical documentation does not settle those legal questions. Decide how credentials and configuration are isolated on each WSL host without breaking the user's existing CLI setup. Finally, measure resource use and recovery behavior with real approved accounts; documentation cannot establish performance, account eligibility, or a reliability service level.
