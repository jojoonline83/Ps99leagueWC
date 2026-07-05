# PS99 World Cup II Tracker

A static, browser-based live leaderboard for the PS99 World Cup Part 2 event.

## Features

- **Top 200 leaderboard** — automatically fetches the top 200 clans, live, straight from the official PS99 API (`biggamesapi.io`), ranked by points.
- **Search any clan** — look up any clan by exact name even if it's ranked below #200; it shows up in a separate "Found Outside Top 200" list.
- **Team pages** — click any clan to see its rank and points.
- Auto-refreshes every 2 minutes, plus a manual **Refresh** button. Last-known data is cached to `localStorage` so it loads instantly, then refreshes in the background — no backend, no login.

## Live site

`https://jojoonline83.github.io/Ps99leagueWC/`

## Running it locally

This is a plain static site (`index.html` + `style.css` + `app.js`). Open `index.html` directly in a browser, or serve the folder with any static host.
