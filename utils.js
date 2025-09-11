// Shared utilities for Guessr Leaderboard frontend
export const BASE_DATA = "/src/guessrleaderbrd/data";
export const TZ = "Europe/Rome";

export const $ = (id) => document.getElementById(id);

export function fmtDateRome(d) {
  const dt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  const parts = Object.fromEntries(dt.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function todayRomeStr() { return fmtDateRome(new Date()); }
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

// Stable color per user name using HSL
// Distinct, accessible colors (6 users max). Tweak as desired.
const PALETTE = [
  '#e76f51', // persimmon
  '#2a9d8f', // teal
  '#e9c46a', // sand
  '#f4a261', // orange
  '#457b9d', // blue
  '#a78bfa', // lavender
];

export function colorForName(name) {
  let h = 0;
  for (let i=0; i<name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function getQueryParam(name) {
  const m = new URLSearchParams(location.search).get(name);
  return m && typeof m === "string" ? m : null;
}

// Build a stable, collision-free color map for a given user set.
export function buildColorMap(names) {
  const uniq = Array.from(new Set(names.filter(Boolean)));
  uniq.sort((a,b)=>a.localeCompare(b));
  const map = new Map();
  for (let i=0; i<uniq.length; i++) {
    map.set(uniq[i], PALETTE[i % PALETTE.length]);
  }
  return map;
}
