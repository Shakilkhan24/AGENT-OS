# MINIMAL

A desktop home for project sessions, persistent terminals, and project files. Built for Linux and WSL2 with WSLg.

## Run

Prerequisites: Linux kernel 5.6 or newer, a graphical desktop (Wayland/X11 or WSLg), tmux 3.2+, Bash, and Python 3.9+. Development additionally requires Node.js 22.12+ and npm. On Ubuntu, install runtime dependencies with `sudo apt install tmux python3 libgtk-3-0 libnss3 libasound2t64 libgbm1` (older Ubuntu releases use `libasound2`).

```bash
npm ci
npm start
```

Run these commands **inside Linux/WSL**, including when the source folder is on a Windows drive. A native Windows executable is outside this foundation's supported platforms. On WSL2, keep WSL running while your work is running; `wsl --shutdown` ends Linux processes.

To build, smoke-test and publish a self-contained application directory (needs a display and the `flock` command from util-linux):

```bash
npm run package
./release/current-linux-x64/minimal
```

The package includes Electron and compiled application code. It still requires the runtime dependencies listed above. An ARM64 build uses `current-linux-arm64`. No development server, network connection, global Node installation, or npm is needed to run the packaged app. Keep the executable together with its adjacent files. Distribution on Linux filesystems is recommended; WSL's Windows mount can make installation and large executable loading slow.

Packaging keeps immutable builds under `release/builds/` and updates the `current-linux-<arch>` symlink atomically after smoke passes. `npm run package:rollback` selects the retained previous build; it does not roll back user data or make incompatible schemas readable. Existing legacy release directories remain intact. Interrupted staging can be inspected and removed later; published builds are never pruned automatically.

## Use

1. **Create a session** and choose a project folder, using Browse or an absolute Linux path. The sidebar shows its directory, terminal count, and running count.
2. **Launch terminals** opens a command box. Type `codex`, `claude`, `opencode`, `pi`, or any installed command; leave it blank for Bash. Choose a quantity (1–32), optional label, and working subdirectory. You can save the command as a preset directly from this box.
3. **Add or close terminals anytime.** The fixed **+ New terminal** button stays visible as tabs scroll. Every tab has an **×** that stops and removes only that terminal, with bounded graceful escalation. Closing the selected tab selects its neighbour; closing another tab preserves your selection. **Edit & run** opens the current command for editing and launches a new terminal. The pencil renames it.
4. **Launch presets** in the sidebar lets you add, edit, or remove workflows. An empty command starts interactive Bash. For installed tools, a command can be `nvim`, `codex`, `claude`, `npm run dev`, or any Bash command. The tool list is data, not application logic. Long-running commands execute directly; completed commands retain output and exit status.
5. **Explorer** browses the bound project folder. Double-click or select Open to enter folders and open UTF-8 text. Toolbar buttons create files/folders, rename, move, and delete. Move destinations include the filename and are relative to the session root. Text editing supports files up to 2 MiB. Deleting project files requires confirmation and is permanent. Use **Hide explorer** to give the terminal more space.
6. **Close and reopen** freely. tmux owns processes and history independently of the GUI. Switching tabs only attaches a disposable client. The selected tab and explorer visibility are remembered. Deleting a session stops its terminals and keeps project files.

Terminal tabs support Left/Right, Home and End to move focus; Enter activates the focused tab. Dialogs keep focus inside and return it to their opener when closed.

Use Ctrl+C to interrupt a process. Mouse scrolling accesses tmux history. Right-click pastes from the clipboard; Ctrl+Shift+C copies a selection, and Ctrl+Shift+V pastes from the keyboard. xterm handles bracketed paste when the receiving program enables it. Switching tabs cancels unsent input; text already accepted by the previous attachment may still arrive there.

## Persistence and recovery

The app uses Electron's per-user data directory (`~/.config/MINIMAL` on a normal Linux desktop). `MINIMAL_DATA_DIR=/absolute/path` selects an isolated profile for development or testing. `state.json` stores versioned sessions, terminal intents, presets, and directory identities. Keep that profile path unchanged between launches: it determines the private tmux socket.

Running commands, terminal screens, and up to 20,000 history lines per terminal live in a private tmux server under `/tmp/minimal-<uid>/`. Your ordinary tmux sessions and configuration are unaffected. The GUI uses a single-instance lock for each profile.

The main process reconciles saved terminal IDs on startup, terminal exit notifications and a two-second default poll; the renderer refreshes every four seconds. An exited command is shown with its exit code. A terminal that has vanished (for example after reboot) is marked missing; it is **never automatically rerun**. Start a new terminal explicitly when you want new work. This version preserves processes through GUI closure and crashes, not through machine reboot or WSL shutdown.

If a terminal connection drops, **Reconnect** attaches to surviving work without restarting the command. A temporary engine error keeps your sessions visible while status checks retry. If the file helper stops, the next refresh starts it again and revalidates the project folder; interrupted file edits are never automatically replayed.

Launch intents are durably written before process creation. A failure in one launch is recorded on that terminal while the remaining batch continues. Review the failed tab and use **Edit & run** to retry explicitly. Deletion intents are durably written before stopping work and retried after interruption. Corrupt state is copied byte-for-byte to a private `state.recovery-*.backup.json` before an empty workspace opens with a recovery notice. Edits can then proceed without overwriting the recovery copy. A failed backup prevents startup. A newer state schema refuses startup and all writes; open it with a compatible newer release. A directory replaced since it was bound is rejected by the explorer; create a new session for its replacement.

## Boundaries

- Process control lives behind `EngineAdapter`; state, launches, reconciliation and stopping have separate services. `TmuxEngine` is its local implementation. UI code has no shell or Node access.
- The file panel is scoped to the session's pinned directory. Linux `openat2` and descriptor-relative file operations reject traversal, symlinks, magic links, and mounted subtrees. Hard-linked files and special files cannot be opened. Writes replace files atomically, and moves never overwrite destinations. The root cannot be deleted or renamed from the panel.
- The explorer is a **file-access boundary**, not a sandbox for user-launched programs. Shells, editors, and agents have your normal operating-system permissions. Use OS containers or restricted users when you need to isolate arbitrary commands. Like other local tools, MINIMAL trusts its own installed code, profile, and the same OS user; it is not a security boundary against another process running as that user.
- File lists are refreshed by navigation, file actions, or the refresh button. UTF-8 text up to 2 MiB is editable. PNG, JPEG, GIF, and WebP images up to 10 MiB open in the image viewer. Other files open in a read-only preview of their first 1,024 bytes. Directory entries are loaded in pages and rendered as virtual rows. A session supports up to 128 terminals, with 32 per launch.
- Custom tiling, remote sessions, themes, sharing, Git controls, shortcut customization, and cross-machine sync remain extension points.

## Development and verification

```bash
npm run check          # Type checking, real backend tests, production build
npm run test:desktop   # Actual Electron UI and close/reopen checks; needs a display
npm run package       # Stage, smoke and atomically select a verified build
npm run test:package  # Check the package under load with the sandbox enabled
npm run test:runtime  # Isolated packaged headless runtime/storage experiment
npm run test:list     # List recursively discovered backend and desktop cases
```

Tests use temporary profiles, directories, and private tmux sockets. They do not touch your normal sessions. Playwright supplies its own Electron automation launch flags; normal app launches retain Electron's sandbox.

Follow the [implementation checklist](FUTURE/IMPLEMENTATION-README.md) for current progress. M0 adds release/upgrade safety and tested runtime experiments; domain operations still run in Electron until M1.

See the [1.2.1 baseline](docs/build-snapshot-v1.2.1.md), [recovery guide](docs/recovery.md), and [architecture](docs/architecture.md) for extension points and failure behavior, and [verification](docs/verification.md) for requirement coverage.
