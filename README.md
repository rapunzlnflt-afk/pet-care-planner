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

## Sitter inbox backend

Supabase migration 0009 + Edge Function `pawfolio-sitter-inbox` for Sitter mode and "Send to a sitter". Setup, deploy steps and local tests: [SITTER_INBOX.md](SITTER_INBOX.md).

## Shared devices and separate clients (Sitter mode, v3.42.1)

A form only updates an existing client when the clientId matches and the owner name is the same (trimmed, case-insensitive, spaces collapsed). If either name is empty, the clientId alone decides, as before. This covers a sitter's tablet or a family computer used by several people, where the old web form reused one clientId per sitter. To fix forms that were already filed under the wrong client, open a previous version on the client card and tap **Make this a separate client**: that version becomes its own client (new id and clientId, no photos) and is removed from the original's history. The old clientId is kept in `altClientIds`, so that person's later forms still land on their new card. The web form (rapunzlnflt-afk.github.io) now keeps its clientId per sitter inbox and owner name.

## Clients map (Sitter mode, v3.42.0)

Clients tab > **Map** shows every client with an address on one map, for planning visits. Free for sitters (part of Pawfolio Free).

- **Leaflet 1.9.4** is vendored in `vendor/leaflet/` (BSD-2-Clause, see `vendor/leaflet/LICENSE`; the `sourceMappingURL` comment was removed). No CDN. It is loaded only when the map opens, and it is in the `sw.js` precache.
- **Tiles:** OpenStreetMap standard tiles with attribution. The map needs internet; offline it shows a friendly message and still lists clients.
- **Geocoding:** OpenStreetMap Nominatim, one request at a time, at most one per second, only for clients without saved coordinates. A one-time notice comes first ("Client addresses are looked up with OpenStreetMap to place pins. Nothing else is sent.").
- **Stored on the client record** in `pawfolioSitterClients` as `geo: {lat, lng, addr, status, manual, q, at}`, so Save My Data backups carry it. `addr` is the address the spot came from; a client is looked up again only when that changes. Pins moved by hand (`manual: true`) are kept until the address changes.
- **Plan a route:** pick stops in order. iPhone/iPad (iOS 18.4+) open Apple Maps' unified directions URL (`maps.apple.com/directions`, up to 14 stops) with Google Maps as a fallback; elsewhere, and on older iOS, Google Maps directions (up to 10 stops). The route starts at the current location.

## Releasing a new version

When making a change that the user should see:

1. Bump `<meta name="app-version" content="X.X.X">` (line 9) in `index.html`
2. Update `"version"` and `"released"` in `version.json`
3. Bump `CACHE_NAME` in `sw.js` (e.g. `pet-care-planner-79` → `pet-care-planner-80`) — this forces installed PWAs to flush their cache and pull the new files
4. If the change is user-facing, also commit a parallel update to the `pet-care-planner-demo` repo

GitHub Pages auto-deploys from `main`. Live site updates ~1 minute after pushing.
