# Context engineering and reusable practice

Research and source access date: **2026-09-10**. Scope: eight fetched primary documentation and engineering sources. This note proposes context management around installed Codex or Claude Code; it does not propose another reasoning framework. Provider transport details belong in the provider notes. No service was installed or benchmarked.

## Evidence

These are limited paraphrases of published behavior and engineering experience. The design below is an original MINIMAL proposal, not a claim that the sources establish its effectiveness.

| Primary source | Evidence relevant to MINIMAL |
| --- | --- |
| [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Recommends selective inputs, lightweight references, on-demand exploration and persistent notes. Explains that additional context can reduce retrieval precision; runtime exploration also costs time. Retrieval strategy depends on the task. |
| [Anthropic: effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Reports a web-development experiment using progress files, Git history, explicit feature criteria and verification to bridge sessions. Compaction alone did not reliably preserve progress or prevent premature completion. This is one experimental design, not a universal architecture requirement. |
| [AGENTS.md](https://agents.md/) | Defines plain Markdown repository guidance for build commands, tests and conventions, including nested guidance. Its stated nearest-file convention does not establish identical discovery and resolution in every provider. |
| [Agent Skills specification](https://agentskills.io/specification) | Specifies metadata for discovery, full instructions on activation, and supporting resources loaded as needed. The recommended instruction size is below 5,000 tokens; that recommendation is not an enforced model context limit. |
| [Claude Code: project memory](https://code.claude.com/docs/en/memory) | Distinguishes authored instructions from generated memory. Claude reads CLAUDE.md; AGENTS.md can be imported explicitly. Ancestor instructions concatenate, while nested instructions can load later. Imports load eagerly. Auto memory is local to a machine and shared across worktrees of one repository. Instruction text is not enforced configuration. |
| [Claude Code: security](https://code.claude.com/docs/en/security) | Describes prompt-injection mitigations, permissions, trust checks and sandbox controls, with limitations. Directory listing in a connector catalog is not an audit of that server. Published protections do not establish immunity to malicious content. |
| [Context7: introduction](https://context7.com/docs/overview) | Offers library documentation and examples selected for versions through MCP. This is documented product positioning, not independent evidence that every library version is covered or generated code is correct. |
| [Sourcegraph: search contexts](https://sourcegraph.com/docs/code-search/working/search-contexts) | A search context selects repositories at particular revisions. Private instances support custom contexts. The global default is broader than an individual project's intended scope. |

## Proposed minimal context bundle

Use one immutable manifest and selected artifacts per run, stored through the existing proposed artifact system. Start with ordinary file search and provider-native context handling. An embedding service, separate memory database and automatic repository upload are outside the MVP.

| Bundle component | Required contents |
| --- | --- |
| Intent | Current objective, constraints, acceptance criteria, task revision and reference to applicable grants |
| Workspace | Project/workspace identity, execution root, base commit and dirty-tree fingerprint; relevant dependency versions |
| Sources | Selected paths or URLs, content hashes/revisions, retrieval time, authority category, selection reason and permitted destination |
| Instructions | References and hashes for discovered native instructions and selected skill versions; provider/version and observed loading status |
| Continuation | Last handoff, unfinished work, unresolved decisions and pointers to verification artifacts |
| Accounting | Additional bytes submitted, token estimate with method, exclusions, truncation decisions and known observation gaps |

The receipt separates **selected**, **submitted**, and **provider-confirmed loaded** inputs. A provider's hidden prompts, native memory and later tool reads may be unobservable. Record that limitation instead of claiming a complete transcript of what the model received. Capture later source observations when the tested adapter exposes them.

The fingerprint covers relevant uncommitted files as well as Git HEAD. Hashes identify material; they do not authorize reading, sending or executing it. Secret references can identify required capabilities, but values never belong in the bundle.

## Authority, preservation and freshness

Treat authority and factual reliability separately:

1. Runtime grants, filesystem containment and network rules constrain actions outside the model. No context item expands them.
2. The current user task and applicable native instructions guide work under the provider's documented resolution rules. Preserve their origins; surface conflicting requirements instead of rewriting everything into one purported system prompt.
3. Repository code, test outputs, issue text and retrieved documentation supply evidence. For implementation facts, prefer the actual checkout and dependency version, then matching primary documentation. Generated notes are tentative summaries to check against those sources.

Preserve existing AGENTS.md, CLAUDE.md, provider settings and skills. Avoid copying a provider-owned instruction body into an additional prompt, which can duplicate or change its effect. Make any optional shared-instruction import an inspectable edit. Discovering a script or hook does not authorize executing it. Treat third-party context repositories as imported material with pinned revisions and inspected contents.

Before dispatch or continuation, compare task revision, selected hashes, root identity, lockfiles and grants with the receipt. A change triggers a visible refresh and a new receipt; it does not erase the earlier evidence. For external documentation, store version and retrieval date, define a refresh rule, and report when the requested version is unavailable. Age alone cannot prove correctness.

Do not present worktrees as memory isolation. Show native memory scope where discoverable, and avoid silently copying memories between providers or projects. A recipe requiring isolated memory needs a tested, explicitly configured provider capability.

## Budgets, handoffs and reusable practice

Proposed initial limit: 16 KiB of additional startup text assembled by MINIMAL, with larger artifacts referenced by path. This is a tunable application limit, not a provider context-window or spending guarantee. Reserve space for objective and acceptance criteria first. If required content exceeds the limit, report the conflict and adjust selection; never silently cut instructions. Native instructions, tool results and hidden context require separate accounting, sometimes unavailable.

A handoff records completed changes, remaining work, rationale for consequential decisions, current tree identity, verification commands/results and next safe action. Link evidence rather than copying complete logs. A handoff cannot turn an unverified claim into a passed check, restore a process, reproduce hidden reasoning, or authorize a retry. On continuation, recheck the workspace before relying on it.

Promote repeated, demonstrated procedures into versioned recipes and native skills. Keep a short project context index linking existing architecture decisions, runbooks and examples; avoid maintaining duplicate descriptions of facts recoverable from code. A separate shared context repository is optional: pin its revision, record ownership and licensing, import only selected files, and review updates as changes to recipe inputs. Keep personal corrections project-scoped unless the user chooses broader reuse.

## Optional retrieval services and adoption gate

Context7 is a candidate for recurring dependency-documentation mistakes. Query a library and version without private source text; verify relevant results against the installed dependency. Sourcegraph is a candidate when locating code across many repositories dominates task effort. Require explicit repository/revision scope, suitable access controls and a refresh/deletion policy. Neither belongs in the initial critical path. Service unavailability must permit local exploration or a clear missing-source result.

Before adopting either, collect at least 20 representative tasks with known relevant files or documentation. Compare the same provider/version and task fixtures with local search versus the candidate, using repeated trials for variability. Measure relevant-source coverage, wrong-version results, accepted task completion, human review minutes, retrieval latency, added tokens and service cost. Proposed gate: no observed quality or disclosure regression and at least 20% lower median context-finding time. Treat this small pilot as directional; validate the gain in ordinary use before making the service mandatory.

## Five acceptance tests

1. **Native instructions:** Use nested repository rules, an existing Claude import and provider-specific settings. Verify original file hashes remain unchanged, actual discovery follows the tested provider version, and unobserved inputs are labeled unknown.
2. **Stale context:** Change a branch, an uncommitted relevant file, a lockfile and a task constraint after preparation. Require a new receipt and invalidate affected verification; never show an old pass as evidence for the changed tree.
3. **Injection and secrets:** Put hostile instructions in an issue, retrieved snippet and imported context file, plus canary secrets in excluded paths and logs. Verify no new grants, unauthorized reads/uploads, or secret-bearing receipt/export/telemetry. Exercise real containment; prompt wording alone cannot pass this test.
4. **Continuation:** End a session with one failed check and unfinished work, then continue with the same or another supported provider. Preserve both facts and evidence pointers, revalidate the tree, and do not replay a completed external action or silently import unrelated memory.
5. **Selection and budget:** Use a large repository, irrelevant documents, a missing dependency version and an unavailable retrieval service. Keep startup additions bounded, expose omitted material, retrieve relevant references on demand, and report a failed adoption gate without enabling the service by default.
