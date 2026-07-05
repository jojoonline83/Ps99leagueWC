// Records a timestamped snapshot of the Top 500 leagues leaderboard,
// including each league's full roster and per-player point contributions,
// so the static site can compute per-league AND per-player point deltas
// without a backend — this script IS the backend, run on a schedule.
//
// A couple of leagues outside the Top 500 are tracked as standing
// exceptions (see EXTRA_LEAGUE_NAMES) so their deltas keep working even
// though they've dropped out of the ranked cutoff.
//
// Retention is intentionally short (~95 minutes, just past the 1hr delta
// window) because storing full roster detail for every league at every
// 5-minute tick grows fast — a longer window would make history.json far
// too large to fetch from a static site or commit to git repeatedly.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE       = 'history.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 5;    // 5 pages * pageSize 100 = 500 leagues
const PAGE_SIZE          = 100;
const LIST_CONCURRENCY   = 10;
const DETAIL_CONCURRENCY = 20;
const EXTRA_LEAGUE_NAMES = ['jj02', 'woot']; // always tracked, even if outside the Top 500

async function fetchJson(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok') return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    return null;
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// The PS99 API falls back to the numeric UserID (as a string) for DisplayName
// when its own bulk Roblox resolution fails. Resolve those specific users
// ourselves through Roblox's public users API before writing the snapshot,
// in batches of 100 (that endpoint's max per request).
function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

// Shared by the Top 500 detail-fetch step and the standing-exception step,
// so an exception league's already-fetched detail never needs a second,
// redundant hit to the same league-detail URL.
function buildLeagueFromDetail(detail, extra) {
    const contribByUser = {};
    (detail.PointContributions || []).forEach(c => { contribByUser[c.UserID] = c.Points; });

    const roster = [];
    if (detail.Owner && detail.Owner.UserID) {
        roster.push({
            UserID: detail.Owner.UserID, DisplayName: detail.Owner.DisplayName,
            Points: contribByUser[detail.Owner.UserID] ?? 0, Role: 'Owner',
        });
    }
    (detail.Members || []).forEach(m => {
        roster.push({
            UserID: m.UserID, DisplayName: m.DisplayName,
            Points: contribByUser[m.UserID] ?? 0, Role: 'Member',
        });
    });

    return {
        ID: detail.ID, Name: detail.Name, Points: detail.Points,
        Members: roster.length, MemberCapacity: detail.MemberCapacity,
        roster, ...(extra ? { Extra: true } : {}),
    };
}

async function resolveUsernames(userIds) {
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    let failedBatches = 0;

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        if (!batch.length) continue;

        let ok = false;
        for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(10000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    if (data.length === 0) {
                        // Roblox sometimes soft-throttles by returning HTTP 200
                        // with an empty data array instead of a 429 — treat an
                        // empty result for a non-empty batch as a rate-limit hit.
                        await new Promise(r => setTimeout(r, 1500 * attempt));
                    } else {
                        data.forEach(u => { map[u.id] = u.displayName || u.name; });
                        ok = true;
                    }
                } else if (res.status === 429) {
                    // Rate-limited — back off longer, respecting Retry-After if present.
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 1500 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        if (!ok) failedBatches++;

        // Courtesy delay between batches regardless of outcome, so we don't
        // hammer Roblox's rate limiter across ~dozens of batches in a row.
        await new Promise(r => setTimeout(r, 500));
    }

    if (failedBatches) console.log(`resolveUsernames: ${failedBatches} batch(es) never succeeded after retries.`);
    return map;
}

const startedAt = Date.now();

// 1. Fetch the Top 500 league summaries (list endpoint — cheap, no roster).
const pageNums = Array.from({ length: TOP_PAGES }, (_, i) => i + 1);
const pageResults = await mapWithConcurrency(pageNums, LIST_CONCURRENCY, async page => {
    const json = await fetchJson(`${API_BASE}/leagues?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
    return json?.data?.leagues || [];
});
const summaries = pageResults.flat();

if (!summaries.length) {
    console.error('No league data returned — skipping this snapshot rather than recording an empty one.');
    process.exit(0);
}

// 1b. Fetch standing-exception leagues that may have dropped out of the Top
// 500, so their history/deltas keep working. Fetched directly by name since
// they might not appear on any of the pages above. Built straight into a
// full league object (roster included) from this one fetch — no second,
// redundant hit to the same detail URL in step 2.
const trackedNamesLower = new Set(summaries.map(s => s.NameLower || s.Name.toLowerCase()));
const extraLeagues = [];
for (const extraName of EXTRA_LEAGUE_NAMES) {
    if (trackedNamesLower.has(extraName.toLowerCase())) continue;
    const detailJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(extraName)}`);
    const detail = detailJson?.data;
    if (!detail) {
        console.log(`Extra tracked league "${extraName}" not found — skipping this cycle.`);
        continue;
    }
    extraLeagues.push(buildLeagueFromDetail(detail, true));
}

// 2. Fetch full roster + point-contribution detail for every Top 500 league.
const rankedLeagues = await mapWithConcurrency(summaries, DETAIL_CONCURRENCY, async summary => {
    const detailJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
    const detail = detailJson?.data;

    if (!detail) {
        // Detail fetch failed after retries — keep the league-level point
        // total from the list endpoint so its own delta still works, just
        // without a player roster for this cycle.
        return {
            ID: summary.ID, Name: summary.Name, Points: summary.Points,
            Members: summary.Members, MemberCapacity: summary.MemberCapacity,
            roster: [],
        };
    }

    return buildLeagueFromDetail(detail, false);
});
const leagues = rankedLeagues.concat(extraLeagues);

// 3. Resolve any numeric-fallback display names across all rosters.
// Roblox's bulk-users endpoint throttles hard enough that resolving the
// same ~1000+ recurring players from scratch every 5-minute cycle left
// roughly half permanently stuck on numeric names. A persistent cache
// (committed alongside history.json) means only genuinely new users need
// a live lookup each cycle, so the backlog actually clears over time
// instead of restarting from zero every run.
let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = new Set();
leagues.forEach(l => l.roster.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
}));

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    leagues.forEach(l => l.roster.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} new numeric-fallback display names (${Object.keys(resolvedCache).length} cached total).`);
}
// Written unconditionally (even with no new resolutions) so the file always
// exists after the first run — the workflow's `git add` expects it to.
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

// 4. Append this snapshot and prune anything past the retention window.
let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, leagues });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);

writeFileSync(HISTORY_FILE, JSON.stringify(history));
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${leagues.length} leagues with roster detail in ${elapsedSec}s, ${history.length} snapshots retained.`);
