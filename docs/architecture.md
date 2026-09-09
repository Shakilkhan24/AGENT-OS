# Architecture

## Responsibility boundaries

```mermaid
flowchart LR
  UI[React UI + xterm.js] --> Bridge[Typed preload API]
  Bridge --> IPC[Validated Electron IPC]
  IPC --> Sessions[SessionService]
  Sessions --> Store[Atomic versioned JSON store]
  Sessions --> Engine[TerminalEngine interface]
  Engine --> Tmux[TmuxEngine: private tmux server]
  IPC --> Attach[Disposable PTY client]
  Attach --> Tmux
  Sessions --> FS[SessionFilesystem]
  FS --> Helper[Python descriptor-based file service]
```

Electron supplies the desktop window and native directory chooser. The renderer is sandboxed, context-isolated, has Node integration disabled, and loads only local production assets with a restrictive Content Security Policy. Navigation, new windows, webviews, and permission requests are denied. Every IPC request validates the sender's exact local main-frame URL; payloads are validated before reaching services. The preload exposes named operations, not generic IPC or filesystem primitives. These choices follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [context isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

`SessionService` owns domain state and serializes mutations and reconciliation. `Store` validates a versioned schema and saves using a temporary file, fsync, rename, and directory fsync. State is swapped in memory only after a successful disk commit. Launches write their complete batch intent first, then start processes sequentially. If interrupted, each saved ID is either present in tmux or shown missing. Individual launch failures are recorded while the rest of a batch continues. No command is replayed during recovery. Monotonic snapshot sequence numbers let the renderer reject stale responses; polling never overlaps itself. Engine errors return saved session metadata with unknown terminal status. Deletion uses persisted tombstones, idempotent kills, and durable record removal.

`TerminalEngine` is the only process-management interface. A remote engine can implement this contract later without changing the session store or file panel. The local engine exclusively uses tmux argv calls; there is no interpolated management shell command. A launch command is intentionally user-authored Bash code, passed as one argument to interactive login Bash so normal interactive setup and aliases are available. Presets store the same command data. Each terminal has a dedicated tmux session with a UUID name; a logical project session groups any number of them. This avoids sharing tmux's active-window selection across UI tabs. Empty project sessions remain valid.

tmux owns the PTYs and surviving processes. Its private socket and generated configuration isolate the app from a user's tmux settings. `remain-on-exit` is configured before the first terminal starts, preserving even immediately exiting processes. See tmux's [Getting Started](https://github.com/tmux/tmux/wiki/Getting-Started) and [Advanced Use](https://github.com/tmux/tmux/wiki/Advanced-Use) documentation for lifecycle behavior.

Only the selected terminal gets a disposable tmux client. A small Python PTY bridge supports input, Unicode output, full-screen terminal programs, and window resizing without native Node addons or Electron ABI rebuilds. Closing that client disconnects the view; it does not own the underlying work. xterm.js renders terminal escape sequences and handles input using its [terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/). The renderer acknowledges parsed output, so a fast producer cannot grow the IPC queue without bound. Input uses bounded, sequential acknowledged IPC writes. The Python bridge drains input with nonblocking PTY writes while continuing to read output; it pauses its input pipe when queued data exceeds its high-water mark. Reconnect disposes of only the attachment and retries against the same terminal ID. Inactive terminals generate no renderer traffic, and one tmux inspection reads all process states per refresh. Lazy loading keeps terminal code out of the initial UI bundle.

`SessionFilesystem` runs independently of Electron's main thread. It keeps a descriptor for each session root, validates relative paths, and resolves directory paths with Linux `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)`. All leaf operations use directory descriptors and no-follow flags. Native `renameat2(RENAME_NOREPLACE)` prevents move races that would overwrite an existing destination. Files with multiple hard links, symlinks, devices, and other special files are blocked from opening. Text writes create and sync a sibling temporary inode before replacing the destination. Root device/inode identity is stored and verified when registering after reopen. Linux kernel 5.6+ is required; there is no insecure fallback if kernel containment is unavailable.

On WSL's Windows filesystem, `RENAME_NOREPLACE` is unavailable. The provider exclusively reserves destinations instead: files use link/unlink, and directories use mkdir/rename. Existing destinations still fail without overwriting their content. The file fallback can leave two names after a crash between link and unlink; they are blocked from editing until the extra link is removed. This tradeoff keeps moves available on the user's Windows projects without silently overwriting files.

Before spawning tmux or a terminal client, Python closes inherited nonstandard descriptors. Electron can otherwise leak private sockets into a detached tmux server, preventing an automation or parent process from observing the GUI's complete shutdown. The desktop close/reopen test exercises this boundary.

The renderer separates command entry (`LaunchDialog`), scrollable tabs and fixed add control (`TerminalTabs`), snapshot sequencing (`useWorkspace`), and the attached terminal (`Terminal`). Selected tabs and explorer visibility live in local presentation storage. The existing preset-based launch API delegates to the unified launch operation. Optional failure metadata is compatible with existing version-1 state files.

## Future changes

- Layout state belongs in a renderer/domain presentation model. Process identities already exist independently of rendered tabs.
- Remote sessions can add another `TerminalEngine` and filesystem provider, with a transport identifier added in a schema migration.
- Richer file operations belong in the filesystem provider and typed request schema, keeping containment enforcement centralized.
- Collaboration needs an explicit authorization and ownership model at the service boundary; this local v1 has no multi-user transport.
- Changes to persistent structure require an explicit versioned migration. Do not reinterpret old fields or discard invalid data.

## Failure behavior

- GUI exits or crashes: the disposable attachment closes, and tmux keeps work.
- Backend process disappears: saved terminal becomes missing, and no launch is attempted.
- Command completes: retained tmux pane records output and exit code.
- Engine inspection fails: saved sessions and terminals stay visible with unavailable status; the next poll retries.
- File worker stops: pending operations reject. The next operation starts a fresh worker and re-registers roots with their saved identities. Uncertain mutations are not automatically replayed. Work in tmux is unaffected.
- Directory disappears, becomes inaccessible, or is replaced: the file panel reports the failure rather than silently rebinding it.
- Save fails or JSON is corrupt: preserve existing data, report the error, and avoid launching unrecorded processes.
