# PS99 World Cup II Tracker

A static, browser-based live leaderboard for the PS99 World Cup Part 2 **Leagues** — competitive teams of up to 4 players, straight from the official PS99 API (`ps99.biggamesapi.io/v1/leagues`).

## Features

- **Top 2500 leaderboard** — a background job (`.github/workflows/snapshot.yml`) polls the Top 2500 leagues every ~5 minutes, with each league's full roster and per-player point contributions, and commits the result to `history.json`. The site reads that file directly, so opening the leaderboard or any league's detail page is instant — no live API calls needed for anything already tracked.
- **Search any league** — search by name (prefix match) to find any league not in the Top 2500; that one falls back to a live API call.
- **League detail** — click any league to see its full 4-player roster (owner + members) with each player's point contribution.
- **Point deltas (Last 5m / 30m / 1Hr)** — computed at both the league level and the individual player level, from the snapshot history. Since the PS99 API itself has no history/time-series endpoint, this snapshot file is the only way to get real deltas over time — accurate even if no browser was open in between. Retention is ~95 minutes (just past the 1hr window) to keep the file a reasonable size given the amount of per-player data being tracked.
- Auto-refreshes every 5 minutes (matching the snapshot cadence), plus a manual **Refresh** button. No backend, no login — `history.json` *is* the backend.

## Live site

`https://jojoonline83.github.io/Ps99leagueWC/`

## Running it locally

This is a plain static site (`index.html` + `style.css` + `app.js`). Open `index.html` directly in a browser, or serve the folder with any static host.
