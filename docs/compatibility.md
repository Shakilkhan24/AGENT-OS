# Compatibility matrix

MINIMAL 1.2.3 advertises support for the matrix below. Combinations
outside this matrix may work but are **not** covered by automated
qualification; see [release-notes-1.2.3.md](release-notes-1.2.3.md) for
the explicit unsupported list.

## Architecture

| Architecture | Status | Notes |
|---|---|---|
| `x86_64` (Linux) | **Supported** | CI builds and packaged runtime; `npm run package` produces `release/minimal-linux-x64/`. |
| `aarch64` (Linux) | **Unsupported** | No packaging; the runtime would also need an ARM-built Electron. |
| `x86_64` (macOS) | **Unsupported** | Different Electron build; the bespoke Linux packaging does not produce a macOS artifact. |
| `arm64` (macOS) | **Unsupported** | Same reason. |
| `x86_64` / `aarch64` (Windows native) | **Unsupported** | The runtime relies on Linux-only primitives (private tmux server under `/tmp/minimal-<uid>/`); the desktop facade is Electron, but the runtime + helpers are Linux-shaped. WSL2 is the supported Windows path. |

## Linux distribution

| Distribution | Status | Notes |
|---|---|---|
| Ubuntu 22.04 LTS | **Supported baseline** | CI runs on `ubuntu-latest` (currently 22.04). The desktop packages depend on `libgtk-3-0`, `libnss3`, `libasound2t64`, `libgbm1`, `xvfb` (apt names). |
| Ubuntu 24.04 LTS | **Supported** | Same dependencies; CI runs on `ubuntu-latest` which is 24.04 as of late 2024. |
| Debian 12 (Bookworm) | **Supported** | Same dependency set. |
| Other Debian-family (Pop!_OS, Linux Mint, elementary) | **Likely supported** | Not certified by CI; same apt package names. |
| Fedora / RHEL / Rocky / Alma | **Unsupported** | Different package names; not certified. |
| Arch / Manjaro | **Unsupported** | Not certified. |
| NixOS | **Unsupported** | The `/nix/store` layout breaks the private-tmux-server-under-`/tmp/minimal-<uid>` design. |

## Windows + WSL

| Mode | Status | Notes |
|---|---|---|
| WSL2 with WSLg | **Supported** | The desktop launches inside WSLg's X server; the runtime + helpers run inside the WSL2 Linux distribution. |
| WSL1 | **Unsupported** | WSL1 lacks the WSLg X server and lacks the Linux kernel features Electron 44 expects. |
| Windows native | **Unsupported** | See Architecture table. |

## Filesystem

| Mount | Status | Notes |
|---|---|---|
| `ext4` (native Linux) | **Supported** | The default; full-durability SQLite WAL + fsync, atomic rename, no special casing. |
| `xfs`, `btrfs`, `zfs` | **Untested** | Not certified by CI; *do not* assume `btrfs` CoW behaviour works with the SQLite WAL on a non-default subvolume layout. |
| NTFS (Windows host) | **Supported only for project files** | The M2 schema records that the state lives under `/tmp/minimal-<uid>/`, so the DB and tmux server are always on the WSL2 distribution's native filesystem (typically `ext4` via `lxss`). **State must not** be redirected to a Windows-mount. Project files (the workspaces you edit) may live on NTFS via WSL's `9P` mount — but they are not part of the supported-prefix state. |
| OneDrive / iCloud / Dropbox-synced paths | **Unsupported for state** | Sync conflicts corrupt the recovery copy. Project files may live in a synced folder if you accept the concurrency caveats. |
| FAT32 / exFAT | **Unsupported** | Lacks atomic rename; the backup / restore primitives rely on it. |

See [`docs/recovery.md`](recovery.md) for the broader filesystem
caveats (OneDrive move, hard-link fallback).

## Runtime providers

| Provider | Status | Notes |
|---|---|---|
| `scripted` (deterministic double) | **Supported** | Always available; used by every gate test in `tests/runtime/`. |
| `claude` (live) | **Supported** | `>=1.0.0`; tested against `claude --version` 1.x. The adapter is gated on the `claude` binary being on `PATH`. |
| `codex` (live) | **Supported** | `>=0.50`; same gating on the `codex` binary. |
| Custom adapters (M4 feature) | **Surface only** | The `setAdapterFactory` test seam exists; production adapters are not provided. |

The capability probe reports `{claude, codex, version, featureCount}`;
missing binaries degrade visibly to `{version: null, featureCount: 0}`.

## SQLite

| Mode | Status | Notes |
|---|---|---|
| Built-in `node:sqlite` (Node 22.12+) | **Supported** | Full durability + WAL; required for production. |
| `MemoryDatabase` (dev/test fallback) | **Dev / test only** | Used by every test in `tests/runtime/`; not a production path. |

## Runtime diagnostics

The runtime exposes its compatibility probe at
[`src/release/compatibility-check.ts`](../src/release/compatibility-check.ts).
The probe runs at startup; its output is logged via the
allowlisted-fields diagnostic scrubber (M9.4 territory).

## What this document is **not**

- A live SLAs table. Supported means "automated qualification passes on
  every release cut"; it does not mean a help-desk commitment.
- An exhaustive compatibility list. Distributions outside this table may
  work; please open an issue with your `distro + version` if you would
  like the maintainers to expand the supported matrix.
