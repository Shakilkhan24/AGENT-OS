# Project: Desktop Session & Terminal Manager (v1 — Foundation)

## Intent
Build a desktop application that replaces manual tmux usage with a GUI:
managing sessions, terminals within sessions, and the filesystem tied to
each session — all through clicks instead of typed commands. This is the
foundational version; it will be extended significantly in later phases,
so prioritize a clean, stable, extensible architecture over feature count.

## Core requirements (what the app must do)

1. **Sessions**
   - Create a session bound to a specific working directory
   - List active sessions with enough metadata to identify them at a glance
     (name, directory, number of terminals)
   - Switch between sessions without losing their running state
   - Rename and delete sessions

2. **Terminals within a session**
   - Add or remove terminals on demand (a simple +/- interaction)
   - Each terminal is independently addressable: its own working directory,
     its own running process, its own label/status
   - Support quick-launching common workflows in a terminal (e.g. opening an
     editor, starting a coding agent, or a plain shell) via configurable
     presets — don't hardcode the list of tools, make it easy to add more
   - Support bulk-creating multiple terminals at once (e.g. "spin up N
     coding sessions in one click"), each auto-labeled and running a
     configured command

3. **Filesystem**
   - Browse and manage the working directory tied to each session (view,
     open, create, rename, delete, move files/folders)
   - Filesystem access should be scoped to whatever directory the session
     is bound to — no unbounded access to the whole machine

4. **Persistence & resilience**
   - Sessions and their terminals should survive the app being closed and
     reopened — closing the GUI should not kill running work
   - On relaunch, the app should reconcile with whatever is actually still
     running rather than blindly recreating state

## Non-negotiable constraints
- **Stability and auditability over cleverness**: however sessions/terminals
  are managed under the hood, route that control through a single,
  well-defined internal interface rather than scattering ad-hoc calls
  throughout the codebase. This matters more than which specific
  mechanism is used.
- **Extensibility**: the architecture should make it straightforward to add
  features later (custom layouts, remote sessions, richer file operations,
  collaboration) without a rewrite. Favor modular boundaries between
  session management, terminal/process handling, filesystem access, and UI.
- **Sandboxed filesystem access**: never allow file operations outside a
  session's designated directory.
- **Performance**: the app should stay responsive with 10+ terminals/sessions
  running in the background.

## Open to your judgment
You have latitude to choose the best approach for:
- The underlying session/terminal engine (whether that means leaning on an
  existing multiplexer, managing processes directly, or a hybrid) —
  optimize for reliability and how well it survives app restarts
- The application shell and frontend framework
- The specific data model, storage format, and reconciliation strategy
- How terminal output is rendered and how input is routed
- Internal module boundaries and naming

Pick the combination you assess as most stable and maintainable, and briefly
justify the key architectural decisions before or as you implement them.

## Explicitly out of scope for this version
- Custom pane layouts / tiling beyond simple tabs
- Remote/SSH sessions
- Per-project terminal themes
- Session sharing or multi-user collaboration
- Git integration in the file panel
- Configurable keyboard shortcuts
- Cross-machine sync

## Deliverable
A working v1 covering the core requirements above, built so that the
scoped-out features can be added later without restructuring the core
session/terminal/filesystem modules.