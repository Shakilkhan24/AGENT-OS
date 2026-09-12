# Security policy

## Trust model

MINIMAL is a **local desktop tool** that trusts its installed code, the user's profile directory, and the operating-system user that runs it. It is **not** a multi-user boundary, **not** an adversarial-code sandbox, and **not** an isolation layer for user-launched programs.

The implementation enforces several specific boundaries; it does not enforce others. The boundaries it enforces are documented below; the boundaries it does not enforce are listed under "Out of scope."

## Boundaries that are enforced

- **Renderer is sandboxed.** Node integration is disabled, context isolation is enabled, web security is enabled, navigation is denied, new windows and webviews are denied, and permission requests are denied.
- **Local Content Security Policy.** The renderer CSP includes `connect-src 'none'`, blocking all renderer-initiated network connections.
- **Exact main-frame sender validation.** IPC handlers verify the sender is the application's own main frame before processing requests.
- **Payload validation.** Service inputs are validated with Zod. File-worker envelopes and responses are versioned and validated. Electron IPC does not yet have a complete version handshake or validated response envelopes.
- **Private tmux server.** A dedicated tmux configuration and socket live under `/tmp/minimal-<uid>/`. Socket directory ownership and permissions are checked at startup. tmux's mouse-driven context menu (the "Horizontal Split / Vertical Split" overlay) is unbound so right-click is handled by the renderer, not by tmux. Ordinary user tmux sessions and configuration are unaffected.
- **Pinned file-root descriptors.** File operations hold pinned directory descriptors; the file panel rejects root mutation, traversal, symlink escapes, hard-linked files, mounted subtrees, magic links, and FIFO/special files. Linux `openat2` is the underlying primitive on supported kernels.
- **Atomic text replacement.** Editor saves check the opening hash before temp-file replacement. Move/create destination collisions are rejected. Non-cooperating external writers can still race the final hash check and rename.
- **Process spawning via argv.** tmux management operations use an argument array (`python3 helpers/exec_clean.py tmux …`); user-authored launch commands are intentionally executed by Bash.
- **Inherited descriptor cleanup.** Python helpers close inherited nonstandard file descriptors before tmux operations.
- **Expected-hash on save.** File saves carry the opening hash and recheck the path immediately before atomic replacement; external modifications are surfaced rather than silently overwritten.
- **Bounded queues and budgets.** Input, output, and Python-helper queues have explicit byte/string budgets; output pressure pauses reading; input exhaustion rejects the request and surfaces an error.
- **Daily rotating logs with redaction.** Logs are NDJSON and rotate by day. Sensitive payload keys are redacted; this is not a blanket guarantee that all paths or secrets in arbitrary messages are removed.

## Boundaries that are out of scope

- **Shells and agents have OS-user permissions.** A `codex`, `claude`, `bash`, or any other command launched in a terminal runs with the same operating-system permissions as the user running MINIMAL. It can read `~/.ssh`, send network requests, use `sudo` if prompted, or invoke `unshare`/`bubblewrap` if installed.
- **The file panel is a file-access boundary, not a sandbox.** It rejects out-of-root operations from MINIMAL's own code; it does not restrict what a user-launched shell does.
- **Provider authentication is the user's responsibility.** MINIMAL reads the user's installed Codex/Claude CLI; it does not read, store, or manage their credentials. Authentication reuse from third-party CLIs is governed by their terms.
- **Multi-user or adversarial-code isolation is not provided.** Two processes running as the same OS user can read each other's state.
- **Network egress is unrestricted for launched commands.** A command launched inside a terminal can reach any host the OS user can reach.

## Reporting a vulnerability

If you have found a security issue in MINIMAL:

1. **Do not open a public GitHub issue.** Public issues give attackers the same information as defenders.
2. Open a private security advisory through GitHub's [Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) feature for this repository, **or** contact the maintainer through the address on their GitHub profile.

Please include:

- A description of the issue and what boundary you believe was crossed.
- Steps to reproduce, including the Linux distribution and kernel version.
- Whether the issue can be reproduced without elevated OS privileges.

You should expect an acknowledgement within seven days. The maintainer will coordinate disclosure timing with you before any public advisory.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| 1.1.x   | Critical fixes only |
| Earlier  | No        |

The current release is `1.2.1`. Backports to `1.1.x` are considered for boundary violations only; feature work goes onto the next minor version.
