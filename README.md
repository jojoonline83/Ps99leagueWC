# PS99 World Cup II Tracker

A static, browser-based league tracker for the PS99 World Cup Part 2 event.

## Features

- **Groups & standings** — create groups, add teams, and get an auto-computed league table (Played / Won / Drawn / Lost / GD / Points) using standard 3-1-0 scoring.
- **Match results** — record, edit, and delete match results; standings recompute instantly.
- **Team pages** — click any team in a standings table to see its full match history and group rank.
- **Live PS99 clan lookup** — look up a clan's official name/tag from the public PS99 API (`biggamesapi.io`) to use when adding a team. World Cup match results aren't published via any public API, so scores are always entered manually.
- Everything is saved to `localStorage` in your browser — no backend, no login.

## Live site

Once GitHub Pages finishes its first deploy, the tracker is available at:

`https://jojoonline83.github.io/Ps99leagueWC/`

## Running it locally

This is a plain static site (`index.html` + `style.css` + `app.js`). Open `index.html` directly in a browser, or serve the folder with any static host.
