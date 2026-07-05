# PS99 World Cup II Tracker

A static, browser-based live leaderboard for the PS99 World Cup Part 2 **Leagues** — competitive teams of up to 4 players, straight from the official PS99 API (`ps99.biggamesapi.io/v1/leagues`).

## Features

- **Top 200 leaderboard** — automatically fetches the top 200 leagues, live, ranked by points.
- **Search any league** — search by name (prefix match) to find any league, even outside the Top 200.
- **League detail** — click any league to see its full 4-player roster (owner + members), each player's individual point contribution, and join dates.
- Auto-refreshes every 2 minutes, plus a manual **Refresh** button. Last-known data is cached to `localStorage` so it loads instantly, then refreshes in the background — no backend, no login.

## Live site

`https://jojoonline83.github.io/Ps99leagueWC/`

## Running it locally

This is a plain static site (`index.html` + `style.css` + `app.js`). Open `index.html` directly in a browser, or serve the folder with any static host.
