# Research record and evidence map

Research date: 2026-09-10. This record supports the [master specification](../README.md) and [architecture contracts](ARCHITECTURE.md). It is a research/design deliverable. No competitor, cloud environment, provider account or application build was provisioned or tested.

## 1. Method and limits

The work is organized into fifteen specialist investigations, with at most three specialists working alongside the integrating agent. The final investigations challenge runtime, security and end-to-end consistency. These are automated research/review passes, not fifteen independent human experts or a representative user study. Agreement between agents does not count as independent corroboration.

The supplied `ins.md` is the only application evidence present in this workspace. There was no source tree, package manifest, Git repository or test fixture to inspect. Its dependency versions, implementation descriptions and verification history remain attributed to that snapshot. Future implementation starts by recovering and checking the actual source.

For external facts, researchers searched and opened the underlying pages. OpenAI-specific interface research used the official documentation search/fetch service. Other research used public web retrieval. The notes identify exact source URLs, sections where useful, access date and any unverified behavior. Search snippets did not override fetched pages. Older posts supply historical experience, not proof of current APIs.

Evidence types are kept distinct:

| Evidence | What it can support | What it cannot establish by itself |
| --- | --- | --- |
| Current official API/specification documentation | Published interface and stated constraints | Account-specific support, tested interoperability, absence of bugs |
| Maintainer repository/product documentation | Claimed features, explicit component license, documented lifecycle | Independent quality, performance, security or customer demand |
| Original engineering/practitioner account | What its authors report experiencing in that setting | Prevalence, controlled causality or universal best practice |
| Primary empirical study | Results under its sampled tasks, participants and methods | Guaranteed gains for MINIMAL or future models |
| Inaccessible post/video metadata | Existence of a discovery lead | Unseen content, demonstrated behavior or endorsement |
| Proposed design/test | A concrete choice to evaluate | An already implemented or validated capability |

Source summaries are deliberately short. Most of the specification is original design reasoning derived from the user's requirements and cross-source constraints. Similar descriptions across products are evidence of category convergence, not of unique demand. No new market-size estimate, revenue forecast, paid conversion result or universal productivity multiplier is asserted.

## 2. Specialist research index

| Pass | Question | Deliverable |
| --- | --- | --- |
| 01 | Which native Codex interfaces can support a desktop management layer? | [Codex integration](research/01-codex.md) |
| 02 | How do Claude Code execution, permissions, resumption and commercial constraints differ? | [Claude Code integration](research/02-claude-code.md) |
| 03 | Which direct competitors already cover the intended surface? | [Product landscape](research/03-product-landscape.md) |
| 04 | What should MCP, ACP, skills and native plugins each own? | [Protocols and extensions](research/04-protocols-extensions.md) |
| 05 | Which workflow/time semantics should be implemented locally or borrowed? | [Workflows and time](research/05-workflows-time.md) |
| 06 | Which environment boundaries and remote lifecycles are real? | [Environments and remote execution](research/06-environments-remote.md) |
| 07 | How can context be selected, inspected, refreshed and handed off? | [Context and practice](research/07-context-practice.md) |
| 08 | How should concurrent code work reach verified integration or deployment? | [Git and DevOps](research/08-git-devops.md) |
| 09 | What do original practitioner and social sources suggest testing? | [Practitioner signals and access limits](research/09-practitioner-signals.md) |
| 10 | How should productivity and reliability claims be evaluated? | [Evaluation and productivity](research/10-evaluation-productivity.md) |
| 11 | How should the interface manage attention, review and accessibility? | [UX and attention](research/11-ux-attention.md) |
| 12 | What could users pay for, and what costs/rights constrain distribution? | [Commercial positioning](research/12-commercial-positioning.md) |
| 13 | Do runtime, storage and migration contracts survive failure? | [Runtime reliability review](research/13-runtime-review.md) |
| 14 | Are security claims enforceable at the actual boundaries? | [Security review](research/14-security-review.md) |
| 15 | Is the master plan coherent, complete and realistically staged? | [Final architecture review](research/15-final-review.md) |

The final review notes record findings on drafts and the integration disposition. A finding remains useful evidence even after the master document is corrected. No research note is a runtime certification.

## 3. Products and execution/workflow options examined

This table contains 25 named products or infrastructure projects. Some are direct competitors, some are components or integration candidates, and two entries are lifecycle case studies. They are not a ranked list. The linked specialist note gives the exact capabilities, qualifications and additional primary pages used.

| # | System | Primary source entry | Design relevance / detailed note |
| --- | --- | --- | --- |
| 1 | OpenAI Codex | [Native non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode) | Existing reasoning agent and native-product baseline; [01](research/01-codex.md) |
| 2 | Claude Code | [Programmatic execution](https://code.claude.com/docs/en/headless) | Second native agent with distinct lifecycle; [02](research/02-claude-code.md) |
| 3 | Superset | [Repository](https://github.com/superset-sh/superset) | Direct workspace/automation comparison; [03](research/03-product-landscape.md) |
| 4 | Conductor.build | [Cloud/local workspace documentation](https://www.conductor.build/docs/cloud) | Local/cloud handoff and shared work; [03](research/03-product-landscape.md) |
| 5 | Vibe Kanban | [Maintainer shutdown notice](https://vibekanban.com/blog/shutdown) | Local/community continuity and commercial lifecycle case; [03](research/03-product-landscape.md) |
| 6 | cmux | [TUI documentation](https://cmux.com/docs/tui) | Persistence, remote terminals and programmable views; [03](research/03-product-landscape.md) |
| 7 | Emdash | [Repository](https://github.com/generalaction/emdash) | Close feature-scope comparison; [03](research/03-product-landscape.md) |
| 8 | Crystal | [Deprecated predecessor repository](https://github.com/stravu/crystal) | Historical parallel-agent workspace case; [03](research/03-product-landscape.md) |
| 9 | Nimbalyst | [Official product site](https://nimbalyst.com/) | Broader agent/visual-workspace comparison; [03](research/03-product-landscape.md) |
| 10 | Cursor Cloud Agents | [Official cloud-agent documentation](https://cursor.com/docs/cloud-agent) | Provider-native hosted execution and evidence; [03](research/03-product-landscape.md) |
| 11 | Warp/Oz | [Official documentation](https://docs.warp.dev/) | Terminal plus automation platform comparison; [03](research/03-product-landscape.md) |
| 12 | Temporal | [Schedule semantics](https://docs.temporal.io/schedule) | Durable scheduling and cancellation lessons; [05](research/05-workflows-time.md) |
| 13 | Trigger.dev | [Wait semantics](https://trigger.dev/docs/wait) | Waits, capacity and idempotency design; [05](research/05-workflows-time.md) |
| 14 | Inngest | [Execution model](https://www.inngest.com/docs/learn/how-functions-are-executed) | Persisted steps and cancellation limits; [05](research/05-workflows-time.md) |
| 15 | Windmill | [Approvals](https://www.windmill.dev/docs/flows/flow_approval) | Human gates and edition-dependent capabilities; [05](research/05-workflows-time.md) |
| 16 | n8n | [Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger) | Recurrence configuration and explicit activation; [05](research/05-workflows-time.md) |
| 17 | Docker | [Rootless mode](https://docs.docker.com/engine/security/rootless/) | Optional existing container boundary; [06](research/06-environments-remote.md) |
| 18 | Podman | [Official manual](https://docs.podman.io/en/latest/markdown/podman.1.html) | Alternative local/remote container adapter; [06](research/06-environments-remote.md) |
| 19 | E2B | [Persistence](https://docs.e2b.dev/sandbox/persistence) | Managed sandbox lifetime and retention; [06](research/06-environments-remote.md) |
| 20 | Daytona | [Sandbox lifecycle](https://www.daytona.io/docs/sandboxes) | Container/VM stop, pause and expiry distinction; [06](research/06-environments-remote.md) |
| 21 | GitHub Codespaces | [Lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle) | Existing remote developer environments; [06](research/06-environments-remote.md) |
| 22 | Tailscale | [SSH documentation](https://tailscale.com/docs/features/tailscale-ssh) | Optional connectivity/access layer; [06](research/06-environments-remote.md) |
| 23 | Firecracker | [Design](https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/design.md) | Stronger VM boundary to integrate later; [06](research/06-environments-remote.md) |
| 24 | Context7 | [Overview](https://context7.com/docs/overview) | Optional version-aware documentation retrieval; [07](research/07-context-practice.md) |
| 25 | Sourcegraph | [Search contexts](https://sourcegraph.com/docs/code-search/working/search-contexts) | Optional multi-repository/revision retrieval; [07](research/07-context-practice.md) |

The research does not select 25 dependencies. Its initial implementation recommendation remains the current desktop foundation, a small durable runtime, a supported storage binding and narrowly tested native-provider adapters. Most catalog entries are comparisons, design references or deferred integrations.

## 4. Protocol, platform and primary-reference ledger

All entries were accessed on 2026-09-10. Links go to primary pages, not search-result pages. Product-specific additional sources are listed in the specialist notes. A page without a reliable publication/update date is dated by access only.

| Reference | Relevant contract / use |
| --- | --- |
| [MCP tools, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | Version-specific discovery and tool contract; [04](research/04-protocols-extensions.md) |
| [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | Authentication revision and resource-bound authority; [04](research/04-protocols-extensions.md) |
| [MCP authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) | Token/issuer/discovery constraints; [04](research/04-protocols-extensions.md) |
| [MCP registry](https://modelcontextprotocol.io/registry/about) | Discovery metadata versus executable provenance; [04](research/04-protocols-extensions.md) |
| [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) | Optional editor/agent interface; [04](research/04-protocols-extensions.md) |
| [Agent Skills](https://agentskills.io/specification) | Instruction package and disclosure conventions; [04](research/04-protocols-extensions.md), [07](research/07-context-practice.md) |
| [AGENTS.md](https://agents.md/) | Repository instruction convention; [07](research/07-context-practice.md) |
| [Dev Containers metadata](https://raw.githubusercontent.com/devcontainers/spec/main/docs/specs/devcontainerjson-reference.md) | Environment setup and host-command considerations; [06](research/06-environments-remote.md) |
| [OpenSSH](https://man.openbsd.org/ssh.1) | Host identity, forwarding and remote-command semantics; [06](research/06-environments-remote.md) |
| [Git worktrees](https://git-scm.com/docs/git-worktree) | Shared repository infrastructure and checkout lifecycle; [08](research/08-git-devops.md) |
| [Git repository layout](https://git-scm.com/docs/gitrepository-layout) | Shared default hooks; [08](research/08-git-devops.md) |
| [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) | Untrusted jobs and privileged promotion; [08](research/08-git-devops.md) |
| [GitHub Actions environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) | Deployment gate semantics; [08](research/08-git-devops.md) |
| [GitHub Actions OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect) | Short-lived credential exchange; [08](research/08-git-devops.md) |
| [Terraform apply](https://developer.hashicorp.com/terraform/cli/commands/apply) | Saved-plan execution and partial effects; [08](research/08-git-devops.md) |
| [SQLite WAL](https://www.sqlite.org/wal.html) | Local-filesystem requirements, one writer, durability and patched engine; [architecture](ARCHITECTURE.md#persistence-choice) |
| [SQLite backup](https://www.sqlite.org/backup.html) | Consistent backup protocol; [architecture](ARCHITECTURE.md#persistence-choice) |
| [Node SQLite](https://nodejs.org/api/sqlite.html) | Binding stability and synchronous execution considerations; [architecture](ARCHITECTURE.md#persistence-choice) |
| [Node child processes](https://nodejs.org/api/child_process.html#optionsdetached) | Independent descriptor/lifetime requirements; [architecture](ARCHITECTURE.md#surviving-gui-and-runtime-failure) |
| [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) | Packaging/runtime assumptions; [architecture](ARCHITECTURE.md#surviving-gui-and-runtime-failure) |
| [WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd) | Host lifetime limits; [06](research/06-environments-remote.md) |
| [tmux formats](https://github.com/tmux/tmux/wiki/Formats) | Version-specific process-metadata formatting; P0 must validate against the supported tmux version |

No recommendation depends on a specific unverified latest dependency version. Pin versions after the actual build/runtime and support matrix are known. In particular, the current specification revision, a provider's installed support, and a stable product contract are separate things.

## 5. Social and practitioner access record

The request explicitly included YouTube, X/Twitter and LinkedIn. The [practitioner note](research/09-practitioner-signals.md) contains the individual attempts and publication-date qualifications.

| Channel | Actual access | How used |
| --- | --- | --- |
| YouTube | Official Codex launch video returned title/footer metadata; no transcript or playable demonstration was examined | Discovery only; no behavioral claims from unseen video |
| X/Twitter | Two original Boris Cherny post URLs returned 403 | Recorded as inaccessible; unseen details excluded |
| LinkedIn | Addy Osmani's original main-post text was publicly readable | Attributed practitioner advice, not demand measurement |
| Original blogs | Author/engineering text from Osmani, Willison, Hashimoto, Zechner and Cursor was readable | Concrete hypotheses and failure modes, bounded to reported experience |

The LinkedIn post and its author's talk write-up are the same underlying material. Multiple posts by one author are not independent corroboration. A high-engagement post or a compelling demonstration does not establish sustained usefulness.

## 6. Decisions traceable to evidence

| Design decision | Main supporting constraints | Where to challenge it |
| --- | --- | --- |
| Preserve native agents | Existing CLI/session capabilities; no custom framework requested | [01](research/01-codex.md), [02](research/02-claude-code.md) |
| Separate runtime ownership from UI | Existing tmux invariant plus workflow/process recovery requirements | [architecture](ARCHITECTURE.md), [13](research/13-runtime-review.md) |
| Narrow the first product | Extensive direct competition; practitioner review/coordination costs | [03](research/03-product-landscape.md), [09](research/09-practitioner-signals.md), [12](research/12-commercial-positioning.md) |
| Versioned adapters/capabilities | Changing native interfaces/protocols and differing semantics | [01](research/01-codex.md), [02](research/02-claude-code.md), [04](research/04-protocols-extensions.md) |
| Explicit unknown/no automatic replay | Side effects outlive acknowledgements, connections and cancellation | [05](research/05-workflows-time.md), [06](research/06-environments-remote.md), [08](research/08-git-devops.md) |
| Evidence-bound review and integration | Shared Git state, changing candidates and deployment gate limits | [08](research/08-git-devops.md), [11](research/11-ux-attention.md) |
| Context receipts with visibility gaps | Provider-native discovery/memory and partial telemetry | [07](research/07-context-practice.md) |
| Local-first storage and ownership | Baseline platform, migration risk and single-user scope | [architecture](ARCHITECTURE.md), [13](research/13-runtime-review.md) |
| Enforced environment claims | Tool/API controls cannot constrain all native shell actions | [04](research/04-protocols-extensions.md), [06](research/06-environments-remote.md), [14](research/14-security-review.md) |
| Measured productivity/paid value | Field results depend on task, workflow and selection; demand is untested | [10](research/10-evaluation-productivity.md), [12](research/12-commercial-positioning.md) |

## 7. Unresolved questions for implementation and validation

- Actual source, shipped runtimes, filesystem behavior and baseline test reproducibility.
- Which native provider/version/authentication path supports the first managed workflow and its required approval behavior.
- Codex app-server production support scope and any richer integration/distribution requirements.
- Enforceability and observability of provider-native descendants, spending limits and dynamically loaded context.
- Native background/session capabilities versus a custom runner: choose based on a bounded failure/reattachment spike.
- Commercial distribution rights, account model, third-party notices and required provider approvals for the concrete product.
- Whether target users value the proposed recovery/review/configuration workflow enough to adopt and pay repeatedly.
- Whether restricted local execution or remote execution earns its additional complexity for the first audience.

These questions do not prevent producing a concrete design. They prevent presenting the proposal as an already proven system or business. The master README places them at specific phase gates.
