# Pawfolio — Pet Care Planner

The live web app + Etsy buyer's downloadable file.

**Live URL:** https://cleartrackapps.com/pet-care-planner/
**Etsy listing:** https://www.etsy.com/listing/4487742972/pet-care-planner-app

## Repos in this project

This product has **two separate GitHub repos**. They are NOT linked — a commit to one does not update the other.

| Repo | What it is | Live URL |
|------|-----------|----------|
| **pet-care-planner** (this repo) | The full app — what visitors and Etsy buyers see | https://cleartrackapps.com/pet-care-planner/ |
| **pet-care-planner-demo** | Cut-down demo for prospective buyers (resets data on refresh, Export/Import/Print disabled, etc.) | https://cleartrackapps.com/pet-care-planner-demo/ |

**If you change a feature, color, font, or layout that should appear in both, you have to commit it to BOTH repos.** The demo always keeps its 7 restrictions (DEMO_MODE flag, banner, disabled Export/Import/Check Updates/Print, no service worker, no silent update check, localStorage clear on load).

## Files in this repo

| File | Purpose |
|------|---------|
| `index.html` | The live app that loads at the URL above |
| `version.json` | Read by the in-app "Check for updates" feature |
| `sw.js` | Service worker — controls PWA caching |
| `manifest.json` | PWA install manifest |
| `icon-192.png`, `icon-512.png` | App icons |

## Releasing a new version

When making a change that the user should see:

1. Bump `<meta name="app-version" content="X.X.X">` (line 9) in `index.html`
2. Update `"version"` and `"released"` in `version.json`
3. Bump `CACHE_NAME` in `sw.js` (e.g. `pet-care-planner-79` → `pet-care-planner-80`) — this forces installed PWAs to flush their cache and pull the new files
4. If the change is user-facing, also commit a parallel update to the `pet-care-planner-demo` repo

GitHub Pages auto-deploys from `main`. Live site updates ~1 minute after pushing.
