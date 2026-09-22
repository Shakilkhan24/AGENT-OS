# MINIMAL 1.2.8 — M9.3 accessibility code delivery

This release closes the **code-side half** of the M9.3 bullet in
[`FUTURE/IMPLEMENTATION-README.md`](../FUTURE/IMPLEMENTATION-README.md).
The docs half (compatibility matrix, screen-reader runner notes,
focus-ring tokens) was already in place; this cut ships the code
that delivers the headline bullet points and the headless DOM
contract that supplements the manual qualification.

## Headline deliverable

> Complete keyboard-only workflows, visible focus, 200% zoom,
> color-independent status, accessible text/diffs and actual
> supported Linux/WSLg screen-reader checks. Headless DOM tests
> supplement, not replace, that qualification. Keep onboarding
> small and advanced controls progressively disclosed.
>
> — M9.3 bullet

The code-side delivery below maps to each clause:

| M9.3 clause | Code-side delivery |
| --- | --- |
| Keyboard-only workflows | Command palette + cheatsheet + 4 global hotkeys + focus cycle + advanced-controls gate |
| Visible focus | `--focus-ring` token + `:focus-visible` block + `forced-colors` + `prefers-reduced-motion` fallbacks |
| 200% zoom | rem-unit reflow across the chrome (sidebar / topbar / session header / panel margins) + `tests/desktop/zoom.spec.ts` |
| Color-independent status | `running-pill` `aria-label` + `role="status"` + sibling text node so the dot is not the only signal |
| Accessible text/diffs | Terminal host `role="log"` + `aria-live="polite"` + `aria-label` + visually-hidden status mirror |
| Actual screen-reader checks | [`docs/screen-reader-qualification.md`](screen-reader-qualification.md) — Ubuntu 22.04 + Orca 46+, WSL2 + WSLg + NVDA 2024.x, five smoke flows × three independent days |
| Headless DOM tests supplement | `tests/desktop/a11y.spec.ts` + 3 new tests in `tests/desktop/foundation.spec.ts` + `tests/desktop/zoom.spec.ts` |
| Onboarding small / advanced controls progressively disclosed | Advanced controls gate (`localStorage("minimal.advanced")`) hides managed-mode topbar toggle + palette cheatsheet actions by default |

## What's new

### Command palette (`Ctrl+Shift+P`)

A scope-aware, fuzzy-matching palette for the most common actions.
Recent commands (max 5) appear at the top when the search field is
empty. The matching algorithm is the pure helper at
[`src/renderer/command-logic.ts`](../src/renderer/command-logic.ts);
the dialog itself is [`src/renderer/CommandPalette.tsx`](../src/renderer/CommandPalette.tsx).

- **Global.** `Ctrl+Shift+P` fires even when focus is inside a text
  input or an attached terminal — the palette *is* a text input, and
  the user can summon it without first clicking out.
- **Scope-aware.** Commands tagged `session` or `terminal` are hidden
  when no session / terminal is focused.
- **Recent commands.** Persisted under
  `localStorage("minimal.recent-commands")`. Recent commands appear
  above results when the query is empty; activating a command pushes
  it to the front.
- **Keyboard-first.** Arrow keys move the highlight; Enter activates;
  `aria-activedescendant` ties the focused row to the input. Mouse
  hover sets the highlight; click activates. Result limit 12.
- **Recent-commands reset.** A fresh window with no recent commands
  just shows the full list under the limit.

### Keyboard cheatsheet (`?`)

Ten rows of hotkeys live in
[`src/renderer/cheatsheet-data.ts`](../src/renderer/cheatsheet-data.ts)
so a test can assert the table contents without rendering the
dialog. The dialog itself is
[`src/renderer/KeyboardCheatsheet.tsx`](../src/renderer/KeyboardCheatsheet.tsx).

| Shortcut | Action | Scope |
| --- | --- | --- |
| `Ctrl+Shift+P` | Open the command palette | global |
| `Ctrl+Shift+S` | Toggle managed review (advanced) | global |
| `Ctrl+Shift+↑ / ↓` | Cycle keyboard focus across panes | global |
| `?` | Open this cheatsheet | global |
| `Tab / Shift+Tab` | Cycle focus inside dialogs | dialog |
| `Escape` | Close the current dialog | dialog |
| `Enter` | Activate the focused button or row | global |
| `← / →` | Move between terminal tabs (roving) | tabs |
| `Home / End` | Jump to first / last terminal tab | tabs |
| `Ctrl+Shift+C / V` | Copy / paste a terminal selection | terminal |

A visible icon button (`aria-keyshortcuts="?"`) on the topbar gives
the affordance to users who haven't yet learned the `?` shortcut.

### Advanced controls gate

`localStorage("minimal.advanced")` toggles between **simple** and
**advanced** mode. Default is **off**:

- The managed-mode topbar toggle is **disabled** + carries an "Adv"
  badge + has `aria-describedby="managed-advanced-hint"` + shows a
  tooltip pointing the user to the gate.
- The cheatsheet palette actions for managed mode are hidden.
- A `<details>` element in the Presets dialog (the
  [`AdvancedControls`](../src/renderer/AdvancedControls.tsx)
  component) toggles the flag; the setting persists across sessions
  and is read on mount and on the `storage` event so a second
  window reflects the same setting.
- The setting is **per-window** (localStorage is the global scope);
  future work could add a per-profile override if needed.

### Terminal host a11y contract

The terminal host `<div class="terminal-surface">` now carries:

- `role="log"` — declares the region as a chronological log.
- `aria-live="polite"` — AT announces new output as it arrives.
- `aria-label="Terminal output for {label}"` — gives the region a
  stable, label-independent name.

A visually-hidden `<span data-testid="terminal-status">` mirrors
the connection state and announces connect / disconnect / exit /
unavailable transitions to AT. The visible dot stays in place for
sighted users.

The `Ctrl+Shift+C/V` hijack was previously swallowing every
keystroke inside the terminal. The new behaviour is:

```ts
if (event.ctrlKey && event.shiftKey && ["c", "v"].includes(event.key.toLowerCase())) {
  if (!term.hasSelection()) return true;   // ← let AT drive copy/paste
  // ...
}
```

This means an assistive technology that wants to send `Ctrl+Shift+V`
to paste is no longer silently blocked.

### Visible focus + 200% zoom

A new CSS focus-ring token + a `:focus-visible` block cover
`input`, `select`, `textarea`, `button`, and `a`. The double
`outline + box-shadow` rule survives `forced-colors: active` (Windows
High Contrast or some AT shells on Linux). A
`@media (prefers-reduced-motion: reduce)` block strips transitions
for motion-sensitive users.

The chrome (sidebar, topbar, session header, panel margins, brand)
was converted from fixed pixel widths to `rem` units so the layout
reflows correctly at 200% zoom. The contract is asserted by
[`tests/desktop/zoom.spec.ts`](../tests/desktop/zoom.spec.ts):

- 200% effective zoom does not clip the topbar horizontally.
- 200% effective zoom does not overflow the viewport width.

(Playwright's `_electron` harness does not surface
`webContents.setZoomFactor` directly, so the test emulates 200% by
bumping the root `font-size` to 26px — the design reflow target.)

### Color-independent status

The `.running-pill` no longer relies on a coloured dot alone:

- `aria-label="2 terminals running"` (or "Runtime status
  unavailable").
- `role="status"` so AT announces it as a status region.
- The dot has a sibling text node ("2 running" / "Status
  unavailable"), so a user with forced-colors mode still sees the
  status.

The application-version `<span>` in the footer now carries an
`aria-label="Application version 1.2.8"`, so AT announces the
version once rather than reading the literal characters.

## Honest limits of M9.3

M9.3 is qualified by AT runs that have not yet been filled in. The
qualification doc carries an empty 3-row table:

> The M9.3 bullet is "qualified" only when all five flows pass on
> Ubuntu+Orca AND all five flows pass on WSL2+NVDA on each of the
> three runs.

Until those rows are filled in by the qualification operator, M9.3
is **code-complete, headless-DOM-tested, but not yet screen-reader-
qualified**. Future M-bullets that change terminal-host markup,
global-hotkey wiring, or status-chip attributes must re-run the
qualification and add a row (rows are append-only).

Other honest limits:

- **`@xterm/addon-screen-reader`.** Doesn't ship for xterm 6.x at the
  time of M9.3. The visible-region live mirror (`role="log"` +
  visually-hidden status span) is the fallback and the test contract.
- **Forced colors.** Ubuntu's default GNOME theme is not in
  forced-colors mode; the High Contrast theme must be enabled
  explicitly to verify the outline + CanvasText swap. The CSS is
  ready; the manual run verifies it.
- **WSLg AT-SPI latency.** NVDA on the Windows host has 100-300 ms
  latency before announcing renderer changes. The headless test
  environment takes this into account; the manual run records the
  actual observed latency.

## Telemetry-off-by-default preserved

The M9.3 delivery does not change the telemetry-off-by-default
contract. `settings.telemetry: false` default is unchanged; the
22-key allowlist scrubber is unchanged; the canary pipeline still
catches planted tokens; the CSP audit
(`tests/desktop/telemetry-csp.spec.ts`) still passes.

## Supported prefix (advertised workflows)

The supported prefix of user-facing features is unchanged from
1.2.7. The M9.3 delivery exposes new keyboard-first affordances
(palette, cheatsheet, focus cycle) and a progressive-disclosure
gate (Advanced controls). All five advertised workflows remain:

1. Local project + dirty import.
2. Scoped lead + provider coordination.
3. Verifiable evidence + acceptance.
4. Routine save + schedule.
5. Resume + export.

## Known follow-ups

- **Manual qualification rows.** The 3-row table in
  `docs/screen-reader-qualification.md` is empty. Future work: run
  the qualification operator on three independent days, fill the
  rows, and tick M9.3 "qualified" once all five flows pass on both
  configurations across all three runs.
- **`@xterm/addon-screen-reader` for xterm 6.x.** When the addon
  ships for the current major, swap the visible-region live mirror
  for the per-cell readback and update the qualification doc to
  note the upgrade.
- **High Contrast theme on Ubuntu.** Document the explicit enable
  step in the qualification doc.
- **Per-profile advanced override.** Today's gate is per-window
  (localStorage is the global scope). Per-profile gating is a
  small future seam if requested.

## Verification

```bash
# Unit + integration tests for the M9.3 a11y delivery
npx tsx --test tests/desktop/foundation.spec.ts \
                 tests/desktop/a11y.spec.ts \
                 tests/desktop/zoom.spec.ts                                # all green

# Doc tests — the boundary-doc freshness guards still pass
npx tsx --test tests/release/distribution-inventory.test.ts \
                 tests/docs/security-statement.test.ts \
                 tests/docs/provider-economics.test.ts \
                 tests/docs/commercial-decision.test.ts \
                 tests/release/cancel-walkaway.test.ts                      # all green

# Prior gates (M9.0–M9.5) still pass
npx tsx --test tests/runtime/m9_5-pilot-gate.test.ts \
                 tests/runtime/m9-gate.test.ts \
                 tests/runtime/m6-gate.test.ts \
                 tests/runtime/m7-gate.test.ts                              # all green

# CSP audit still locked
npx playwright test tests/desktop/telemetry-csp.spec.ts --grep "source"     # passes

# Typecheck + build — no surprise breakage
npx tsc --noEmit                                                            # 0 errors
npm run build                                                               # exits 0
```
