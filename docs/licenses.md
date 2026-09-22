# Licenses

## Project license

MINIMAL is released under the **ISC License**. The full text is in
[`LICENSE`](../LICENSE) at the repository root.

```
ISC License — Copyright (c) 2024, the MINIMAL contributors
```

## Third-party dependencies

The application depends on the npm packages listed in
[`docs/dependencies.md`](dependencies.md). Each is governed by its own
license; the matrix below is correct to the best of our knowledge as
of MINIMAL 1.2.3.

| Package | SPDX license | Source |
|---|---|---|
| `@xterm/xterm` | MIT | https://github.com/xtermjs/xterm.js |
| `@xterm/addon-fit` | MIT | https://github.com/xtermjs/xterm.js |
| `lucide-react` | ISC | https://github.com/lucide-icons/lucide |
| `react` | MIT | https://github.com/facebook/react |
| `react-dom` | MIT | https://github.com/facebook/react |
| `zod` | MIT | https://github.com/colinhacks/zod |
| `electron` | MIT | https://github.com/electron/electron |
| `@playwright/test` | Apache-2.0 | https://github.com/microsoft/playwright |
| `esbuild` | MIT | https://github.com/evanw/esbuild |
| `tsx` | MIT | https://github.com/esbuild-kit/tsx |
| `typescript` | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `vite` | MIT | https://github.com/vitejs/vite |
| `tmux` | ISC | https://github.com/tmux/tmux |
| `python` (CPython) | PSF | https://www.python.org/ |

## Bundled Electron licenses

The packaged Electron binary ships its own license notices in
`release/minimal-linux-x64/LICENSE` and `release/minimal-linux-x64/LICENSES.chromium.html`.
These are populated by Electron at packaging time and contain the full
notices for Chromium, V8 and the Electron-embedded libraries. The
packaging step does not strip them.

## Adding a new dependency

When you add a new npm dependency:

1. Update [`package.json`](../package.json) with the version pin.
2. Add a row to the table above with the package's SPDX license.
3. If the package's license is not MIT, ISC, Apache-2.0, BSD-2/3-Clause,
   or PSF/ISC-for-Python-stdlib, raise it in the maintainer channel
   *before* merging. Some licenses (GPL variants, AGPL, SSPL, BUSL) are
   not compatible with MINIMAL's ISL distribution.

## What this document is **not**

- A legal opinion. The maintainers make a good-faith effort to keep
  this accurate, but the canonical license for each dependency is the
  `LICENSE` file shipped with that dependency at the pinned version.
- A warranty. Each dependency is provided "as is" by its respective
  authors; see their licenses for terms.
