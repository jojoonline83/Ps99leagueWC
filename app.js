/* ═══════════════════════════════════════════
   PS99 World Cup II — Leagues Tracker App Logic
   ═══════════════════════════════════════════ */

'use strict';

document.title = 'PS99 World Cup II — Leagues [v15]';

// ── Constants ──────────────────────────────
const STORAGE_KEY = 'ps99_worldcup2_v4';
const API_BASE     = 'https://ps99.biggamesapi.io/v1';
const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

// ── State ──────────────────────────────────
// The Top 500 leaderboard (plus a few standing-exception leagues,
// see EXTRA_LEAGUE_NAMES in snapshot.mjs), with each league's roster +
// point contributions, comes entirely from history.json (written every
// ~10 min by a background GitHub Action — see .github/scripts/snapshot.mjs).
// historyData holds every snapshot within the retention window (~95 min),
// oldest first; the last entry is "now". Only search falls back to a live
// API call, since history.json only tracks the Top 500 + exceptions.
let historyData = [];

let state = {
    mode: 'top',        // 'top' | 'search'
    searchResults: [],
    total: 0,
    colorByName: {},
    nextColorIdx: 0,
};

let ui = {
    currentLeagueName: null,
    currentLeagueDetail: null, // unified shape: {ID,Name,Points,MemberCapacity,Level?,Created?,roster:[{UserID,DisplayName,Points,Role}]}
    currentRank: undefined,    // undefined = not yet resolved, null = resolved but unknown, number = exact rank
    livePointsAsOf: undefined, // set once a live API refresh has landed for the open league; undefined = still showing snapshot-only data
};

let overallTotalCache = 0;

// ── Persistence ────────────────────────────
// history.json is tens of MB — never persist it to localStorage, just
// re-fetch on load. Only small UI state is cached.
function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

// ── Helpers ────────────────────────────────
function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) {
    return (Number(n) || 0).toLocaleString();
}

function colorFor(name) {
    const key = name.toLowerCase();
    if (!state.colorByName[key]) {
        state.colorByName[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByName[key];
}

function formatDate(unixSeconds) {
    if (!unixSeconds) return '—';
    return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function latestSnapshot() {
    return historyData.length ? historyData[historyData.length - 1] : null;
}

function topLeagues() {
    return latestSnapshot()?.leagues || [];
}

// Leagues shown in the ranked Top 500 table — excludes standing-exception
// leagues (tracked even though they've dropped below the cutoff), which
// have no meaningful position in this list.
function rankedLeagues() {
    return topLeagues().filter(l => !l.Extra);
}

function displayedLeagues() {
    return state.mode === 'search' ? state.searchResults : rankedLeagues();
}

// ── Toast ──────────────────────────────────
let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Navigation ─────────────────────────────
function showLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    renderLeaderboard();
}

function showLeagueDetail(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('league-detail-view').classList.add('active');
    ui.currentLeagueName = name;
    ui.currentLeagueDetail = null;
    ui.currentRank = undefined;
    ui.livePointsAsOf = undefined;
    renderLeagueDetail();
    openLeagueDetail(name);
}

// A league in the tracked Top 500 (or a standing-exception league) already
// has everything we need (roster, points) sitting in memory from the latest
// snapshot — show it instantly, no network round trip. Only fall back to a
// live API call for a league found via search that isn't tracked at all.
// A tracked exception league has no meaningful array position, so its rank
// is resolved live via binary search, same as the fully-live fallback path.
function openLeagueDetail(name) {
    const nameLower = name.toLowerCase();
    const fromSnapshot = topLeagues().find(l => l.Name.toLowerCase() === nameLower);

    if (fromSnapshot) {
        ui.currentLeagueDetail = fromSnapshot;
        const rankedIdx = rankedLeagues().indexOf(fromSnapshot);
        if (rankedIdx !== -1) {
            ui.currentRank = rankedIdx + 1;
            renderLeagueDetail();
        } else {
            ui.currentRank = undefined;
            renderLeagueDetail();
            resolveRank(name, fromSnapshot);
        }
        // Points/roster shown above are only as fresh as the last background
        // snapshot job (~10 min). Quietly overlay the real current values
        // from a live API call, without touching the historical snapshots
        // still used for the 10m/30m/1h delta math.
        refreshLeagueDetailLive(name);
        return;
    }
    fetchLeagueDetailLive(name);
}

// ── Leaderboard rendering ──────────────────
function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedLeagues();
    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${state.total} match${state.total === 1 ? '' : 'es'})`
            : 'Top 500';

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No leagues matched your search.' : 'No data yet — hit <strong>🔄 Refresh</strong> to load the Top 500.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((l, idx) => {
        const color = colorFor(l.Name);
        return `
      <tr onclick="showLeagueDetail('${esc(l.Name).replace(/'/g, "\\'")}')" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> ${esc(l.Name)}</td>
        <td>${l.Members}/${l.MemberCapacity}</td>
        <td class="player-points" style="color:${color}">${fmt(l.Points)}</td>
      </tr>`;
    }).join('');
}

// ── League Detail ──────────────────────────
function renderLeagueDetail() {
    const name = ui.currentLeagueName;
    const color = colorFor(name);
    document.getElementById('league-detail-color-bar').style.background = color;
    document.getElementById('league-detail-name').textContent = name;

    const rankEl = document.getElementById('ld-rank');
    if (ui.currentRank === undefined) {
        rankEl.textContent = 'Calculating…';
    } else if (ui.currentRank === null) {
        rankEl.textContent = 'Unknown';
    } else {
        rankEl.textContent = `#${fmt(ui.currentRank)}${overallTotalCache ? ` of ${fmt(overallTotalCache)}` : ''}`;
    }

    const detail = ui.currentLeagueDetail;
    if (!detail) {
        document.getElementById('league-detail-sub').textContent = 'Loading…';
        document.getElementById('ld-pts').textContent = '…';
        document.getElementById('ld-pts-asof').textContent = '';
        document.getElementById('ld-roster').textContent = '…';
        document.getElementById('ld-level').textContent = '…';
        ['ld-delta-10m', 'ld-delta-30m', 'ld-delta-1h'].forEach(id => {
            document.getElementById(id).textContent = '—';
            document.getElementById(`${id}-asof`).textContent = '';
        });
        document.getElementById('roster-delta-note').textContent = '';
        document.getElementById('roster-tbody').innerHTML =
            `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading roster…</td></tr>`;
        return;
    }

    document.getElementById('league-detail-sub').textContent = detail.Created ? `Created ${formatDate(detail.Created)}` : 'PS99 World Cup II';
    document.getElementById('ld-pts').textContent = fmt(detail.Points);
    document.getElementById('ld-roster').textContent = `${detail.roster.length}/${detail.MemberCapacity}`;
    document.getElementById('ld-level').textContent = detail.Level ?? '—';
    document.getElementById('ld-pts-asof').textContent = ui.livePointsAsOf
        ? `🔴 Live as of ${new Date(ui.livePointsAsOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : (latestSnapshot() ? `Snapshot as of ${new Date(latestSnapshot().ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — refreshing…` : '');

    const snap10 = renderDeltaStat('ld-delta-10m', detail, 10 * 60_000, 11 * 60_000);
    const snap30 = renderDeltaStat('ld-delta-30m', detail, 30 * 60_000, 8  * 60_000);
    const snap1h = renderDeltaStat('ld-delta-1h',  detail, 60 * 60_000, 12 * 60_000);

    // Same snapshots the per-player Δ columns below will independently look
    // up (same windows/tolerances), so this one line covers all of them too.
    const noteParts = [
        snap10 && `Δ10m ${formatAsOf(snap10)}`,
        snap30 && `Δ30m ${formatAsOf(snap30)}`,
        snap1h && `Δ1Hr ${formatAsOf(snap1h)}`,
    ].filter(Boolean);
    document.getElementById('roster-delta-note').textContent = noteParts.length ? noteParts.join(' · ') : '';

    const roleLabel = r => r === 'Owner' ? '👑 Owner' : 'Member';
    const tbody = document.getElementById('roster-tbody');
    tbody.innerHTML = detail.roster.length
        ? detail.roster.map(p => {
            const d10 = playerDelta(detail, p.UserID, p.Points, 10 * 60_000, 11 * 60_000);
            const d30 = playerDelta(detail, p.UserID, p.Points, 30 * 60_000, 8  * 60_000);
            const d1h = playerDelta(detail, p.UserID, p.Points, 60 * 60_000, 12 * 60_000);
            return `
              <tr>
                <td>${roleLabel(p.Role)}</td>
                <td class="player-name">${esc(p.DisplayName)}</td>
                <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
                <td style="color:${d10.color}">${d10.text}</td>
                <td style="color:${d30.color}">${d30.text}</td>
                <td style="color:${d1h.color}">${d1h.text}</td>
              </tr>`;
          }).join('')
        : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">No roster data.</td></tr>`;
}

// ── Live PS99 API ──────────────────────────
async function apiFetch(path) {
    const url = `${API_BASE}${path}`;
    const isValid = d => d && typeof d === 'object' && d.status === 'ok';

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
    } catch (_) {}
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(20000) });
            if (res.ok) { const d = await res.json(); if (isValid(d)) return d; }
        } catch (_) {}
    }
    throw new Error('API unavailable – check connection or try again later');
}

// ── Point-Delta History ────────────────────
// history.json is written by a scheduled GitHub Action (.github/workflows/
// snapshot.yml) that snapshots the Top 500 (plus standing exceptions) —
// with full roster + per-player point contributions — every ~5 minutes.
// It's the only way to get real
// point deltas without a backend, since the PS99 API itself has no
// historical/time-series endpoints.
async function loadHistory() {
    const res = await fetch(`history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) historyData = await res.json();
}

// Older snapshots recorded before roster tracking was added only have
// league-level Points, no per-player roster. Skip those here so league-level
// and player-level deltas always draw from the same pool of snapshots —
// otherwise a league's own delta could show a real number while every
// player in it still shows "—", which reads as broken even though it's
// just an artifact of when each kind of data started being tracked.
function hasRosterData(entry) {
    return entry.leagues.length === 0 || entry.leagues[0].roster !== undefined;
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (historyData.length < 2) return null;
    // The current values being compared against always come from the latest
    // snapshot, so "N minutes ago" is measured from latest.ts, not wall-clock
    // Date.now() — the delta represents points gained in the N minutes
    // leading up to that snapshot, a fixed quantity independent of how long
    // the page has been open or how stale the last snapshot happens to be.
    // (Anchoring to wall-clock instead caused a real bug: once the site's
    // data lagged a bit behind real time, the wall-clock target and the
    // latest-anchored minimum-age check below fell out of sync and rejected
    // otherwise-valid matches, showing a dash for everything.)
    const latest = historyData[historyData.length - 1];
    const targetTs = latest.ts - msAgo;
    // It must also never resolve to latest itself — otherwise, once the real
    // snapshot cadence drifts close to the window size (as happened when it
    // settled around ~10 minutes), "closest to N minutes ago" can resolve to
    // the latest snapshot, comparing current data against current data and
    // showing a spurious +0 for every league and player. A generous
    // toleranceMs (needed so cadence drift on the "too old" side doesn't
    // leave the window empty) also opens the door the other way: if the
    // snapshot cadence ever hiccups (e.g. an external cron double-firing
    // moments after a missed tick), a snapshot from mere seconds before the
    // CURRENT one can become the numerically "closest" match, since
    // ±toleranceMs around the target is a wide net. Require the candidate to
    // be at least half the window older than latest so a near-instant
    // predecessor never gets mistaken for a meaningful N-minutes-ago point.
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        if (entry === latest) continue;
        if (!hasRosterData(entry)) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function findLeagueInSnapshot(snap, leagueId, leagueName) {
    return snap.leagues.find(l => l.ID === leagueId || l.Name.toLowerCase() === leagueName.toLowerCase());
}

// The current totals come from the latest snapshot (as fresh as the last
// job run), but the comparison point for a delta is necessarily an older
// snapshot — show its actual clock time so it's clear the delta reflects
// data as of that run, not the current moment.
function formatAsOf(snap) {
    return snap ? `as of ${new Date(snap.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
}

function renderDeltaStat(elId, detail, windowMs, toleranceMs) {
    const el = document.getElementById(elId);
    const asOfEl = document.getElementById(`${elId}-asof`);
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) {
        el.textContent = '—'; el.title = 'Not enough snapshot history yet';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }

    const entry = findLeagueInSnapshot(snap, detail.ID, detail.Name);
    if (!entry) {
        el.textContent = '—'; el.title = 'League was outside tracking at that time';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }

    const delta   = detail.Points - entry.Points;
    const ageMin  = Math.round((Date.now() - snap.ts) / 60000);
    const sign    = delta >= 0 ? '+' : '−';
    el.textContent = `${sign}${fmt(Math.abs(delta))}`;
    el.title       = `From snapshot ${ageMin}m ago`;
    el.style.color = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : '');
    if (asOfEl) asOfEl.textContent = formatAsOf(snap);
    return snap;
}

// Same idea as renderDeltaStat, but for one player inside a league's roster.
function playerDelta(detail, userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '' };

    const league = findLeagueInSnapshot(snap, detail.ID, detail.Name);
    const past = league?.roster?.find(p => p.UserID === userId)?.Points;
    if (past === undefined) return { text: '—', color: '' };

    const delta = currentPoints - past;
    const sign  = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : ''),
    };
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

    try {
        await loadHistory();
        if (state.mode === 'top') renderLeaderboard();
        if (ui.currentLeagueName) {
            const stillTracked = topLeagues().find(l => l.Name.toLowerCase() === ui.currentLeagueName.toLowerCase());
            if (stillTracked) {
                ui.currentLeagueDetail = stillTracked;
                const rankedIdx = rankedLeagues().indexOf(stillTracked);
                if (rankedIdx !== -1) {
                    ui.currentRank = rankedIdx + 1;
                    renderLeagueDetail();
                } else {
                    ui.currentRank = undefined;
                    renderLeagueDetail();
                    resolveRank(ui.currentLeagueName, stillTracked);
                }
            }
        }
        if (!silent) toast(`Loaded ${fmt(topLeagues().length)} leagues`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

async function searchLeagues() {
    const input = document.getElementById('search-league-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a league name', 'error'); return; }

    const btn = document.getElementById('search-league-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${esc(query)}"…`, 'loading');

    try {
        const res = await apiFetch(`/leagues?search=${encodeURIComponent(query)}&page=1&pageSize=50&sort=Points&sortOrder=desc`);
        const leagues = res.data.leagues || [];
        state.searchResults = leagues;
        state.mode = 'search';
        state.total = res.data.total || leagues.length;
        save();
        renderLeaderboard();
        setStatus(leagues.length ? `✅ Found ${state.total} matching league(s).` : `No leagues found matching "${esc(query)}".`, leagues.length ? 'success' : 'error');
    } catch (err) {
        setStatus(`❌ ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
    }
}

function clearSearch() {
    document.getElementById('search-league-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.mode === 'search') {
        state.mode = 'top';
        renderLeaderboard();
    }
}

// Resolve Roblox UserIDs → display names in batches of 100, via the public
// Roblox users API (same CORS-proxy fallback pattern as apiFetch).
async function resolveUsernames(userIds) {
    if (!userIds.length) return {};
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100).map(Number).filter(id => id > 0);
        if (!batch.length) continue;

        const body    = JSON.stringify({ userIds: batch, excludeBannedUsers: false });
        const headers = { 'Content-Type': 'application/json' };
        let parsed = null;

        try {
            const res = await fetch(ROBLOX_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
            if (res.ok) parsed = await res.json();
        } catch (_) {}
        for (const proxy of CORS_PROXIES) {
            if (parsed) break;
            try {
                const res = await fetch(`${proxy}${encodeURIComponent(ROBLOX_URL)}`, {
                    method: 'POST', headers, body, signal: AbortSignal.timeout(12000),
                });
                if (res.ok) parsed = await res.json();
            } catch (_) {}
        }

        if (parsed) {
            (parsed.data || []).forEach(u => {
                const display = u.displayName || u.name;
                map[u.id] = display;
                map[String(u.id)] = display;
            });
        }
    }
    return map;
}

// The PS99 API falls back to the numeric UserID (as a string) for DisplayName
// when its own bulk Roblox resolution fails. Detect that and try resolving
// those specific users ourselves before rendering.
function isUnresolvedName(entity) {
    return !!(entity && entity.UserID && entity.DisplayName === String(entity.UserID));
}

// The background snapshot job publishes its own persistent name-resolution
// cache (resolved_names.json) — check that first for any still-numeric name
// before falling back to a live Roblox lookup, so live-fetched leagues
// benefit from names the background job already resolved.
let resolvedNamesCachePromise = null;
function getResolvedNamesCache() {
    if (!resolvedNamesCachePromise) {
        resolvedNamesCachePromise = fetch(`resolved_names.json?t=${Date.now()}`)
            .then(res => (res.ok ? res.json() : {}))
            .catch(() => ({}));
    }
    return resolvedNamesCachePromise;
}

// Normalizes a raw /leagues/:name API response into the same shape as a
// snapshot-sourced league (roster merged with role + points), resolving any
// numeric-fallback display names along the way — shared by the fully-live
// fallback path and the background live-refresh overlay for tracked leagues.
async function buildLiveDetail(raw) {
    const cache = await getResolvedNamesCache();
    const applyCached = entity => { if (isUnresolvedName(entity) && cache[entity.UserID]) entity.DisplayName = cache[entity.UserID]; };
    applyCached(raw.Owner);
    (raw.Members || []).forEach(applyCached);

    const needsResolve = [];
    if (isUnresolvedName(raw.Owner)) needsResolve.push(raw.Owner.UserID);
    (raw.Members || []).forEach(m => { if (isUnresolvedName(m)) needsResolve.push(m.UserID); });
    if (needsResolve.length) {
        const resolved = await resolveUsernames([...new Set(needsResolve)]);
        if (isUnresolvedName(raw.Owner) && resolved[raw.Owner.UserID]) raw.Owner.DisplayName = resolved[raw.Owner.UserID];
        (raw.Members || []).forEach(m => { if (isUnresolvedName(m) && resolved[m.UserID]) m.DisplayName = resolved[m.UserID]; });
    }

    const contribByUser = {};
    (raw.PointContributions || []).forEach(c => { contribByUser[c.UserID] = c.Points; });

    const roster = [];
    if (raw.Owner && raw.Owner.UserID) {
        roster.push({ UserID: raw.Owner.UserID, DisplayName: raw.Owner.DisplayName, Points: contribByUser[raw.Owner.UserID] ?? 0, Role: 'Owner' });
    }
    (raw.Members || []).forEach(m => {
        roster.push({ UserID: m.UserID, DisplayName: m.DisplayName, Points: contribByUser[m.UserID] ?? 0, Role: 'Member' });
    });

    return {
        ID: raw.ID, Name: raw.Name, Points: raw.Points, MemberCapacity: raw.MemberCapacity,
        Level: raw.Level, Created: raw.Created, roster,
    };
}

// Live fallback: a league found via search that isn't tracked at all.
async function fetchLeagueDetailLive(name) {
    try {
        const res = await apiFetch(`/leagues/${encodeURIComponent(name)}`);
        const detail = await buildLiveDetail(res.data);

        ui.currentLeagueDetail = detail;
        if (ui.currentLeagueName === name) { ui.livePointsAsOf = Date.now(); renderLeagueDetail(); }
        resolveRank(name, detail);
    } catch (err) {
        toast(err.message, 'error');
        document.getElementById('league-detail-sub').textContent = 'Failed to load league detail.';
    }
}

// A tracked league's detail renders instantly from the last snapshot, but
// that's only as fresh as the background job (~10 min). Quietly overlay the
// real current Points/roster from a live API call — silently, since the
// snapshot-sourced view is already valid and useful on its own. Deltas keep
// using the historical snapshots untouched; only the "current" side of the
// comparison gets fresher.
async function refreshLeagueDetailLive(name) {
    try {
        const res = await apiFetch(`/leagues/${encodeURIComponent(name)}`);
        if (ui.currentLeagueName !== name) return; // user navigated away while this was in flight
        const detail = await buildLiveDetail(res.data);
        if (ui.currentLeagueName !== name) return;
        ui.currentLeagueDetail = detail;
        ui.livePointsAsOf = Date.now();
        renderLeagueDetail();
    } catch (_) {
        // Keep showing the snapshot-sourced data — no error surfaced for a
        // background refresh that didn't need to succeed.
    }
}

// Find a league's exact global rank on the Points leaderboard. Only needed
// for leagues without a meaningful snapshot array position — the live
// fallback path, and standing-exception leagues tracked below the Top 500
// cutoff. Ranked Top 500 leagues know their rank directly from their
// snapshot index.
// Binary-searches leaderboard pages (each an exact, indexed slice sorted by
// Points desc), since there's no direct "rank of X" endpoint.
async function resolveRank(name, detail) {
    const nameLower = name.toLowerCase();
    try {
        const pageSize = 100;
        if (!overallTotalCache) {
            const totalRes = await apiFetch('/leagues?page=1&pageSize=1&sort=Points&sortOrder=desc');
            overallTotalCache = totalRes.data.total || 0;
        }
        const totalPages = Math.max(1, Math.ceil(overallTotalCache / pageSize));
        const targetPoints = detail.Points;
        const matches = l => l.NameLower === nameLower || l.Name.toLowerCase() === nameLower || l.ID === detail.ID;

        let lo = 1, hi = totalPages, rank = null;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const res = await apiFetch(`/leagues?page=${mid}&pageSize=${pageSize}&sort=Points&sortOrder=desc`);
            const pageLeagues = res.data.leagues || [];
            if (!pageLeagues.length) { hi = mid - 1; continue; }

            const idx = pageLeagues.findIndex(matches);
            if (idx !== -1) { rank = (mid - 1) * pageSize + idx + 1; break; }

            const firstPts = pageLeagues[0].Points;
            const lastPts = pageLeagues[pageLeagues.length - 1].Points;
            if (targetPoints > firstPts) hi = mid - 1;
            else if (targetPoints < lastPts) lo = mid + 1;
            else break; // points tie at a page boundary and name didn't match on this page — give up cleanly
        }

        ui.currentRank = rank;
    } catch (_) {
        ui.currentRank = null;
    }
    if (ui.currentLeagueName === name) renderLeagueDetail();
}

// ── Event Listeners ────────────────────────
document.getElementById('league-back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-league-btn').addEventListener('click', searchLeagues);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-league-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchLeagues(); }
});

// ── Auto-Refresh ───────────────────────────
// Matches the background snapshot's own ~5 minute cadence.
setInterval(() => refreshAll({ silent: true }), 5 * 60_000);

// ── Bootstrap ──────────────────────────────
load();
renderLeaderboard();
refreshAll({ silent: false });
