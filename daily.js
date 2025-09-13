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

function fmtPct(n) { return `${n.toFixed(4)}%`; }
function llToPct(lat, lng) {
  // Equirectangular projection to percentage coords within 2:1 map
  const xPct = (lng + 180) / 360 * 100;
  const yPct = (90 - lat) / 180 * 100;
  return { xPct, yPct };
}

async function tryRenderMap() {
  const isPast = state.date < state.today;
  const mapCard = document.getElementById('map-card');
  const map = document.getElementById('map');
  const mapStatus = document.getElementById('map-status');
  // Clear previous
  map.innerHTML = '';
  mapStatus.textContent = '';
  if (!isPast) { mapCard.hidden = true; return; }

  try {
    // Load stable photos.json for this day
    const photos = await fetchJSON(`${BASE}/${state.date}/photos.json`);
    if (!Array.isArray(photos) || photos.length === 0) { mapCard.hidden = true; return; }
    mapCard.hidden = false;
    mapStatus.textContent = `${photos.length} photos`;

    // Add pins
    for (const p of photos) {
      const lat = p?.Location?.lat, lng = p?.Location?.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      const { xPct, yPct } = llToPct(lat, lng);
      const pin = document.createElement('div');
      pin.className = 'pin';
      pin.style.left = fmtPct(xPct);
      pin.style.top = fmtPct(yPct);
      pin.title = `${p.Country || ''} ${p.Year ? `(${p.Year})` : ''}`.trim();
      const dot = document.createElement('div');
      dot.className = 'pin-dot';
      const label = document.createElement('div');
      label.className = 'pin-label';
      label.textContent = p.Year || '';
      pin.appendChild(dot); pin.appendChild(label);

      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        openPhotoPopup(map, pin, p);
      });
      map.appendChild(pin);
    }

    // Close popup on outside click
    map.addEventListener('click', () => closePopup(map));
    document.addEventListener('keydown', onEscClose);
  } catch (e) {
    mapCard.hidden = true;
  }
}

function onEscClose(e) { if (e.key === 'Escape') closePopup(document.getElementById('map')); }
function closePopup(map) {
  const pop = map.querySelector('.map-popup');
  if (pop) pop.remove();
}

function openPhotoPopup(map, pinEl, photo) {
  closePopup(map);
  const rect = map.getBoundingClientRect();
  const pinRect = pinEl.getBoundingClientRect();
  const relX = pinRect.left - rect.left;
  const relY = pinRect.top - rect.top;

  // Build local image path from URL id
  let localImg = null;
  try {
    const u = new URL(photo.URL);
    const bn = u.pathname.split('/').pop() || '';
    const id = bn.replace(/\.[a-zA-Z0-9]+$/, '');
    localImg = `${BASE}/${state.date}/images/${id}.jpg`;
  } catch { /* ignore */ }

  const pop = document.createElement('div');
  pop.className = 'map-popup';
  pop.innerHTML = `
    <button class="pop-close" aria-label="Close">×</button>
    ${localImg ? `<img alt="" src="${localImg}">` : ''}
    <div class="pop-body">
      <div class="pop-title">${(photo.Country || '')}${photo.Year ? ` · ${photo.Year}` : ''}</div>
      <div class="pop-meta">${photo.Location ? `${photo.Location.lat.toFixed(4)}, ${photo.Location.lng.toFixed(4)}` : ''}</div>
      <div class="pop-desc">${(photo.Description || '')}</div>
    </div>
  `;
  map.appendChild(pop);
  const pw = pop.offsetWidth || 320;
  const ph = pop.offsetHeight || 240;
  let left = relX + 8; let top = relY + 8;
  if (left + pw > rect.width - 8) left = relX - pw - 8;
  if (top + ph > rect.height - 8) top = relY - ph - 8;
  left = Math.max(8, Math.min(left, rect.width - pw - 8));
  top = Math.max(8, Math.min(top, rect.height - ph - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.querySelector('.pop-close').addEventListener('click', (e) => { e.stopPropagation(); closePopup(map); }, { once:true });
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
    // Render map for past days
    await tryRenderMap();
  } catch (e) {
    $("tbody").innerHTML = "";
    $("empty").hidden = false;
    setStatus(`Error loading ${url}: ${e.message}`, true);
    // Hide map on error
    const mapCard = document.getElementById('map-card'); if (mapCard) mapCard.hidden = true;
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
