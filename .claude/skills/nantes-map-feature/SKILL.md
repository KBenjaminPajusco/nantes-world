---
name: nantes-map-feature
description: Add or update a private joke, challenge, souvenir or fun feature on the Nantes friends map (nantes-world). Use when the user says things like "we do a Butte Sainte-Anne challenge", "Léa climbed it twice", "add a pin for X", "add a new joke/feature", or wants the map to track who does something the most.
---

# Nantes map — adding jokes and features smoothly

The site is static (GitHub Pages, repo `KBenjaminPajusco/nantes-world`, project in `~/nantes-world`). There is no backend: **everything shared lives in `data/*.json` committed to git**. Pick the lightest level that does the job.

## Level 1 — data only (most requests)

| Want | File | Shape |
|---|---|---|
| A place/pin (home, HQ, a souvenir) | `data/pois.json` | `{id, emoji, title, text, by, lat, lon, color, url?, urlLabel?}` |
| A challenge with a zone and a leaderboard | `data/challenges.json` | `{id, emoji, title, unit, text, lat, lon, radius, color}` (radius in m) |
| "Someone did a challenge" | `data/events.json` | `{challenge, who, date: "YYYY-MM-DD", n: 1, note?}` appended to `events`; `n` = how many times |

- Leaderboard = sum of `n` per `who`, done by the page itself. Never store totals.
- "Léa climbed Butte Sainte-Anne twice today" → append `{ "challenge": "butte-sainte-anne", "who": "Léa", "date": <today>, "n": 2 }`. Use a consistent first name spelling (look at existing `who` values first).
- Friends can also play in the page (they enter their first name in the "Défis" panel, walking into the zone counts, "Copier mes exploits" gives JSON). When the user pastes such JSON, append it to `events.json` as is.
- Souvenir trails and automatic scores from GPS: `python tools/gpx_import.py --who <Prénom> file.gpx` (friends export GPX from Strava/Garmin and send it) or `python tools/strava_sync.py sync` (the owner's own Strava, see the file header). Both write `data/events.json` and `data/tracks.json`, trim 300 m at each end for privacy, and dedupe by activity. Do not try to pull other people's Strava data through one API app: Strava forbids showing a user's data to others, and an unreviewed app only connects its owner.
- Coordinates: geocode with Nominatim (`https://nominatim.openstreetmap.org/search?q=…&format=jsonv2`, send a User-Agent, 1 request/s). If a place is not found (bars often are not), ask the user for the street address instead of guessing.
- Ids are lowercase-kebab and stable; never reuse an id for something else.

## Level 2 — a new mechanic (code)

1. Create `src/features/<name>.js` exporting `default { id, init(ctx), update(ctx, dt) }`.
2. Register it in `src/features/index.js` (`FEATURES`).
3. `ctx` offers: `THREE`, `scene`, `walker` (the flying glider: `walker.pos.x`, `walker.pos.y` = world x/z in metres, `walker.agl` = height above ground in m), `city` (`terrain.h(x, z)` ground height, `surfaceY(x, z)` ground or roof), `toXZ(lat, lon)`, `toLL(x, z)`, `loadJSON(path)`, `ui.toast(msg)`, `ui.burst(x, z, color)` (confetti).
4. Keep its data in its own `data/<name>.json`; do not grow `main.js`. A feature that throws is disabled, it must never break the map.
5. Reference implementation: `src/features/challenges.js`.

World coordinates: x = east, z = south, origin = Place du Commerce (47.2132, -1.5559). The terrain is real (IGN relief), the player flies. A challenge zone can set `maxAlt` (m above ground) so the player must descend to score, e.g. the Butte Sainte-Anne has `maxAlt: 45`.

## Tone

Jokes are in French, short, a bit cheeky: toast text like `⛰️ +1 Butte Sainte-Anne pour Léa !`. Keep it affectionate; nothing that targets someone.

## Ship it

1. Validate: `python -c "import json,sys;[json.load(open(f,encoding='utf-8')) for f in sys.argv[1:]]" data/*.json`.
2. Look at it: `python serve.py 8766` then open http://127.0.0.1:8766 (browser tools if available). Check the browser console for errors.
3. `python tools/version.py` (stamps `?v=` so phones do not keep the old cache), then commit and `git push` to `main`. Pages redeploys in ~1 min.
4. Git identity is the repo-local noreply one. **No `Co-Authored-By` or any AI attribution in commits** (contractual rule).

## Privacy

The repo and site are **public**. Do not put full surnames, phone numbers, exact home addresses of friends or private photos in `data/`. The user's own address is theirs to publish; for friends, ask first. If the jokes become sensitive, suggest a private repo (Pages on private repos needs a paid plan) or a password-protected host.
