import { BASE_DATA as BASE, $, fetchJSON, normalizeRows, todayRomeStr, shiftDate, getQueryParam } from './utils.js';
function setStatus(msg, isErr=false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isErr ? " err" : "");
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

const state = { today: todayRomeStr(), date: todayRomeStr() };
// Support deep-linking via ?date=YYYY-MM-DD
const qd = getQueryParam("date");
if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) {
  // Ensure not in the future relative to Rome TZ
  state.date = qd > state.today ? state.today : qd;
}

function setDailyURL(replace=false) {
  const url = `/daily?date=${state.date}`;
  try {
    if (replace) history.replaceState({ date: state.date }, '', url);
    else history.pushState({ date: state.date }, '', url);
  } catch {}
}

function updateHeaderAndFooter() {
  $("meta-badge").textContent = state.date;
  $("date").value = state.date;
  $("date").max = state.today;
  $("next").disabled = state.date >= state.today;
  const p = $("path");
  if (p) p.textContent = `${BASE}/${state.date}/leaderboard.json`;
}

let leafletMap = null;
let markerLayer = null;

const mapEls = {
  card: document.getElementById('map-card'),
  status: document.getElementById('map-status'),
  container: document.getElementById('map'),
  gate: document.getElementById('map-gate'),
  gateOpen: document.getElementById('map-gate-open'),
  gateConfirm: document.getElementById('map-gate-confirm'),
  gateYes: document.getElementById('map-gate-yes'),
  gateNo: document.getElementById('map-gate-no')
};

function resetMapGate() {
  if (!mapEls.gate) return;
  if (mapEls.gateOpen) {
    mapEls.gateOpen.hidden = false;
    mapEls.gateOpen.disabled = false;
  }
  if (mapEls.gateConfirm) mapEls.gateConfirm.hidden = true;
  if (mapEls.gateYes) mapEls.gateYes.disabled = false;
  if (mapEls.gateNo) mapEls.gateNo.disabled = false;
}

function renderPhotosOnMap(photos) {
  const mapEl = mapEls.container;
  if (!mapEl) return;

  if (!leafletMap) {
    leafletMap = L.map(mapEl, { worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }).addTo(leafletMap);
  }

  if (markerLayer) leafletMap.removeLayer(markerLayer);
  markerLayer = L.featureGroup();

  const pts = [];
  for (const p of photos) {
    const lat = p?.Location?.lat, lng = p?.Location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const img = localImageFromURL(p.URL);
    const imageHtml = img
      ? `<img alt="" src="${img}" style="display:block;max-width:320px;width:100%;height:auto;border-radius:8px;margin-bottom:6px;">`
      : '';
    const html = `
        ${imageHtml}
        <div style="font-weight:700;margin-bottom:4px;">${(p.Country || '')}${p.Year ? ` · ${p.Year}` : ''}</div>
        <div style="color:#9aa3b2;font-size:12px;margin-bottom:6px;">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
        <div>${p.Description || ''}</div>`;
    const m = L.marker([lat, lng]).bindPopup(html, { maxWidth: 360 });
    markerLayer.addLayer(m);
    pts.push([lat, lng]);
  }

  markerLayer.addTo(leafletMap);
  leafletMap.invalidateSize();
  if (pts.length === 1) {
    leafletMap.setView(pts[0], 5);
  } else if (pts.length > 1) {
    leafletMap.fitBounds(markerLayer.getBounds(), { padding: [30, 30] });
  }
}

async function revealTodayMap() {
  if (!mapEls.card || !mapEls.status || !mapEls.gate || !mapEls.container || state.date !== state.today) return;
  const date = state.date;
  const yesBtn = mapEls.gateYes;
  const noBtn = mapEls.gateNo;

  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;
  mapEls.status.textContent = 'Loading…';

  try {
    const photos = await fetchJSON(`${BASE}/${date}/photos.json`);
    if (state.date !== date) return;
    if (!Array.isArray(photos) || photos.length === 0) {
      mapEls.status.textContent = 'No photos available.';
      if (yesBtn) yesBtn.disabled = false;
      if (noBtn) noBtn.disabled = false;
      return;
    }
    mapEls.container.hidden = false;
    mapEls.gate.hidden = true;
    mapEls.status.textContent = `${photos.length} photos`;
    renderPhotosOnMap(photos);
  } catch (e) {
    if (state.date === date) {
      mapEls.status.textContent = 'Error loading map.';
      if (yesBtn) yesBtn.disabled = false;
      if (noBtn) noBtn.disabled = false;
    }
  }
}

if (mapEls.gateOpen && mapEls.gateConfirm) {
  mapEls.gateOpen.addEventListener('click', () => {
    if (state.date !== state.today) return;
    mapEls.gateOpen.hidden = true;
    mapEls.gateConfirm.hidden = false;
  });
}

if (mapEls.gateNo && mapEls.gateOpen && mapEls.gateConfirm) {
  mapEls.gateNo.addEventListener('click', () => {
    if (state.date !== state.today) return;
    mapEls.gateConfirm.hidden = true;
    mapEls.gateOpen.hidden = false;
  });
}

if (mapEls.gateYes) {
  mapEls.gateYes.addEventListener('click', revealTodayMap);
}

function localImageFromURL(urlStr) {
  try {
    const u = new URL(urlStr);
    const bn = u.pathname.split('/').pop() || '';
    const id = bn.replace(/\.[a-zA-Z0-9]+$/, '');
    return `${BASE}/${state.date}/images/${id}.jpg`;
  } catch { return null; }
}

async function tryRenderMap() {
  if (!mapEls.card || !mapEls.status || !mapEls.container) return;
  const currentDate = state.date;
  const isPast = currentDate < state.today;
  const isToday = currentDate === state.today;

  mapEls.status.textContent = '';
  mapEls.container.hidden = true;
  mapEls.card.hidden = true;
  resetMapGate();
  if (mapEls.gate) mapEls.gate.hidden = true;

  if (isPast) {
    try {
      const photos = await fetchJSON(`${BASE}/${currentDate}/photos.json`);
      if (state.date !== currentDate) return;
      if (!Array.isArray(photos) || photos.length === 0) return;
      mapEls.card.hidden = false;
      mapEls.container.hidden = false;
      mapEls.gate.hidden = true;
      mapEls.status.textContent = `${photos.length} photos`;
      renderPhotosOnMap(photos);
    } catch (e) {
      if (state.date === currentDate) mapEls.card.hidden = true;
    }
    return;
  }

  if (isToday) {
    mapEls.card.hidden = false;
    if (mapEls.gate) mapEls.gate.hidden = false;
  }
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
    } else {
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
    }
    // Render map for past days (even if no leaderboard rows)
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
  setDailyURL(false);
  return load();
}

// wire up
$("prev").addEventListener("click", () => go(-1));
$("next").addEventListener("click", () => go(+1));
$("reload").addEventListener("click", () => load(true));
$("date").addEventListener("change", () => {
  state.date = $("date").value || state.today;
  setDailyURL(false);
  load();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  if (e.key === "ArrowRight") { e.preventDefault(); go(+1); }
});

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const search = new URLSearchParams(location.search);
  const d = search.get('date');
  const iso = (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : state.today;
  if (iso !== state.date) {
    state.date = iso > state.today ? state.today : iso;
    load();
  }
});

// init
updateHeaderAndFooter();
// Ensure URL reflects initial date selection without adding history entry
setDailyURL(true);
load();
