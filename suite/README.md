# Suite Integration (Easylab Suite)

This folder contains the integration contract for bundling this repo into the `easylab-suite` desktop launcher.

## What the suite expects
- Front-end build output at `.labnote-dist/web/` (Vite build invoked via `npm --prefix web run build` from the repo root).
- No Python backend: this module is bundled and launched as a static app inside Electron.

## Module metadata
See `suite/module.json`.
