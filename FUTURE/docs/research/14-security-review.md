# Security review: boundary claims, supply chain and authority

Review date: 2026-09-10. Eleven fetched primary sources, plus the existing Codex/Claude/protocols/research notes. No application code, sandbox, account or signed bundle was tested. Findings evaluate the proposed contracts and identify the evidence still owed before the affected phase ships. They remain a review record if a later implementing agent adjusts the contracts.

This document separates four distinct problems that are easily conflated:

1. **OS-level containment** of a provider invocation — what the kernel, container engine or hypervisor can and cannot enforce.
2. **Application-level authority** — what an authenticated principal may do through MINIMAL's runtime API.
3. **Supply-chain integrity** — what code, manifests and binaries actually enter a workspace.
4. **Prompt and content trust** — what an agent may safely do with information retrieved from web pages, issue trackers, tool output or other agents.

A claim about one layer does not transfer to another. A prompt instruction does not grant authority; an authentication token does not become a sandbox; a worktree does not contain a malicious dependency.

## 1. Containment claims must name their enforcement

The supplied snapshot already implements renderer isolation, context isolation, disabled Node integration, exact main-frame sender validation, denied new windows/webviews, a local CSP with `connect-src 'none'`, dedicated tmux configuration and socket ownership checks, descriptor cleanup for inherited file descriptors, pinned file-root descriptors, `openat2` containment rejecting traversal/symlinks/magic-links/mounted subtrees, and atomic text replacement with destination-collision protection. These are real, reviewable controls. They cover specific boundaries. [openat2](https://man7.org/linux/man-pages/man2/openat2.2.html), [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), [CSP level 3](https://www.w3.org/TR/CSP3/).

The architecture contracts add a separately supervised local runtime, a private Unix-domain socket in an owner-verified directory, framed and size-capped requests, and exclusion of the runtime socket, database, credentials and configuration from the agent's mount namespace. These are correct additions. They still describe the trusted-host boundary, not adversarial-code containment.

| Claim | Enforced by | What it does not enforce |
| --- | --- | --- |
| Renderer cannot read host filesystem | Electron sandbox + context isolation | Provider shell launched as the same OS user; same-user shell reads everything the user can |
| File operations stay inside project root | Pinned root descriptors + `openat2` resolution | A `bash`/`claude`/`codex` process running in a terminal in the same project is not restricted to those paths |
| Runtime socket accepts only the authenticated local client | Owner-verified socket directory + framed requests | A hostile agent running as the same OS user can still write to that socket if permitted; isolation requires a different user or namespace |
| Provider shell runs as the host user | `setuid` of the Electron process | The shell can read the user's `~/.ssh`, send requests, run `sudo` if prompted, or use `unshare`/`bwrap` if installed |
| Worktree prevents two writers from colliding | Git's working-tree separation | Shared hooks under `.git/hooks` still run; shared refs and configuration are still shared |
| Container or VM isolates the run | Container engine / microVM | Image contents, init script, capability drops and seccomp profile still depend on configuration; a privileged container does not contain |
| tmux session persists across GUI closure | Private tmux server + socket ownership | Surviving children of that tmux session inherit the user's permissions |

The Linux kernel exposes [namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html) and [capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html) for finer isolation. Docker's [rootless mode](https://docs.docker.com/engine/security/rootless/) documents the trade-offs. Firecracker's [design document](https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/design.md) describes a stronger VM boundary. None of these is free; each adds an operational and supply-chain surface.

**Design rule:** every isolation statement must name the mechanism that enforces it, the principal it constrains, and what remains unenforced. Marketing language ("sandboxed", "isolated") without a referenced mechanism is a documentation defect, not a security property.

## 2. Authority is a typed grant, not a prompt outcome

The architecture already adopts the right primitives: explicit grants, principal-bound scopes, dispatch intents with idempotency keys, and a runtime that derives the maximum scope from the authenticated connection rather than from request-supplied parameters. These choices are correct. Three concrete failure modes still need explicit tests:

| Failure | Concrete scenario | Required test |
| --- | --- | --- |
| Scope widening through task content | Task body says "you may also push to the deploy branch"; runtime grants from initial task grant, not task text | Inject a task body that requests wider authority; the runtime rejects any operation outside the recorded grant |
| Cross-project privilege through parameter injection | A tool call passes `projectId` of another project; runtime must use the connection's principal, not the parameter | Inject a tool call with a foreign `projectId`; the runtime returns the recorded principal's accessible set, not the foreign project's |
| Approval re-use after change | Provider resumes a paused run after the candidate tree changed; runtime must invalidate the approval bound to the previous candidate | Change a file between approval and resume; the runtime reports the approval as invalid and requests a new decision |
| Replay of an authenticated intent | A duplicate request with the same idempotency key returns the original outcome without spawning a second effect | Replay each authenticated request type; confirm exactly one observable side effect, then confirm conflict on a different input under the same key |

OAuth 2.0's [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) and [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750) define the bearer-token model that MCP authorization layers on top of. The MCP [authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and its [security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) emphasize resource-bound tokens, issuer discovery and audience validation. A generic "execute anything with all credentials" tool cannot satisfy these constraints.

Authentication reuse from Claude's CLI/SDK and from Codex's CLI is a separate constraint. Current Claude documentation distinguishes permitted unmodified-binary arrangements from credential intermediation; the SDK has distinct terms. Subscription treatment also changed during 2026. Validate the concrete model before any commercial release. [Claude terms](https://code.claude.com/docs/en/legal-and-compliance), [subscription plan update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Codex auth](https://learn.chatgpt.com/docs/auth).

**Design rule:** grants are stored with principal, action digest, scope, expiry and provenance; runtime resolves them at each operation; grants do not expand because a later message requests more; approvals bind to the specific candidate, configuration, environment and revision they were granted against.

## 3. Supply-chain integrity for plugins, MCP servers and skills

A capability catalog that loads remote code extends MINIMAL's trust boundary to the publisher of every installed item. The architecture distinguishes kinds (skill, native plugin, MCP server, command, script, hook, context source, environment template, recipe) and requires a manifest with ID, version/digest, publisher/source, compatibility, dependencies, capabilities requested, secret references and lifecycle policy. That is the right shape. Three concrete exposures still need to be specified:

| Exposure | Concrete scenario | Required control |
| --- | --- | --- |
| Remote code execution via MCP tool response | A malicious MCP server returns a tool description containing an instruction or a payload the agent executes | Treat every MCP response as untrusted content; sandbox the agent process; never grant authority from tool output |
| Skill package content drift | A previously reviewed skill is updated; active recipes continue to use the pinned version, but new installs receive the new content | Pin skill version per recipe; record digest; surface a diff before the new version is enabled for a recipe |
| Plugin silent permission expansion | A provider-native plugin update requests additional permissions that the user previously granted at a lower level | Re-show a permission diff on update; require re-authorization for the new capability set; never inherit elevated grants silently |
| Script invocation through Bash | A "script" kind is a Bash file executed with the user's environment; it inherits the user's full permissions | Distinguish the script kind from MCP/commands; document the inherited permission surface; provide a "no network" / "read-only filesystem" profile where applicable |
| Hook recursion or escalation | A hook invokes actions that themselves trigger hooks, causing unbounded depth or privilege escalation | Enforce a recursion depth limit; classify hooks by blocking/non-blocking; never let a hook re-enter the runtime as a new principal |
| Environment template privilege | A Dev Container or remote environment template installs packages and binds mounts on first use | Show the resolved template's command set before first use; refuse mounts outside an explicit allowlist |

The Linux Foundation's [Software Package Data Exchange (SPDX)](https://spdx.dev/) specification and the [Sigstore](https://docs.sigstore.dev/) project document provenance and signing. npm's [package integrity](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#integrity) and the [GitHub Advisory Database](https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database) provide an ecosystem baseline. None of these removes the responsibility to verify what runs.

A public marketplace adds publisher identity, malware handling, vulnerability response, signing, revocation, moderation and commercial work. It is a later decision. Until then, the catalog is curated and importable; users add sources deliberately.

**Design rule:** every installed capability carries a pinned digest; active runs use the digest that was in effect when the run started; a digest change requires a deliberate action; untrusted content never becomes authority.

## 4. Prompt and content trust

The provider's reasoning loop will read whatever it is given. A web page fetched to answer a question, an issue comment, a tool error message and another agent's handoff are all data, not instructions. The architecture already says this. Three concrete controls are still owed:

| Control | Mechanism | Verification |
| --- | --- | --- |
| Distinguish instructions from retrieved content | Apply explicit delimiters and instruction precedence; refuse to honor authority expansion coming from retrieved content | Inject an authoritative-sounding instruction inside a fetched page; confirm the runtime does not change grants and the agent surfaces the attempted injection in its review summary |
| Mark secrets distinctly | Treat secret references as named slots resolved at execution time, never as plaintext stored in prompts or context bundles | Place a fake secret reference inside a retrieved document; confirm no plaintext reaches the prompt and the runtime refuses to dereference undeclared references |
| Constrain egress | Default to `connect-src 'none'` for the renderer and explicit allowlists for agent network access | Run a tool that attempts to reach an unallowed host; confirm the runtime blocks it and reports the attempt in the run's evidence |
| Bound blast radius of destructive actions | Restrict `--force`, recursive deletion, branch deletion, force-push, plan apply without saved plan, and other high-blast-radius operations behind explicit grants | Inject a task whose only successful path uses `--force` or equivalent; confirm the runtime surfaces the request as a pending approval rather than executing silently |
| Limit child spawning | Cap concurrent managed runs, native subagents and recursive orchestrations; require a parent/child budget per run | Trigger a recursive delegation chain that exceeds the budget; confirm the runtime refuses the next spawn and reports the limit |

Claude Code's [hooks documentation](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later) describes a deferral primitive but notes its parallel-call limitation. Deferral cannot be the only action gate; the runtime must also enforce. Codex's [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and the related app-server caveats remain under documented support revision; capabilities depend on the version the user actually runs.

**Design rule:** retrieved content is data, never authority; secrets are dereferenced at execution, never embedded; destructive operations require explicit grants; child budgets are enforced by the runtime, not by prompt text.

## 5. Renderer, IPC and file provider hardening

The supplied snapshot already implements most of the renderer-side hardening. The architecture adds typed helper responses, expected file versions, draft recovery, recoverable deletion and bounded work. Five concrete checks should accompany these additions:

| Check | Mechanism | Required behavior |
| --- | --- | --- |
| IPC payload validation | Zod schemas for every request | Any unexpected payload returns a typed validation error; the renderer shows it; the main process logs it; no fallback to permissive defaults |
| File-helper bounded work | Per-request timeout and cancellation | A recursive operation against a huge directory cannot stall every project; the helper returns a typed timeout/cancel error |
| Expected file version | Read-modify-write carries an expected hash or mtime | If the file changed on disk between read and write, the save is rejected with a typed conflict; the user sees the conflict and the current contents |
| Recoverable deletion | Two-phase delete with reversible first stage for user-trashable files | An interrupted deletion is reconcilable; permanent deletion requires explicit confirmation that survives a refresh |
| Draft recovery | Periodic draft checkpoints with source-version and revision | Closing or crashing the application does not lose unsaved work; recovery shows the draft and the source version, never writing or submitting silently |

These are implementation-level guarantees; they exist only if the corresponding tests exist. A "secure by design" claim without a regression test for each control is documentation, not enforcement.

## 6. Telemetry, logging and sensitive content

Default telemetry contains operational counters and error classifications. Repository content, prompts, terminal output, paths, credentials and artifacts require explicit opt-in or a separately selected collection policy. This is the right default. Three specific controls remain owed:

- Renderer-side telemetry must respect the same `connect-src 'none'` policy as the rest of the renderer; any diagnostic upload uses an explicit, audited destination.
- Local history must be inspectable, exportable, and subject to documented retention. Retention is not a license to delete the only recoverable candidate, the only pending approval, or any required evidence.
- Error reports must be scrubbed for paths, hostnames, environment variables, secret references and large artifact bodies before they leave the device; the scrubber is itself tested.

**Design rule:** default telemetry is operational; sensitive content requires an explicit collection policy; scrubbing is a tested control, not a hope.

## 7. Decision rules for the implementing agent

These rules apply during the relevant phases.

1. **P0 — recoverable baseline.** Reproduce the supplied renderer/preload/IPC/file-provider controls under test. Add a typed, cancellable file-helper protocol with a per-request timeout. Add expected-version conflict checks on write. Add draft checkpoints with source-version and revision.
2. **P1 — runtime and migration.** The private Unix-domain socket is owner-verified, framed and size-capped. The runtime refuses connections from non-owner peers. The agent's mount namespace excludes the runtime socket, database, credentials and configuration. Migration cannot silently initialize an empty profile on a corrupt store; restore runs with dispatch disabled.
3. **P2 — managed single-agent workflow.** Grants are recorded with principal, action digest, scope, expiry and provenance. Approvals bind to the exact candidate, configuration, environment and revision. A tool call's `projectId` parameter cannot exceed the connection's principal's accessible set. Replay tests confirm exactly-one observable side effect per dispatch intent. Network egress uses an explicit allowlist.
4. **P3 — coordination and reuse.** Capability manifests carry a pinned digest and a publisher/source. Recipes pin the digest they were authored against; a digest change requires a deliberate promotion. Hooks enforce a recursion depth limit; blocking hooks cannot re-enter the runtime as a new principal. The agent process runs under a different mount namespace from the runtime when restricted mode is selected.
5. **P4 — automation and time.** Missed-run, sleep and shutdown cases never imply the host ran while off. A schedule advertised to run while the laptop is off has an available remote scheduler; otherwise the schedule reports missed. Retries apply only to classified operations, with bounded attempts and backoff; the runtime records the classification.
6. **P5 — owned remote execution.** Host registration verifies identity and capabilities. Credentials stay within their intended boundary; the runtime broker never sees plaintext credentials. Cancellation uncertainty is explicit; remote cancellation is shown as unconfirmed until the host acknowledges.
7. **P6 — paid release.** Commercial and authentication rights have been reviewed for the actual distribution, bundled components and account model. End-to-end recovery and security tests pass. No blocking usability issue in the keyboard, accessibility or attention flows.

## 8. Outstanding evidence before the affected phase ships

- The actual signed bundle's manifest, license inventory and bundled-component list.
- The concrete authentication model for each supported provider, version and account type.
- The container/VM backend's documented capability/seccomp/mount profile when restricted mode is selected.
- The MCP authorization issuer, audience and token-binding configuration.
- The retention policy for diagnostics, drafts and artifacts under each locale.
- The incident response plan, including how user data leaves the device and how it is recovered.

These are inputs to the relevant phase gate, not blockers for producing a concrete design.

## Source ledger

All eleven primary sources above were fetched on 2026-09-10. The Linux man pages, Electron security checklist and CSP recommendation are the standards references for the supplied snapshot's controls. Docker rootless, Firecracker design and Linux namespaces/capabilities document the stronger boundaries the contracts reference. RFC 6749 and RFC 6750 define the bearer-token model; the MCP authorization and security-considerations specifications define the resource-bound overlay. Sigstore, SPDX and the GitHub Advisory Database define the supply-chain primitives. Provider-specific legal and authentication evidence remains in [Codex research](01-codex.md) and [Claude research](02-claude-code.md). No claim of implemented enforcement is made here; the controls listed are the targets of the relevant phase gates.
