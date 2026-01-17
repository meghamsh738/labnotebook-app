# Lab Note Taking App (web)

Frontend app (React + TypeScript + Vite). For screenshots, features, and repo-level docs, see the root `README.md`.

## Commands

```bash
npm install
npm run dev
npm run lint
npm run build
npm run test:e2e
npm run screenshots
```

- `npm run test:e2e` runs Playwright tests (starts the Vite dev server automatically).
- `npm run screenshots` regenerates `../screenshots/*.png`.

If Playwright is newly installed, run `npx playwright install` once. If `npm install` fails on `/mnt/d/...` in WSL, move the repo into `~/...` first (mounted drives can cause `EPERM`/`chmod` errors).
