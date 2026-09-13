# Recovery and persistence

Workspace mutations and event publication resolve after validated data has been written, the file synced, the replacement renamed and the parent directory synced. In-memory state and event subscribers update after persistence succeeds. A failed operation is surfaced; it is not automatically replayed. These guarantees depend on the filesystem honoring sync requests.

State and the event journal have separate file commits. An operation spanning both is not a transaction: an event-write failure can follow a successful state commit. Refresh the workspace before retrying a reported failure.

The default profile is Electron's `~/.config/MINIMAL` directory. `MINIMAL_DATA_DIR` overrides it. Keep the profile path stable: it determines the private tmux socket and which running terminals can be reattached.

On malformed `state.json`, MINIMAL creates a private, content-addressed `state.recovery-*.backup.json` containing the exact original bytes. The original state file stays untouched until a subsequent edit. A recovery notice gives the backup path, and an empty workspace opens. New edits replace `state.json` but leave the recovery copy intact. If preserving the backup fails, startup fails rather than enabling writes over the original. Version-1 migration similarly preserves a `state.v1-*.backup.json`.

A state schema newer than 2 is an upgrade mismatch, not corrupt data. MINIMAL refuses startup and all state writes, leaving the file unchanged. Open that profile with a compatible newer release; do not delete its version field or turn it into an empty workspace. A read error or failed backup also keeps the store unwritable. Historical v1.2.1 and earlier binaries cannot enforce this rule, so do not point them directly at upgraded profiles.

To repair saved state, close the GUI, preserve copies of both the current state and recovery file, and repair a copy against the schemas in `src/shared/models.ts`. Restore a validated, supported state file to the same profile before reopening. Do not replace good new work with an invalid backup. Keeping terminal IDs intact allows surviving processes to be reattached; restoring state does not rerun commands. A recovery fallback does not kill existing tmux processes, even if their records are temporarily absent from the empty workspace.

Unsaved editor text is mirrored to bounded private draft files. The editor's recovery controls restore a draft for review. Saving still requires conflict checking against the current file. Drafts are not a replacement for project backups or Git, and keystrokes after the last mirror may be lost in a crash.

Normal shutdown rejects new IPC operations, cancels batch launches between items, waits for accepted operations and the current launch item, drains reconciliation and persistence, then closes the file helper. Started terminal processes survive. A five-second watchdog prevents an indefinite shutdown; timeout or failed shutdown exits unsuccessfully and is logged. SIGKILL, WSL shutdown and power loss cannot run graceful shutdown handlers.

Terminal paste is delivered in bounded acknowledged chunks. Switching tabs cancels unsent chunks; accepted text may already be in the previous terminal's input buffer. It is never redirected to another terminal or automatically replayed. If interrupted mid-paste, review that terminal's input before submitting it. Process retention ends when the Linux environment is shut down.

Polling supplements tmux exit hooks. If tmux has an unreaped zombie pane without an exit status, MINIMAL verifies its parent against the private server and requests SIGCHLD handling on that server. tmux collects the actual exit result. No exit code is invented and no terminal job receives this recovery signal.

Save conflict detection compares the opened hash with disk before replacement. An unrelated external writer can still race between the check and rename; this is not a filesystem compare-and-swap. Review a conflict and preserve external edits. Managed writer coordination is planned in M3.

On Windows-mounted WSL projects, file moves use link/unlink when native no-replace rename is unavailable. Interruption may leave both names; remove the verified redundant name before editing because hard links are blocked. A directory fallback reserves an empty destination before rename, so interruption may leave that empty reservation. Inspect both paths before retrying; do not assume a reported failure means nothing moved. Native Linux rename has a single rename boundary. Existing backend move-fault tests cover these fallbacks; power-loss behavior still depends on the mount honoring synchronization.
