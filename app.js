/* ═══════════════════════════════════════════
   PS99 World Cup II — Leagues Tracker App Logic
   ═══════════════════════════════════════════ */

'use strict';

document.title = 'PS99 World Cup II — Leagues [v6]';

// ── Constants ──────────────────────────────
const STORAGE_KEY = 'ps99_worldcup2_v3';
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
let state = {
    leagues: [],       // currently displayed list — either Top 200 or search results
    top200: [],        // canonical Top 200, always kept fresh regardless of what's displayed
    mode: 'top',       // 'top' | 'search'
    total: 0,          // result count for the current query (search matches, or Top 200 length)
    overallTotal: 0,   // total leagues across the entire leaderboard (for exact-rank lookups)
    lastFetched: null,
    colorByName: {},   // stable color assignment per league name across refreshes
    nextColorIdx: 0,
};

let ui = {
    currentLeagueName: null,
    currentLeagueDetail: null,
    currentRank: undefined, // undefined = not yet resolved, null = resolved but unknown, number = exact rank
};

// ── Persistence ────────────────────────────
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
    ui.currentRank = undefined; // undefined = not yet resolved, null = resolved but unknown
    renderLeagueDetail();
    fetchLeagueDetail(name);
}

// ── Leaderboard rendering ──────────────────
function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    badge.innerHTML = state.lastFetched
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(state.lastFetched).toLocaleTimeString()}</span>`
        : '';

    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${state.total} match${state.total === 1 ? '' : 'es'})`
            : 'Top 200';

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!state.leagues.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No leagues matched your search.' : 'No data yet — hit <strong>🔄 Refresh</strong> to fetch the live Top 200.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = state.leagues.map((l, idx) => {
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
        rankEl.textContent = `#${fmt(ui.currentRank)}${state.overallTotal ? ` of ${fmt(state.overallTotal)}` : ''}`;
    }

    const detail = ui.currentLeagueDetail;
    if (!detail) {
        document.getElementById('league-detail-sub').textContent = 'Loading…';
        document.getElementById('ld-pts').textContent = '…';
        document.getElementById('ld-roster').textContent = '…';
        document.getElementById('ld-level').textContent = '…';
        document.getElementById('roster-tbody').innerHTML =
            `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)">Loading roster…</td></tr>`;
        return;
    }

    document.getElementById('league-detail-sub').textContent = `Created ${formatDate(detail.Created)}`;
    document.getElementById('ld-pts').textContent = fmt(detail.Points);
    document.getElementById('ld-roster').textContent = `${(detail.Owner?.UserID ? 1 : 0) + detail.Members.length}/${detail.MemberCapacity}`;
    document.getElementById('ld-level').textContent = detail.Level ?? '—';

    renderDeltaStat('ld-delta-5m',  detail, 5  * 60_000, 3  * 60_000);
    renderDeltaStat('ld-delta-30m', detail, 30 * 60_000, 8  * 60_000);
    renderDeltaStat('ld-delta-1h',  detail, 60 * 60_000, 12 * 60_000);

    const contribByUser = {};
    (detail.PointContributions || []).forEach(c => { contribByUser[c.UserID] = c.Points; });

    const rows = [];
    if (detail.Owner && detail.Owner.UserID) {
        rows.push({
            role: '👑 Owner',
            name: detail.Owner.DisplayName,
            points: contribByUser[detail.Owner.UserID] ?? 0,
            joined: null,
        });
    }
    (detail.Members || []).forEach(m => {
        rows.push({
            role: 'Member',
            name: m.DisplayName,
            points: contribByUser[m.UserID] ?? 0,
            joined: m.JoinTime,
        });
    });

    const tbody = document.getElementById('roster-tbody');
    tbody.innerHTML = rows.length
        ? rows.map(r => `
            <tr>
              <td>${r.role}</td>
              <td class="player-name">${esc(r.name)}</td>
              <td class="player-points" style="color:${color}">${fmt(r.points)}</td>
              <td>${r.joined ? formatDate(r.joined) : '—'}</td>
            </tr>`).join('')
        : `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)">No roster data.</td></tr>`;
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
// snapshot.yml) that snapshots the live Top 200 every ~5 minutes — it's the
// only way to get real point deltas without a backend, since the PS99 API
// itself has no historical/time-series endpoints.
let historyData = [];

async function loadHistory() {
    try {
        const res = await fetch(`history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) historyData = await res.json();
    } catch (_) {}
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (!historyData.length) return null;
    const targetTs = Date.now() - msAgo;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function renderDeltaStat(elId, detail, windowMs, toleranceMs) {
    const el = document.getElementById(elId);
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) { el.textContent = '—'; el.title = 'Not enough snapshot history yet'; return; }

    const entry = snap.leagues.find(l => l.ID === detail.ID || l.Name.toLowerCase() === detail.Name.toLowerCase());
    if (!entry) { el.textContent = '—'; el.title = 'League was outside the tracked Top 200 at that time'; return; }

    const delta   = detail.Points - entry.Points;
    const ageMin   = Math.round((Date.now() - snap.ts) / 60000);
    const sign     = delta >= 0 ? '+' : '−';
    el.textContent = `${sign}${fmt(Math.abs(delta))}`;
    el.title       = `From snapshot ${ageMin}m ago`;
    el.style.color = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : '');
}

async function loadTopLeagues({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

    try {
        const page1 = await apiFetch('/leagues?page=1&pageSize=100&sort=Points&sortOrder=desc');
        const page2 = await apiFetch('/leagues?page=2&pageSize=100&sort=Points&sortOrder=desc');
        const leagues = [...(page1.data.leagues || []), ...(page2.data.leagues || [])];
        if (!leagues.length) throw new Error('No league data returned');

        state.top200 = leagues;
        state.overallTotal = page1.data.total || leagues.length;
        if (state.mode === 'top') {
            state.leagues = leagues;
            state.total = leagues.length;
        }
        state.lastFetched = Date.now();
        save();
        renderLeaderboard();
        if (!silent) toast(`Loaded top ${leagues.length} leagues`, 'success');
    } catch (err) {
        if (!silent) toast(err.message, 'error');
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
        state.leagues = leagues;
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
        state.leagues = state.top200;
        state.total = state.top200.length;
        renderLeaderboard();
        if (!state.top200.length) loadTopLeagues({ silent: true });
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

async function fetchLeagueDetail(name) {
    try {
        const [res] = await Promise.all([apiFetch(`/leagues/${encodeURIComponent(name)}`), loadHistory()]);
        const detail = res.data;

        const needsResolve = [];
        if (isUnresolvedName(detail.Owner)) needsResolve.push(detail.Owner.UserID);
        (detail.Members || []).forEach(m => { if (isUnresolvedName(m)) needsResolve.push(m.UserID); });

        if (needsResolve.length) {
            const resolved = await resolveUsernames([...new Set(needsResolve)]);
            if (isUnresolvedName(detail.Owner) && resolved[detail.Owner.UserID]) {
                detail.Owner.DisplayName = resolved[detail.Owner.UserID];
            }
            (detail.Members || []).forEach(m => {
                if (isUnresolvedName(m) && resolved[m.UserID]) m.DisplayName = resolved[m.UserID];
            });
        }

        ui.currentLeagueDetail = detail;
        if (ui.currentLeagueName === name) renderLeagueDetail();
        resolveRank(name, detail);
    } catch (err) {
        toast(err.message, 'error');
        document.getElementById('league-detail-sub').textContent = 'Failed to load league detail.';
    }
}

// Find a league's exact global rank on the Points leaderboard.
// Fast path: it's already in the cached Top 200. Otherwise binary-search
// over leaderboard pages (each page is an exact, indexed slice sorted by
// Points desc), since there's no direct "rank of X" endpoint.
async function resolveRank(name, detail) {
    const nameLower = name.toLowerCase();

    const top200Idx = state.top200.findIndex(l => l.NameLower === nameLower || l.Name.toLowerCase() === nameLower);
    if (top200Idx !== -1) {
        ui.currentRank = top200Idx + 1;
        if (ui.currentLeagueName === name) renderLeagueDetail();
        return;
    }

    try {
        const pageSize = 100;
        const totalRes = state.overallTotal
            ? { data: { total: state.overallTotal } }
            : await apiFetch('/leagues?page=1&pageSize=1&sort=Points&sortOrder=desc');
        const total = totalRes.data.total || 0;
        state.overallTotal = total;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
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
document.getElementById('refresh-btn').addEventListener('click', () => loadTopLeagues({ silent: false }));
document.getElementById('search-league-btn').addEventListener('click', searchLeagues);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-league-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchLeagues(); }
});

// ── Auto-Refresh ───────────────────────────
setInterval(() => {
    if (state.mode === 'top') loadTopLeagues({ silent: true });
}, 120_000);

// ── Bootstrap ──────────────────────────────
load();
renderLeaderboard();
loadTopLeagues({ silent: state.leagues.length > 0 });
