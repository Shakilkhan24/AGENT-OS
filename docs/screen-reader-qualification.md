# Screen-reader qualification

This document records the manual qualification run that M9.3 mandates.
Headless DOM tests assert that the *attributes* a screen reader consumes
(`role="log"`, `aria-live="polite"`, `aria-label`, focus-ring tokens,
keyboard-only flows) are present and correctly wired; the actual reading
behaviour is verified by hand, on real hardware, against a real assistive
technology. The runs below are the evidence.

## Scope

The qualification covers MINIMAL's primary user flows on the supported
prefix (Linux + WSLg). Two assistive-technology configurations are
qualified:

- **Ubuntu 22.04 LTS + Orca 46+** (AT-SPI bus, direct on the Linux desktop).
- **WSL2 + WSLg + NVDA 2024.x** (running on the Windows host, bridging
  through WSLg into the Linux Electron renderer).

Both configurations are exercised against an x86_64 build of MINIMAL
1.2.3 running on a single workspace with one session and one running
terminal.

## Setup

### Ubuntu 22.04 + Orca

```bash
sudo apt update
sudo apt install -y orca at-spi2-core
# Launch Orca: Super+Alt+S, or `orca &` from a terminal.
# Confirm AT-SPI is reachable:
dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus \
  org.a11y.Bus.GetAddress
# Launch MINIMAL:
/opt/minimal/minimal-linux-x64/minimal
```

Verify the bridge is alive: in Orca, press `Orca+Space` and the
MINIMAL window should appear in the Object Navigation tree. If it does
not, check `journalctl --user -u at-spi-dbus-bus.desktop` for errors.

### WSL2 + WSLg + NVDA

1. On the Windows host, install the latest NVDA.
2. `wsl --set-version <distro> 2` and `wsl --update`.
3. Confirm WSLg is wired: `wslg --version` should print a release.
4. Launch NVDA on the Windows host. NVDA finds Electron renderers via
   the WSLg AT-SPI bridge automatically.
5. Launch MINIMAL inside WSL: `/opt/minimal/minimal-linux-x64/minimal`.
6. Move the Windows cursor over the MINIMAL window so NVDA focuses the
   renderer.

## Five smoke flows

Each flow is recorded in the result table below. `pass` = announced as
expected, `partial` = some elements silent, `fail` = not announced.

1. **Welcome heading**: launch MINIMAL fresh, confirm Orca/NVDA
   announces "Your work, still running." plus the footer version
   ("Application version 1.2.3").
2. **Command palette**: press `Ctrl+Shift+P`, confirm the palette's
   `<input>` receives focus and Orca/NVDA announces "Search, edit".
3. **Create session**: type a name in the palette's search, choose
   "New session", confirm the dialog opens and the directory field is
   announced.
4. **Managed toggle**: press `Ctrl+Shift+S`, confirm Orca/NVDA
   announces "managed review on" / "managed review off" — depends on
   whether Advanced controls are enabled (M9.3 gate; default off, so
   the keystroke is silent and the toast "Enable Advanced controls" is
   announced instead).
5. **Terminal output**: launch a terminal, switch to it, confirm the
   terminal surface is announced as a log region. Run `echo hello`;
   the visually-hidden status mirror announces "Terminal X connected".
   On WSLg/NVDA the `xterm.js` screen-reader addon (when published for
   the current major) provides per-cell readback; the live-region
   mirror is the fallback and is the contract this milestone guarantees.

## Result table

The first three rows are filled in by the **qualification operator** on
three independent days, on different keyboard layouts. The M9.3
bullet is "qualified" only when all five flows pass on Ubuntu+Orca AND
all five flows pass on WSL2+NVDA on each of the three runs.

| Run | Date | Layout | Flow 1 | Flow 2 | Flow 3 | Flow 4 | Flow 5 | Notes |
| --- | ---- | ------ | ------ | ------ | ------ | ------ | ------ | ----- |
| 1   |      |        |        |        |        |        |        |       |
| 2   |      |        |        |        |        |        |        |       |
| 3   |      |        |        |        |        |        |        |       |

## Known limitations

- **xterm.js screen-reader addon.** `@xterm/addon-screen-reader` exposes
  the grid cell-by-cell but doesn't currently ship for the xterm 6.x
  series at the time of M9.3. The visible-region live mirror
  (`role="log"` + visually-hidden status span) is the fallback and the
  test contract.
- **Forced colors.** Ubuntu's default GNOME theme is not in forced-colors
  mode; the High Contrast theme must be enabled explicitly to verify
  the outline + CanvasText swap.
- **WSLg AT-SPI latency.** NVDA on the Windows host has measurable
  latency (100-300 ms) before announcing renderer changes. The
  test-environment command takes this into account; the manual run
  records the actual observed latency.

## Updating after a regression

If a future M-bullet changes any of:

- the terminal host markup (e.g. removes `role="log"`),
- the global hotkey wiring,
- the running-pill / status chip accessibility attributes,

the qualification must be re-run and a new row added. The previous
rows are NOT deleted; the table grows monotonically so regressions are
auditable.

## See also

- `docs/compatibility.md` — supported prefix, including the screen
  reader configuration this doc qualifies against.
- `src/main/index.ts` — `app.setAccessibilitySupportEnabled(true)`,
  the one-line bridge to AT-SPI on Linux/WSLg.
- `src/renderer/Terminal.tsx` — the live-region mirror and the
  conditional screen-reader addon import.
- `src/renderer/useGlobalShortcuts.ts` — the global hotkey wiring.
- `tests/desktop/a11y.spec.ts` — the headless DOM contract the manual
  run supplements, not replaces.