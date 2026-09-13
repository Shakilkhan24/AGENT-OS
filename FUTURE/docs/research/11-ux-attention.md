# 11. Attention, review, and accessible control

Research date: 2026-09-10. All MINIMAL interface recommendations below are proposed.

The draft already separates tasks, attempts, observations, and acceptance. Its missing contract is how people act on those distinctions. The supplied [snapshot](../../ins.md) reports working terminals and file previews, but incomplete tab navigation, no app-wide draft recovery, and no structured agent review. No application source or running interface was available for this assessment.

## Primary evidence

All seven sources were opened on 2026-09-10. Summaries are paraphrases; each uses fewer than 100 words. These documents establish patterns and documented capabilities, not measured productivity gains or verified MINIMAL compatibility.

| Primary source | Relevant evidence and limitation |
| --- | --- |
| [W3C APG: Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) | Specifies arrow navigation, selected-state semantics, and focus after closure. Automatic activation is recommended only when panels display without noticeable latency. |
| [W3C APG: Modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | Specifies contained focus, Escape dismissal, meaningful initial focus, and focus return. Marking a panel modal without actually making its surroundings inert causes accessibility problems. |
| [W3C: Understanding WCAG 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | Status changes must be programmatically available without receiving focus. The page identifies inaccessible status messages as failure F103 and cautions against excessive live announcements. This is explanatory guidance, not a complete conformance assessment. |
| [W3C APG: Window splitter](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) | Describes focusable separators, position values, keyboard resizing, and optional pane cycling. The page explicitly says its review awaits a completed functional example; treat it as design guidance requiring testing. |
| [VS Code: Accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility) | Documents focus navigation, a terminal Tab-focus mode, accessible terminal buffers, and a unified accessible diff viewer. Its screen-reader/platform support is not automatically inherited by an Electron application. |
| [GitHub: Reviewing proposed changes](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request) | File review progress is distinct from submitting a review. A changed file loses its Viewed marker; feedback can comment, approve, or request changes. |
| [Claude Code: Interactive mode](https://code.claude.com/docs/en/interactive-mode) | Interrupting, suspending, backgrounding, task checklists, and running-task views have distinct controls. Native `/diff` has version/rendering requirements and some views collapse or omit categories by default. Test the installed version before mapping controls or assuming review coverage. |

## Proposed workspace and attention model

```text
Projects        Task / ordinary terminal             Attention (count)
  Project A     Outcome | Run | Changes | Checks      Needs decision
  Project B     provider · checkout · host           Recovery needed
                active terminal / readable output   Ready to review
                [New task] [Open terminal]          [Open selected item]
```

Start with one active terminal attachment. Introduce splits only after the architecture's attachment registry. A terminal can exist without a task; attaching it never establishes task completion. Closing its view, stopping its command, and deleting its retained record need separate actions.

For newcomers, expose a project, an objective, success evidence, and Start. Show provider, checkout, execution mode, and existing authority before dispatch. Expand instructions, configuration provenance, and advanced limits on demand. Introduce recipes after successful repeated work and schedules when available. Never hide a changed target or new authority request inside advanced settings.

Attention is a persistent queue of unresolved items, keyed to task, run, reason, and decision revision. Keep an inspected row stable while new items arrive. Opening, marking read, dismissing a notification, or snoozing an item does not resolve it or authorize execution. Stale requests remain inspectable but cannot be approved.

| Observation | User-facing meaning and action |
| --- | --- |
| Running | Show last observation; Stop requests cancellation. |
| Human input required | Explain whether an answer or additional authority is needed; open that exact request. |
| Documented continuation available | Continue displays the provider/session and whether a new invocation will start. |
| Stop requested | Show Stopping and elapsed wait; cancellation remains unconfirmed until acknowledged. |
| Interrupted process | Preserve artifacts; inspect before selecting a supported continuation or new attempt. |
| Disconnected or unknown effect | Show last-known state, timestamp, and uncertainty; Reconnect/check status observes only. |
| Completed attempt | Review the candidate and evidence; acceptance remains a separate decision. |

Running output stays in the run view. Results, failures, and pending decisions enter the inbox without changing focus. Use polite status announcements for ordinary updates; reserve assertive announcements for important, time-sensitive problems. Coalesce repetitive updates while retaining the underlying events. Optional desktop notices open the referenced item; they never approve it. A background request blocks its affected work, not navigation throughout the application.

## Drafts, authority, and review

Keep editor drafts separately from project files, identified by workspace, path, base content version, and draft revision. Display whether a recoverable checkpoint exists. Reopening restores the draft without saving it into the checkout. External edits produce a comparison with both versions retained. Normal closure flushes drafts; failed persistence presents Save elsewhere, Discard, or Cancel closing. Crash recovery promises only acknowledged checkpoints. Restored task prompts are never automatically submitted.

Configuration preview shows effective value, origin, intended change, and unsupported or unobserved settings. Its summary names executable hooks/tools, outgoing data, target environment, and authority needed. Browsing project files does not itself require blanket execution trust. An authorization request explains the concrete action and target, scope, expiry, and why existing authority is insufficient. Reuse valid grants; a changed target or capability produces a new decision. Do not add repeated confirmations to routine actions already authorized.

The review view opens with the objective, candidate/base identity, changed-file count, and required evidence: passed, failed, missing, or stale. All changed files remain discoverable, including tests, configuration, generated files, and changes outside the original scope. Marking files reviewed tracks progress only; reset affected markers after changes. Present line feedback as a draft until the user sends it. Accept result, Request revision, Create PR, and Merge are separate actions with separate consequences.

## Keyboard and accessibility contract

Use one tab stop per tablist, arrow and Home/End navigation, and manual activation with Enter/Space while attachment latency exists. After closure, focus a neighboring tab or Open terminal. Preserve a terminal's native key handling while it owns input; provide a discoverable, remappable command to leave it. Do not intercept provider interrupts or tmux prefixes as workspace navigation.

Propose F6/Shift+F6 for remappable pane cycling. Named, focusable separators report orientation and minimum/current/maximum values; arrows resize only while the handle has focus. Resizing retains focus; collapsing a pane moves focus to its controlling handle. Clearly identify which terminal receives input; duplicate mirrors remain read-only. Supply a searchable, selectable text view of terminal output and unified diffs, with a stable reading position while output arrives.

Only user-opened decisions requiring a modal interaction trap focus. Give dialogs an accessible name and visible dismissal action; Escape dismisses without approval and returns focus. Keep focus visible at enlarged zoom, and pair state colors with text. These are proposed acceptance requirements, not an accessibility certification.

## Three user flows

1. **Start a scoped repair.** Open a project, preserve any draft, enter the failure and expected check, inspect provider/checkout/configuration, then Start. Work appears under one task while ordinary terminals remain available. A later question adds an inbox item; typing in another pane continues uninterrupted.
2. **Leave and recover.** Close the window after draft checkpoint acknowledgement. Reopen to the same task, saved drafts, and last observations. A stopped host produces an interrupted/unknown explanation. Inspect artifacts and side effects, then deliberately resume or create an attempt; reopening alone never invokes an agent.
3. **Review and revise.** Open a ready result, inspect the complete file list and exact-tree checks, and record line feedback. Request revision sends the selected feedback. A new candidate marks changed review progress and old evidence stale. Accept only when the selected candidate satisfies the declared checks; integration remains explicit.

## Five acceptance tests

1. **Keyboard-only traversal:** Create/open/switch/close terminals, enter and leave their input, resize/collapse panes, and open review without a pointer. Every action has visible focus; no navigation keystroke reaches another terminal or starts a command. Repeat at 200% zoom.
2. **Accessible attention:** With a screen reader on each supported GUI platform, generate output plus several state changes while reading a diff. The reading position stays stable; task names and reasons are announced without replaying terminal chatter. Every unresolved decision remains reachable. Record unsupported Linux/WSLg combinations explicitly.
3. **Draft recovery/conflict:** Edit, acknowledge a checkpoint, close/reopen, and kill/restart the GUI. Recover the acknowledged text. Change the source externally; saving must expose both versions. Simulate draft-store failure: closure cannot silently discard the buffer.
4. **Authority and focus:** Reuse an unchanged grant without another prompt; change its target and obtain a new scoped decision. Dismiss its dialog with Escape: no approval occurs, focus returns, and the item remains pending. Mark read and snooze likewise grant nothing.
5. **Evidence and recovery:** Change a reviewed file or candidate after verification; stale evidence cannot authorize acceptance. Disconnect during Stop: display unconfirmed cancellation, preserve the item across restart, and never start replacement work. Users must correctly identify whether an action observes, resumes, retries, or accepts.

## Corrections to the master documents

- **README §3:** Replace generic Continue with the action/state mapping above; add the three flows and explicit terminal/task separation.
- **README §12:** Move essential keyboard/focus/draft gates into P0–P1 and basic decision/review inbox delivery into P2. P4 can add schedule triage; P6 should broaden qualification, not introduce accessibility.
- **ARCHITECTURE §§3–4:** Specify attention-item identity, unresolved/read/snoozed distinctions, action preconditions, focus ownership, and separate connectivity from last-observed execution state.
- **ARCHITECTURE §§1, 5–6:** Assign durable draft-checkpoint ownership, compare/restore behavior, review-marker invalidation, and effective-configuration visibility. Renderer ownership alone cannot establish crash recovery.
- **README §13:** Measure missed decisions, duplicate prompts, review errors, and recovery effort in the existing comparative pilot. The proposed patterns need user testing; no cognitive or productivity multiplier is established here.
