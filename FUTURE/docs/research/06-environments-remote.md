# Execution environments and remote continuity

Research date: 2026-09-10. Proposed architecture, based on the [supplied MINIMAL snapshot](../../ins.md). All ten linked primary sources were fetched on 2026-09-10. Evidence below describes documented capabilities; recommendations and acceptance gates are design proposals. No environment was provisioned or benchmarked.

## Decision

Start with trusted local Linux execution, retaining tmux ownership and the scoped Python file provider. Support the existing WSL2/WSLg baseline. Add an existing Linux host reached through authenticated SSH as the first remote option. Keep one authority host per run, with execution and scheduling owned there. The desktop becomes a client of that host.

MINIMAL should implement environment identity, capability discovery, lifecycle reconciliation, admission limits and artifact ownership. Integrate existing container engines, environment specifications and remote services. Building a cloud control plane or hypervisor is outside this foundation. Revisit managed environments when an actual requirement demands disposable capacity, stronger isolation or operation while the laptop is off.

## Capability evidence and fit

These eight options occupy different layers; a recipe, transport and execution boundary are not interchangeable.

| Option | Documented capability that affects MINIMAL | Recommended role |
| --- | --- | --- |
| Dev Containers specification | Describes environment configuration, mounts and lifecycle commands. `initializeCommand` executes on the host and may repeat. `shutdownAction` can stop containers when a tool closes. [Metadata specification](https://raw.githubusercontent.com/devcontainers/spec/main/docs/specs/devcontainerjson-reference.md) | Integrate a compatible implementation later. Inspect effective configuration and choose persistence behavior explicitly. A specification does not enforce a security policy. |
| Docker rootless | Both daemon and containers run without host root in a user namespace; subordinate UID/GID ranges and mapping helpers are prerequisites. [Rootless mode](https://docs.docker.com/engine/security/rootless/) | First optional local container adapter. Probe the actual engine context, mounts and quota enforcement before advertising restrictions. |
| Podman | Provides a daemonless engine, rootless user namespaces and remote access using SSH or Unix sockets. Its documentation identifies rootless filesystem and networking prerequisites. [Podman manual](https://docs.podman.io/en/latest/markdown/podman.1.html) | Alternative engine after the same lifecycle and containment tests pass. Do not assume complete Docker compatibility. |
| E2B | Pause normally retains disk and memory; paused sandboxes have no automatic deletion. Timeout defaults to termination. Configured auto-pause can fall back to filesystem-only preservation during the documented snapshot backlog case. Clients reconnect after resume. [Sandbox persistence](https://docs.e2b.dev/sandbox/persistence) | Later integration for managed jobs. Record actual resume semantics and explicit deletion responsibility; indefinite retention is separate from continuous runtime limits. |
| Daytona | Container stop preserves files but clears memory; memory-preserving pause is for VM sandboxes. Auto-stop can trigger despite running internal processes. Wall-clock TTL destroys a sandbox in any state. [Sandbox lifecycle](https://www.daytona.io/docs/sandboxes) | Later integration where its environment classes and lifecycle controls meet a concrete need. Record sandbox class and every active timer. |
| GitHub Codespaces | Disconnecting from an active codespace preserves processes. Stop retains project changes; stopped storage remains chargeable. Inactive deletion defaults to 30 days and is configurable. [Codespace lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle) | Optional existing developer workspace. Inspect inactivity and retention policies before assigning unattended work. Do not assume it is an always-running scheduler. |
| OpenSSH with optional Tailscale | SSH encrypts transport and checks host identity. Agent forwarding permits remote use of loaded identities. [OpenSSH manual](https://man.openbsd.org/ssh.1) Tailscale SSH requires network and SSH access rules and leaves ordinary SSH configuration intact. [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) | Preferred first remote path to a user-controlled Linux host. Tailscale is optional connectivity/access integration, not process persistence or guest isolation. |
| Firecracker | Provides a KVM microVM boundary with additional process confinement; production guidance uses its jailer. Host networking and egress filtering remain operator responsibilities. [Firecracker design](https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/design.md) | Defer operating it directly. Prefer an established VM-backed service if adversarial execution becomes a requirement. |

## Boundaries and operational contract

A worktree separates checkout contents and reduces concurrent edit conflicts; it shares repository infrastructure and the operating-system user's authority. A process group organizes signal delivery, while tmux preserves a terminal across client disconnection. Neither restricts filesystem or network access. The snapshot already identifies escaped/daemonized children as outside complete terminal cleanup.

Ordinary containers share the host kernel. Rootless operation reduces privilege but does not make exposed host files or control sockets harmless. A VM adds a guest-kernel boundary; its host configuration and exposed channels still matter. The current explorer's containment applies only to its file API. Shells and installed agent CLIs retain their execution environment's permissions.

Implement a narrow environment contract: discover, prepare, inspect, attach, stop and destroy. Advertise pause/resume only when supported. Return separate capabilities for filesystem retention, memory retention, process termination, network restrictions and resource enforcement. Store environment/provider IDs, authority host, generation, boot identity, workspace identity, execution ID, expiry policy and last acknowledged event cursor. Never collapse stopped, paused, disconnected, expired and deleted into one status.

For SSH, use a fixed installed helper or subsystem and bounded, versioned request frames over stdio. OpenSSH joins command arguments into a remote command line, so local argv separation alone does not protect arbitrary remote arguments. [Command execution semantics](https://man.openbsd.org/ssh.1) Keep commands and paths in the framed payload. Verify host identity; protect the host runtime's local socket and allow only one runtime owner. No public unauthenticated MINIMAL daemon. Disable agent forwarding by default.

After a partition, inspect the same environment and execution ID, then continue from the event cursor. Reattach to surviving tmux work without invoking its command again. A missing process, expired sandbox or changed boot identity becomes an interrupted/unknown outcome; replay creates a separately recorded run. A cancellation remains unconfirmed until the authority host reports its result. Losing a connection never transfers ownership to the laptop. Host scheduling is required for work that must proceed with the desktop off.

Run the scoped file provider beside the remote workspace, retaining root-identity validation and containment. Discover required kernel capabilities there; refuse unsupported contained operations. Avoid treating a remote path as a local mounted directory with equivalent behavior.

Treat build recipes, features and setup scripts as executable dependencies. Inspect inherited configuration, pin artifacts where supported, and bind authorization to effective hooks, mounts and privileges. Apply deadlines to setup. Host initialization hooks deserve the same review as other host commands; they are not inherently one-time actions.

Keep provider login owned by the installed CLI in its chosen environment; do not copy authentication directories into images. Store secret references, not values, in environment records. Default-deny exposure of unrestricted home directories, SSH agents, credential stores, container-engine sockets and MINIMAL control sockets to untrusted guests. Use separately scoped credentials when remote work requires them.

Declare networking as unmanaged, denied or explicitly restricted according to tested enforcement. Enforce restrictions outside the guest where feasible, including DNS, IPv6, private/metadata destinations and exposed preview ports. A recipe flag, VPN connection or VM boundary alone is insufficient evidence. Permitted agent endpoints must be compatible with the selected network policy.

Track CPU, memory, process count, disk and wall-time limits separately from provider quotas and money estimates. Maintain an inventory of runtime-owned remote IDs, owner labels, retained artifacts and expiry policies. Stop, archive and delete are distinct operations. Cleanup must reconcile actual remote resources after reconnect, retry failed deletion visibly, and target only owned IDs. Export required artifacts before an approved retention policy removes them; never use global pruning. Report usage freshness and unknown amounts. Verify plan limits, regional availability, storage/compute charges and deletion behavior before enabling any paid integration; no price estimate is established here.

## WSL constraints

Microsoft documents systemd support requirements and explicitly states that systemd services do not keep a WSL instance alive. [WSL systemd guidance](https://learn.microsoft.com/en-us/windows/wsl/systemd) Therefore, service installation alone cannot justify an always-on scheduling claim. Treat WSL shutdown and host reboot as execution loss, consistent with the supplied snapshot. Record the actual WSL/kernel versions and filesystem in acceptance evidence. Test Windows-mounted workspaces separately because the baseline reports different move fallbacks there; make no blanket compatibility claim for another distro or mount.

## Acceptance tests

1. Start a command with a unique side-effect marker, close the GUI, sever SSH and reconnect. The execution ID and surviving process are unchanged; the marker occurs once. Lost cancellation acknowledgements remain visibly unconfirmed.
2. Terminate the host/WSL instance; separately stop, pause and expire supported remote environments. Confirm the declared file/memory outcomes, stale boot detection and no automatic command replay. Unsupported pause is rejected explicitly.
3. From an untrusted fixture, attempt host-home access, runtime/engine socket access, privilege escalation and forbidden network destinations. Verify actual denial for advertised restrictions; confirm trusted-host execution makes no containment promise.
4. Import a fixture with a host initialization hook, privileged settings and credential mounts. Preparation cannot execute unapproved powers. Change its digest and verify earlier authorization does not silently cover the change.
5. Exhaust a configured resource limit and disconnect during cleanup. Admission stops appropriately; reconnection finds owned orphan resources, preserves required artifacts and reports deletion failures. Unrelated environments and project directories survive.

Open questions: actual host supervision/cgroup support, remote file-provider compatibility, installed CLI authentication under headless use, provider event retention, pause fallback detection and account-specific quotas. Resolve through scoped integration trials after this research phase; documentation alone does not establish those guarantees.
