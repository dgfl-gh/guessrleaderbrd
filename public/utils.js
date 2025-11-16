import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';

// Shared utilities for Guessr Leaderboard frontend
export const BASE_DATA = "/data";
export const TZ = "Europe/Rome";

export const $ = (id) => document.getElementById(id);

export function fmtDateRome(d) {
  const dt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  const parts = Object.fromEntries(dt.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// Game day cutoff is 09:00 in Rome; before that, use previous date
export function todayRomeStr() {
  const CUTOVER_HOURS = 9;
  const now = Date.now();
  return fmtDateRome(new Date(now - CUTOVER_HOURS * 60 * 60 * 1000));
}
export function shiftDate(iso, days) {
  const [y,m,d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m-1, d)); t.setUTCDate(t.getUTCDate() + days);
  return fmtDateRome(t);
}
export async function fetchJSON(url) {
  const r = await fetch(`${url}?v=${Date.now()}`, { cache:"no-store" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
export function normalizeRows(data) {
  const arr = Array.isArray(data) ? data : (data.friendData || data.friends || data.entries || data.scores || []);
  const rows = arr.map(x => ({
    username: x.username ?? x.name ?? x.user?.name ?? x.playerName ?? "",
    id: x.userId ?? x.id ?? x.user?.id ?? null,
    score: Number(x.score ?? x.points ?? x.total ?? 0) || 0
  })).filter(r => r.username);
  rows.sort((a,b) => b.score - a.score);
  let rank = 0, prev = null;
  rows.forEach((r,i)=>{ if (r.score !== prev) rank = i+1; r.rank = rank; prev = r.score; });
  return rows;
}

const BASE_PALETTE = (d3.schemeTableau10 || [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ac'
]).map((color) => {
  const c = d3.color(color);
  return c ? c.formatHex() : '#888888';
});

const DEFAULT_COLOR = BASE_PALETTE[0] || '#888888';
const colorAssignments = new Map();

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

async function loadUserOrder() {
  try {
    const data = await fetchJSON(`${BASE_DATA}/users.json`);
    if (Array.isArray(data)) return data.map(normalizeName).filter(Boolean);
  } catch {}
  return [];
}

const canonicalUserOrder = await loadUserOrder();
const canonicalColorMap = new Map();
canonicalUserOrder.forEach((name, idx) => {
  if (!canonicalColorMap.has(name)) {
    const color = BASE_PALETTE[idx % BASE_PALETTE.length] || DEFAULT_COLOR;
    canonicalColorMap.set(name, color);
  }
});

export function colorForName(name) {
  const key = normalizeName(name);
  if (!key) return DEFAULT_COLOR;
  if (colorAssignments.has(key)) return colorAssignments.get(key);

  const color = canonicalColorMap.get(key) || DEFAULT_COLOR;

  colorAssignments.set(key, color);
  return color;
}

export function getQueryParam(name) {
  const m = new URLSearchParams(location.search).get(name);
  return m && typeof m === "string" ? m : null;
}

// Build a stable color map that keeps colors consistent per user across views.
export function buildColorMap(names) {
  const map = new Map();
  for (const name of names) {
    if (!name || map.has(name)) continue;
    map.set(name, colorForName(name));
  }
  return map;
}
