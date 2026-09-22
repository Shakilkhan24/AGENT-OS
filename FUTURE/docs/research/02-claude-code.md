# Claude Code integration research

Accessed 2026-09-10. Scope: the installed Claude Code CLI as MINIMAL's future orchestrator on Linux/WSL. This is documentation research; no runtime integration, account flow, or contract test was executed.

Recommendation: let the unmodified installed `claude` own planning, tool selection, context management, and delegation. MINIMAL should own dispatch, process supervision, durable records, UI attachment, and approval presentation. Begin with bounded CLI invocations and explicit session IDs. Keep terminal interaction available through the existing tmux architecture. An Agent SDK migration would be a separate integration choice; no custom model/tool loop is needed.

## Capability map

“Documented” means a fetched official page describes the capability, not that the installed version has passed validation. “Unknown” identifies a contract this research did not establish.

| Capability | Status | Evidence and implication |
| --- | --- | --- |
| Headless execution and sessions | Documented | `-p` runs noninteractively; JSON and newline-delimited `stream-json` carry results and session metadata. `--resume <id>` selects a conversation. [Programmatic usage](https://code.claude.com/docs/en/headless) |
| Native background sessions | Documented alternative; not evaluated | CLI commands include `agents --json`, `attach`, `logs`, `stop`, `respawn`, and daemon diagnostics. [CLI reference](https://code.claude.com/docs/en/cli-reference) Background mode and `-p` are incompatible. [Programmatic usage](https://code.claude.com/docs/en/headless) Compare this native lifecycle before implementing overlapping process management. |
| Bidirectional messages | Documented; wire contract unverified | `--input-format stream-json` accepts streamed input; `--replay-user-messages` acknowledges it on matching streamed output. This establishes message transport, not a validated MINIMAL implementation of every control envelope. [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Cancellation and child lifetime | Documented | SIGTERM exits 143, terminates active Bash process trees, and leaves an unfinished turn resumable; SIGINT ends the turn. Background Bash tasks do not survive ordinary headless exit indefinitely. [Programmatic usage](https://code.claude.com/docs/en/headless) |
| CLI permission host | Documented; constrained | `--permission-prompt-tool` routes approvals to an MCP tool. It cannot approve MCP tools marked as requiring user interaction. `--permission-prompts none` denies unresolved prompts; that flag requires v2.1.259+. [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Hooks and durable pauses | Documented; constrained | `PreToolUse` supports inspection, denial, modification, and `defer`; `PermissionRequest` also runs headlessly. Deferral persists one pending call for resumption, but is ignored for parallel tool-call batches. Default transcript cleanup is 30 days. Headless resumption requires permission mode to be supplied again. [Hooks reference](https://code.claude.com/docs/en/hooks) |
| Plugins and MCP | Documented | CLI flags include `--plugin-dir`, `--mcp-config`, and `--agents`. [CLI reference](https://code.claude.com/docs/en/cli-reference) Plugins package skills, agents, hooks, and MCP servers. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| Native subagents | Documented | Subagents have separate context and configurable tools/permissions. Custom and general-purpose agents can retain resumable identities; Explore and Plan are one-shot. Native `SendMessage` can resume eligible subagents without enabling teams. [Subagents](https://code.claude.com/docs/en/sub-agents) |
| Agent teams | Experimental | Opt-in teams provide a lead, shared work, messaging, and optional tmux panes. In-process teammates do not return with session resumption; task status and shutdown have limitations. Exclude teams from the initial durability guarantee. [Agent teams](https://code.claude.com/docs/en/agent-teams) |
| CLI versus Agent SDK | Documented distinction | The Python/TypeScript Agent SDK exposes Claude Code's agent loop as a library. The Client SDK exposes API calls and leaves the loop to the developer. CLI subprocess operation is explicitly documented. [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| Rich approval callbacks | SDK capability | `canUseTool` handles questions and permission requests, waits for an answer, and can remain pending indefinitely. Earlier automatic approvals bypass it; `PreToolUse` is the interception point for every tool call. These are library contracts, not ordinary CLI flags. [Approval/input guide](https://code.claude.com/docs/en/agent-sdk/user-input) |
| Live reattachment and delivery guarantees | Unknown | This review did not establish a stable raw control protocol, late attachment to another process's existing pipes, or exactly-once filesystem effects. MINIMAL must supply and validate its own delivery/recovery semantics. |
| Terminal scraping | Unsupported integration assumption | No examined source defines ANSI output, spinner text, prompt wording, or injected keystrokes as a machine control contract. Treat the terminal as a human interface; use documented machine output for automation. |

## Initial adapter boundary

Use a small supervisor outside the renderer to own each CLI's pipes and process identity. Persist an application request ID, provider session ID, project root, configuration fingerprint, last received event position, pending decision, exit information, and recovery state. Serialize dispatch per session. Renderer reconnects should replay the supervisor's journal, not resubmit the prompt. An absent final result should become an uncertain run requiring reconciliation.

Start with one request per invocation, structured output, explicit session resumption, conservative permissions, and user-visible denials. Add streaming input only after its message/ordering tests pass. A queued instruction, an approval response, and process cancellation must remain distinct operations. Do not try to drive an interactive tmux client and headless client concurrently against one conversation.

Native hooks or an explicitly configured local MCP tool can later connect approvals to MINIMAL. Bind each approval to the session, exact tool input, and current request; a reconnect or duplicate answer must not authorize a different call. Keep the scoped Python file helper scoped: any broader process control belongs in a separately defined supervisor interface. A plugin may distribute native configuration; it does not provide MINIMAL's durable queue or permissions ledger.

For configuration, ordinary `-p` can run repository hooks/MCP without a trust prompt. `--bare` avoids automatic configuration discovery but also skips subscription OAuth/keychain authentication. [Programmatic usage](https://code.claude.com/docs/en/headless) Consequently, do not silently apply bare mode to a subscription-backed session. Record the chosen authentication/configuration mode and validate it before claiming isolation.

Deferral is useful for an asynchronous question, but cannot be the sole action gate because of the batch limitation above. Preserve separate permission enforcement. Likewise, conversation resumption is not rollback: reconcile observable artifacts before retrying a possibly completed action. Long-running application services should have explicit tmux ownership and lifecycle records independent of a model turn.

## Subscription and commercial product gate

A subscription must not be presumed to authorize every commercial integration. The current legal page permits products to run an unmodified binary under stated conditions: applicable Commercial Terms, preserved authentication choices, direct end-user authentication/billing, and no usage resale/intermediation. It prohibits a product's own Claude.ai sign-in flow and collecting, storing, or intermediating account credentials/tokens; it expressly preserves users signing into the unmodified binary, including hosted arrangements. [Legal/compliance: product hosting and credential use](https://code.claude.com/docs/en/legal-and-compliance)

The SDK overview separately directs third-party products toward API authentication and says offering Claude.ai login/rate limits needs prior approval. [SDK overview: Get started](https://code.claude.com/docs/en/agent-sdk/overview) These statements should not be collapsed into either blanket prohibition or blanket permission. Resolve MINIMAL's distribution and billing model against the applicable terms before a commercial release. This is an unresolved product gate, not a legal conclusion.

The official help article's June 15 update paused the proposed separate SDK monthly credit: it says SDK, `claude -p`, and third-party app usage still draw from subscription limits for now. Older material remains below the update for historical reference. Do not promise the superseded credit or permanent inclusion. [Claude plan update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

## Five contract tests before implementation acceptance

1. **Transport and completion:** split JSON records across reads, include Unicode, unknown events, stderr, startup events, slow consumers, and truncated output. Require a defensible final state; visible prose alone cannot complete a task. Exercise authentication failure and exhausted limits.
2. **Attachment and recovery:** close/reopen the renderer, then separately terminate the supervisor and CLI mid-action. Recover only the intended session in the intended project. Demonstrate that no reconnect silently duplicates a side effect and unrelated tmux panes stay alive.
3. **Approval correctness:** allow, deny, cancel, disconnect, and replay the same decision. Exercise a deferred single call and a batch where deferral is ignored. Prove independent permissions still block the forbidden operation and stale approvals cannot match changed input.
4. **Version/configuration compatibility:** run a disposable fixture with missing MCP tools, unexpected hooks, unsupported flags, and each supported authentication mode. Verify actual capabilities, effective policy, and failures before dispatch. Ensure diagnostics never expose credentials.
5. **Delegation lifecycle:** observe custom subagent identity and parent correlation through completion/resumption; distinguish partial work from completion. If teams are later enabled, test teammate loss and cleanup explicitly before advertising recoverability.

## Open questions

- Is MINIMAL a local companion to an independently installed CLI, a distributor, or hosted infrastructure? Which commercial agreement and end-user billing flow applies?
- Which installed versions and authentication modes will be supported, and who verifies changes to subscription treatment before release?
- Is a bounded CLI driver sufficient, or is an official Agent SDK adapter explicitly acceptable for richer live controls?
- What retention policy, recovery authority, and action reconciliation rules apply when provider transcripts disappear or an interrupted command may already have changed external state?

## Fetched primary sources

All accessed 2026-09-10. Citations above identify the relevant facts; section names below make rechecking straightforward. Search snippets were not treated as evidence. The platform SDK overview URL redirected to the Claude Code documentation.

| Source | Sections checked |
| --- | --- |
| [Programmatic usage](https://code.claude.com/docs/en/headless) | Basic usage; bare mode; background tasks; SIGTERM; structured/streaming output; permissions; continuation |
| [CLI reference](https://code.claude.com/docs/en/cli-reference) | CLI commands and CLI flags |
| [Hooks reference](https://code.claude.com/docs/en/hooks) | PreToolUse decisions; defer a tool call; PermissionRequest |
| [Subagents](https://code.claude.com/docs/en/sub-agents) | Foreground/background; startup context; resume subagents |
| [Agent teams](https://code.claude.com/docs/en/agent-teams) | Enable teams; display modes; limitations |
| [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | Compare tools; capabilities; Get started; license and terms |
| [Approval/input guide](https://code.claude.com/docs/en/agent-sdk/user-input) | Detect input; tool approval; streaming input |
| [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | Product hosting; authentication and credential use |
| [Claude plan update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) | June 15 update, dated June 16, 2026 |
