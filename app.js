/* ═══════════════════════════════════════════
   PS99 World Cup II — Live Leaderboard App Logic
   ═══════════════════════════════════════════ */

'use strict';

document.title = 'PS99 World Cup II [v2]';

// ── Constants ──────────────────────────────
const STORAGE_KEY  = 'ps99_worldcup2_v2';
const API_BASE      = 'https://biggamesapi.io/api';
const CORS_PROXIES  = [
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
    leaderboard: [],   // [{id, name, color, points}] — top 200, ordered by rank
    outside: [],       // [{id, name, color, points}] — searched clans not in top 200
    lastFetched: null,
    nextColorIdx: 0,
};

let ui = {
    currentTeamId: null,
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
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) {
    return (Number(n) || 0).toLocaleString();
}

function nextColor() {
    const color = PALETTE[state.nextColorIdx % PALETTE.length];
    state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    return color;
}

function findByName(list, name) {
    return list.find(c => c.name.toLowerCase() === name.toLowerCase());
}

function getTeam(id) {
    return state.leaderboard.find(t => t.id === id) || state.outside.find(t => t.id === id);
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

function showTeamDetail(teamId) {
    ui.currentTeamId = teamId;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('team-detail-view').classList.add('active');
    renderTeamDetail();
}

// ── Leaderboard rendering ──────────────────
function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    badge.innerHTML = state.lastFetched
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(state.lastFetched).toLocaleTimeString()}</span>`
        : '';

    const outsideSection = document.getElementById('outside-section');
    const outsideList = document.getElementById('outside-list');
    if (state.outside.length) {
        outsideSection.style.display = '';
        outsideList.innerHTML = [...state.outside]
            .sort((a, b) => b.points - a.points)
            .map(t => `
              <div class="manage-clan-row">
                <div class="clan-color-dot" style="background:${t.color}"></div>
                <span class="mcr-name" onclick="showTeamDetail('${t.id}')" style="cursor:pointer">${esc(t.name)}</span>
                <span class="mcr-pts">${fmt(t.points)} pts</span>
                <button class="btn-icon del" onclick="removeOutside('${t.id}')" title="Remove">🗑️</button>
              </div>`).join('');
    } else {
        outsideSection.style.display = 'none';
    }

    const tbody = document.getElementById('leaderboard-tbody');
    if (!state.leaderboard.length) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:40px;color:var(--text-muted)">
          No data yet — hit <strong>🔄 Refresh</strong> to fetch the live top 200.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = state.leaderboard.map((t, idx) => `
      <tr onclick="showTeamDetail('${t.id}')" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${t.color}"></span> ${esc(t.name)}</td>
        <td class="player-points" style="color:${t.color}">${fmt(t.points)}</td>
      </tr>`).join('');
}

function removeOutside(teamId) {
    state.outside = state.outside.filter(t => t.id !== teamId);
    save();
    renderLeaderboard();
}

// ── Team Detail ────────────────────────────
function renderTeamDetail() {
    const team = getTeam(ui.currentTeamId);
    if (!team) { showLeaderboard(); return; }

    const rankIdx = state.leaderboard.findIndex(t => t.id === team.id);
    const rankText = rankIdx !== -1 ? `#${rankIdx + 1} of ${state.leaderboard.length}` : 'Outside Top 200';

    document.getElementById('team-detail-color-bar').style.background = team.color;
    document.getElementById('team-detail-name').textContent = team.name;
    document.getElementById('team-detail-sub').textContent = 'PS99 World Cup II';
    document.getElementById('td-rank').textContent = rankText;
    document.getElementById('td-pts').textContent = fmt(team.points);
}

// ── Live PS99 API ──────────────────────────
async function apiFetch(path) {
    const url = `${API_BASE}${path}`;
    const isValid = d => d && typeof d === 'object' && !d.error && !d.Error
        && !(typeof d.message === 'string' && d.message.toLowerCase().includes('timeout'));

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

function clanCurrentPoints(clanData) {
    const battles = clanData.Battles || {};
    const keys = Object.keys(battles);
    const lastKey = keys[keys.length - 1];
    const battleObj = lastKey ? battles[lastKey] : {};
    return Number(battleObj?.Points) || 0;
}

async function loadTop200({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

    try {
        const toArr = d => Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []);
        const page1 = await apiFetch('/clans?page=1&pageSize=100&sort=Points&sortOrder=desc');
        let page2data = [];
        try {
            const p2 = await apiFetch('/clans?page=2&pageSize=100&sort=Points&sortOrder=desc');
            page2data = toArr(p2?.data);
        } catch (_) {}
        const clanList = [...toArr(page1?.data), ...page2data];
        if (!clanList.length) throw new Error('No clan data returned');

        const oldList = state.leaderboard;
        state.leaderboard = clanList.map((entry, idx) => {
            const name   = entry.Name || entry.name || `Clan_${idx}`;
            const points = entry.Points || entry.points || 0;
            const old    = findByName(oldList, name) || findByName(state.outside, name);
            const color  = old?.color || nextColor();
            return { id: old?.id || uid(), name, color, points };
        });

        // Drop any "outside" entries that have now appeared in the fresh top 200
        state.outside = state.outside.filter(t => !findByName(state.leaderboard, t.name));

        state.lastFetched = Date.now();
        save();
        renderLeaderboard();
        if (ui.currentTeamId) renderTeamDetail();
        if (!silent) toast(`Loaded top ${clanList.length} clans`, 'success');
    } catch (err) {
        if (!silent) toast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

async function searchClan() {
    const input = document.getElementById('search-clan-name');
    const name  = (input?.value || '').trim();
    if (!name) { toast('Enter a clan name', 'error'); return; }

    const btn = document.getElementById('search-clan-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${name}"…`, 'loading');

    try {
        const raw = await apiFetch(`/clan/${encodeURIComponent(name)}`);
        if (raw.status !== 'ok' || !raw.data) throw new Error(`Clan "${name}" not found`);
        const clanData   = raw.data;
        const clanName   = clanData.Name || name;
        const points     = clanCurrentPoints(clanData);

        const inTop200 = findByName(state.leaderboard, clanName);
        if (inTop200) {
            setStatus(`✅ "${esc(clanName)}" is already in the Top 200 — click its row below to view.`, 'success');
            input.value = '';
            showTeamDetail(inTop200.id);
            return;
        }

        const existing = findByName(state.outside, clanName);
        if (existing) {
            existing.points = points;
        } else {
            state.outside.push({ id: uid(), name: clanName, color: nextColor(), points });
        }
        save();
        renderLeaderboard();
        setStatus(`✅ Found "${esc(clanName)}" — ${fmt(points)} points, outside the Top 200.`, 'success');
        input.value = '';
    } catch (err) {
        setStatus(`❌ ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
    }
}

// ── Event Listeners ────────────────────────
document.getElementById('team-back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => loadTop200({ silent: false }));
document.getElementById('search-clan-btn').addEventListener('click', searchClan);
document.getElementById('search-clan-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchClan(); }
});

// ── Auto-Refresh ───────────────────────────
setInterval(() => loadTop200({ silent: true }), 120_000);

// ── Bootstrap ──────────────────────────────
load();
renderLeaderboard();
loadTop200({ silent: state.leaderboard.length > 0 });
