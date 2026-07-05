// Records a timestamped snapshot of the live Top 200 leagues leaderboard so
// the static site can compute real point deltas (5m / 30m / 1hr) without a
// backend — this script IS the backend, run on a schedule by GitHub Actions.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_BASE      = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE  = 'history.json';
const RETENTION_MS  = 26 * 60 * 60 * 1000; // keep a bit over a day of snapshots

async function fetchPage(page) {
    const res = await fetch(`${API_BASE}/leagues?page=${page}&pageSize=100&sort=Points&sortOrder=desc`, {
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching page ${page}`);
    const json = await res.json();
    if (json.status !== 'ok') throw new Error('API returned a non-ok status');
    return json.data.leagues || [];
}

const [page1, page2] = await Promise.all([fetchPage(1), fetchPage(2)]);
const leagues = [...page1, ...page2].map(l => ({ ID: l.ID, Name: l.Name, Points: l.Points }));

if (!leagues.length) {
    console.error('No league data returned — skipping this snapshot rather than recording an empty one.');
    process.exit(0);
}

let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, leagues });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);

writeFileSync(HISTORY_FILE, JSON.stringify(history));
console.log(`Snapshot recorded: ${leagues.length} leagues this run, ${history.length} snapshots retained.`);
