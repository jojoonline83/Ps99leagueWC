// Records a timestamped snapshot of the Top 500 leagues leaderboard,
// including each league's full roster and per-player point contributions,
// so the static site can compute per-league AND per-player point deltas
// without a backend — this script IS the backend, run on a schedule.
//
// A few leagues outside the Top 500 are tracked as standing
// exceptions (see EXTRA_LEAGUE_NAMES) so their deltas keep working even
// though they've dropped out of the ranked cutoff.
//
// Retention is intentionally short (~95 minutes, just past the 1hr delta
// window) because storing full roster detail for every league at every
// 5-minute tick grows fast — a longer window would make history.json far
// too large to fetch from a static site or commit to git repeatedly.
//
// A separate, lower-key monitoring pass (see MONITOR_GROUPS) watches a
// handful of leagues' individual players purely on the backend — never
// exposed to the site or history.json — and posts a Discord alert if a
// player goes completely inactive (zero point gain across the 10m/30m/1h
// windows at once), e.g. to catch someone who's disconnected even while
// their league's total keeps climbing from other members.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE       = 'history.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 5;    // 5 pages * pageSize 100 = 500 leagues
const PAGE_SIZE          = 100;
const LIST_CONCURRENCY   = 10;
const DETAIL_CONCURRENCY = 20;
const EXTRA_LEAGUE_NAMES = ['jj02', 'woot', 'wint2']; // always tracked, even if outside the Top 500

// Backend-only inactivity monitoring — not shown on the site. Lives under
// .github/ (rather than the repo root, which is the Pages deploy root)
// specifically so it's never uploaded as a fetchable static file.
//
// Split into independent groups so different leagues can alert into
// different Discord channels. Each group's env var is comma-separated to
// support broadcasting into more than one channel per group too.
const MONITOR_GROUPS = [
    { names: ['abwk', 'woot', 'wint1'], webhookEnvVar: 'DISCORD_WEBHOOK_URL' },
    { names: ['jj02'], webhookEnvVar: 'DISCORD_WEBHOOK_URL_2' },
];
const MONITOR_LEAGUE_NAMES = MONITOR_GROUPS.flatMap(g => g.names);
const MONITOR_DIR          = '.github/monitor-data';
const MONITOR_HISTORY_FILE = `${MONITOR_DIR}/monitor_history.json`;
const MONITOR_STATE_FILE   = `${MONITOR_DIR}/monitor_alert_state.json`;

function webhooksForLeague(name) {
    const group = MONITOR_GROUPS.find(g => g.names.some(n => n.toLowerCase() === name.toLowerCase()));
    if (!group) return [];
    return (process.env[group.webhookEnvVar] || '').split(',').map(s => s.trim()).filter(Boolean);
}

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

async function sendDiscordAlert(message, webhookUrls) {
    if (!webhookUrls.length) {
        console.log(`Discord webhook not configured — would have alerted: ${message}`);
        return;
    }
    for (const webhookUrl of webhookUrls) {
        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: message }),
                signal: AbortSignal.timeout(10000),
            });
        } catch (err) {
            console.log(`Discord alert failed for one webhook: ${err.message}`);
        }
    }
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

// Manual test mode: verify one (or all) configured Discord webhooks are
// wired up correctly, without running (or waiting for) a real snapshot cycle.
if (process.env.TEST_DISCORD_ALERT === 'true') {
    const allWebhookEnvVars = [...new Set(MONITOR_GROUPS.map(g => g.webhookEnvVar))];
    const groupFilter = process.env.TEST_DISCORD_GROUP || 'all';
    const targetEnvVars = groupFilter.includes('DISCORD_WEBHOOK_URL_2') ? ['DISCORD_WEBHOOK_URL_2']
        : groupFilter.includes('DISCORD_WEBHOOK_URL') ? ['DISCORD_WEBHOOK_URL']
        : allWebhookEnvVars;
    for (const envVar of targetEnvVars) {
        const urls = (process.env[envVar] || '').split(',').map(s => s.trim()).filter(Boolean);
        await sendDiscordAlert(`✅ Test alert from PS99 League Tracker (${envVar}) — if you can see this, Discord notifications are working correctly.`, urls);
    }
    console.log(`Test Discord alert(s) sent for [${targetEnvVars.join(', ')}] (or logged, if unconfigured).`);
    process.exit(0);
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

// The detail endpoint has occasionally returned stale/reset data for a
// league — all its points and every player's contribution suddenly far
// below what the list endpoint (moments earlier, same cycle) just reported,
// even though real point totals only ever grow here. That silently produces
// a league sitting at its correct (list-sorted) rank position while showing
// wildly wrong points/roster. A >10% shortfall vs the list's own figure is
// treated as suspicious.
function looksSuspicious(detail, summary) {
    return typeof summary.Points === 'number' && summary.Points > 0 && detail.Points < summary.Points * 0.9;
}

// 2. Fetch full roster + point-contribution detail for every Top 500 league.
const rankedLeagues = await mapWithConcurrency(summaries, DETAIL_CONCURRENCY, async summary => {
    const detailJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
    let detail = detailJson?.data;

    if (detail && looksSuspicious(detail, summary)) {
        const retryJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
        const retryDetail = retryJson?.data;
        if (retryDetail && !looksSuspicious(retryDetail, summary)) {
            detail = retryDetail;
        } else {
            console.log(`Suspicious detail data for "${summary.Name}" (list: ${summary.Points}, detail: ${detail.Points}) — keeping list-level Points, dropping roster for this cycle.`);
            detail = null;
        }
    }

    if (!detail) {
        // Detail fetch failed (or looked untrustworthy) after retries — keep
        // the league-level point total from the list endpoint so its own
        // delta still works and rank stays consistent, just without a
        // player roster for this cycle.
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

// 5. Backend-only PLAYER-level inactivity monitoring for MONITOR_LEAGUE_NAMES.
// The point is to catch an individual player who's gone quiet (e.g.
// disconnected) even while their league's total keeps climbing from other
// members — a league-total check alone would miss that. Reuses the full
// roster already fetched above for anything already tracked (Top 500 or a
// standing exception); only names not otherwise seen this cycle get a
// dedicated fetch. Kept in its own file, never read by the site.
mkdirSync(MONITOR_DIR, { recursive: true });
const monitorLeagues = {};
for (const name of MONITOR_LEAGUE_NAMES) {
    const already = leagues.find(l => l.Name.toLowerCase() === name.toLowerCase());
    if (already) {
        monitorLeagues[name] = { roster: already.roster };
        continue;
    }
    const json = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(name)}`);
    const detail = json?.data;
    monitorLeagues[name] = detail ? { roster: buildLeagueFromDetail(detail, false).roster } : null;
}

let monitorHistory = [];
if (existsSync(MONITOR_HISTORY_FILE)) {
    try { monitorHistory = JSON.parse(readFileSync(MONITOR_HISTORY_FILE, 'utf8')); } catch (_) { monitorHistory = []; }
}
const pastMonitorHistory = monitorHistory.filter(entry => now - entry.ts <= RETENTION_MS);
monitorHistory = [...pastMonitorHistory, { ts: now, leagues: monitorLeagues }];
writeFileSync(MONITOR_HISTORY_FILE, JSON.stringify(monitorHistory));

function findMonitorSnapshotNear(msAgo, toleranceMs) {
    const targetTs = now - msAgo;
    let best = null, bestDiff = Infinity;
    for (const entry of pastMonitorHistory) {
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

let alertState = {};
if (existsSync(MONITOR_STATE_FILE)) {
    try { alertState = JSON.parse(readFileSync(MONITOR_STATE_FILE, 'utf8')); } catch (_) { alertState = {}; }
}

const snap10 = findMonitorSnapshotNear(10 * 60_000, 11 * 60_000);
const snap30 = findMonitorSnapshotNear(30 * 60_000, 8  * 60_000);
const snap1h = findMonitorSnapshotNear(60 * 60_000, 12 * 60_000);

// Escalating reminders: each window (10m/30m/1h) is checked and alerted
// independently, rather than waiting for all three to agree before ever
// saying anything. A player who's just gone quiet gets flagged within
// ~10 minutes; if they're still flat 30 minutes in, and still flat a full
// hour in, that's a separate follow-up alert each time — not a repeat of
// the same message every cycle. Each window's alert re-arms on its own
// the moment that window shows real movement again.
for (const name of MONITOR_LEAGUE_NAMES) {
    const currentRoster = monitorLeagues[name]?.roster;
    if (!currentRoster) continue; // league not found/fetchable this cycle

    const findPast = (snap, userId) => snap?.leagues?.[name]?.roster?.find(p => p.UserID === userId)?.Points;

    for (const player of currentRoster) {
        const windows = [
            { label: '10m', snap: snap10 },
            { label: '30m', snap: snap30 },
            { label: '1h',  snap: snap1h },
        ];
        for (const w of windows) {
            if (!w.snap) continue; // not enough history yet for this window
            const past = findPast(w.snap, player.UserID);
            if (past == null) continue; // player wasn't tracked that far back yet

            const key = `${name}:${player.UserID}:${w.label}`;
            const isStalled = player.Points - past === 0;
            if (isStalled && !alertState[key]) {
                await sendDiscordAlert(`⚠️ **${player.DisplayName}** in **${name}** has earned 0 points over the last ${w.label} — possibly disconnected (currently ${player.Points.toLocaleString()} pts).`, webhooksForLeague(name));
                alertState[key] = true;
            } else if (!isStalled) {
                alertState[key] = false;
            }
        }
    }
}
writeFileSync(MONITOR_STATE_FILE, JSON.stringify(alertState));
