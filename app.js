const BASE = "/src/guessrleaderbrd/data";
const TZ = "Europe/Rome";

const $ = (id) => document.getElementById(id);

function fmtDateRome(d) {
  const dt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  const parts = Object.fromEntries(dt.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// Game day cutoff is 09:00 in Rome; before that, use previous date
function todayRomeStr() {
  const CUTOVER_HOURS = 9;
  const now = Date.now();
  return fmtDateRome(new Date(now - CUTOVER_HOURS * 60 * 60 * 1000));
}
function shiftDate(iso, days) {
  const [y,m,d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m-1, d)); t.setUTCDate(t.getUTCDate() + days);
  return fmtDateRome(t);
}
async function fetchJSON(url) {
  const r = await fetch(`${url}?v=${Date.now()}`, { cache:"no-store" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
function normalizeRows(data) {
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
function setStatus(msg, isErr=false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isErr ? " err" : "");
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

function getQueryParam(name) {
  const m = new URLSearchParams(location.search).get(name);
  return m && typeof m === "string" ? m : null;
}

const state = { today: todayRomeStr(), date: todayRomeStr() };
// Support deep-linking via ?date=YYYY-MM-DD
const qd = getQueryParam("date");
if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) {
  // Ensure not in the future relative to Rome TZ
  state.date = qd > state.today ? state.today : qd;
}

function updateHeaderAndFooter() {
  $("meta-badge").textContent = state.date;
  $("date").value = state.date;
  $("date").max = state.today;
  $("next").disabled = state.date >= state.today;
  const p = $("path");
  if (p) p.textContent = `${BASE}/${state.date}/leaderboard.json`;
}

async function load(bust=false) {
  setStatus("Loading…");
  updateHeaderAndFooter();
  const url = `${BASE}/${state.date}/leaderboard.json`;
  try {
    const data = await fetchJSON(bust ? `${url}?t=${Date.now()}` : url);
    const rows = normalizeRows(data);
    const tbody = $("tbody");
    tbody.innerHTML = "";
    if (!rows.length) {
      $("empty").hidden = false;
      setStatus("No rows.");
      return;
    }
    $("empty").hidden = true;
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="rank">${r.rank}</td>
        <td class="username">${escapeHtml(r.username)}</td>
        <td class="score">${r.score.toLocaleString("en-US")}</td>
      `;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    setStatus(`Loaded ${rows.length} entries`);
  } catch (e) {
    $("tbody").innerHTML = "";
    $("empty").hidden = false;
    setStatus(`Error loading ${url}: ${e.message}`, true);
  }
}

function go(delta) {
  state.date = shiftDate(state.date, delta);
  if (state.date > state.today) state.date = state.today;
  return load();
}

// wire up
$("prev").addEventListener("click", () => go(-1));
$("next").addEventListener("click", () => go(+1));
$("reload").addEventListener("click", () => load(true));
$("date").addEventListener("change", () => { state.date = $("date").value || state.today; load(); });
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  if (e.key === "ArrowRight") { e.preventDefault(); go(+1); }
});

// init
updateHeaderAndFooter();
load();
