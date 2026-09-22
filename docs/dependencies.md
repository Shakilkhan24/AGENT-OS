# Dependencies

This document enumerates the runtime and build dependencies that
MINIMAL 1.2.3 ships against. Each entry lists what the dependency is,
where it is pinned, and what breaks on downgrade.

## Runtime

| Dependency | Version | Where it is pinned | Downgrade failure mode |
|---|---|---|---|
| Node.js | `>=22.12` | [`package.json`](../package.json) `engines.node`; [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) `node-version: "22.12"`. | `node:sqlite` (M2 driver) requires Node 22.12+; below that the runtime falls back to the in-memory `MemoryDatabase` driver used by tests. |
| tmux | whatever the host package manager provides (CI apt: latest) | apt-installed in CI; required by [`helpers/runtime_lock.py`](../helpers/runtime_lock.py). | A missing tmux aborts runtime startup with a typed error in the desktop topbar; the renderer surfaces the missing-binary reason. |
| Python | 3.x (CI apt: `python3`) | apt-installed in CI; required by [`helpers/`](../helpers/). | The helpers (`runtime_lock.py`, `pty_bridge.py`, `file_*`, `fds.py`, `filesystem.py`, `exec_clean.py`) use only the standard library; a missing `python3` is surfaced at runtime start. |
| X11 / WSLg | any | WSL2 + WSLg on Windows; X11 on Linux. | Without a display server, the Electron window cannot open. The M1 socket transport and the runtime are headless-safe; only the renderer needs the display. |
| glibc + libgtk-3-0 + libnss3 + libasound2t64 + libgbm1 + xvfb | any | apt-installed in CI for the Electron runtime. | These are the standard Electron Linux runtime deps; missing any one prevents the packaged binary from launching. |
| `node:sqlite` | built into Node 22.12+ | implicit | The runtime uses the built-in driver. Engines without `node:sqlite` (Node < 22.12) transparently fall back to the `MemoryDatabase` driver — this is a dev/test path, not a production path. See [compatibility.md](compatibility.md). |

## Application (declared in `package.json`)

| Package | Version | Used for |
|---|---|---|
| [`@xterm/xterm`](../package.json) | `^6.0.0` | Terminal renderer in the desktop. |
| [`@xterm/addon-fit`](../package.json) | `^0.11.0` | xterm responsive fit addon. |
| [`lucide-react`](../package.json) | `^1.43.0` | Icon set in the desktop. |
| [`react`](../package.json) | `^19.2.8` | UI framework. |
| [`react-dom`](../package.json) | `^19.2.8` | React renderer. |
| [`zod`](../package.json) | `^4.5.4` | Runtime schema validation. |

## Build / test (declared in `package.json` devDependencies)

| Package | Version | Used for |
|---|---|---|
| [`electron`](../package.json) | `^44.2.0` | Desktop shell. Pinned in CI. |
| [`@playwright/test`](../package.json) | `^1.63.0` | Desktop scenario tests. |
| [`@types/node`](../package.json) | `^26.5.0` | Node type definitions. |
| [`@types/react`](../package.json) | `^19.2.18` | React types. |
| [`@types/react-dom`](../package.json) | `^19.2.7` | React DOM types. |
| [`esbuild`](../package.json) | `^0.28.2` | Main / runtime / preload bundling. |
| [`tsx`](../package.json) | `^4.23.13` | Test runner + dev runner. |
| [`typescript`](../package.json) | `^7.0.2` | Typecheck. |
| [`vite`](../package.json) | `^8.2.2` | Renderer bundling. |

## Where things are pinned (summary)

- `package.json` is the source of truth for JS / TS / Electron deps.
- `package-lock.json` pins transitive JS deps to exact versions.
- `.github/workflows/ci.yml` pins the apt packages used by the headless
  CI runner.
- `helpers/` use only the Python 3 standard library; no `requirements.txt`
  is required.
- The integrity manifest emitted by `scripts/release.mts` records the
  byte-level state of the staged tree at the `retained` phase; see
  [verify-release-integrity](runbooks/verify-release-integrity.md).

## What this document is **not**

- A reproducible-build claim. Two builds from the same commit may
  produce different bytes (esbuild ids, mtimes in the manifest, etc.).
  See the M9.2 disclaimer in [release-notes-1.2.3.md](release-notes-1.2.3.md).
- A signing claim. The release artifact is not signed. The integrity
  manifest detects tampering, not authenticity; a follow-up should
  add GPG or sigstore signing.
