import { BASE_DATA as BASE, $, fetchJSON, normalizeRows, todayRomeStr, shiftDate, getQueryParam } from './utils.js';
function setStatus(msg, isErr=false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isErr ? " err" : "");
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

const state = { today: todayRomeStr(), date: todayRomeStr() };
const MAPBOX_STYLES = {
  streets: 'mapbox://styles/mapbox/standard',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
};
const mapState = {
  map: null,
  ready: null,
  markers: [],
  currentStyle: 'streets',
  lastPhotos: null
};
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

const mapEls = {
  card: document.getElementById('map-card'),
  status: document.getElementById('map-status'),
  wrapper: document.querySelector('#map-card .map-container'),
  controls: document.querySelector('#map-card .map-controls'),
  canvas: document.getElementById('map'),
  layerButtons: Array.from(document.querySelectorAll('#map-card [data-map-style]')),
  gate: document.getElementById('map-gate'),
  gateOpen: document.getElementById('map-gate-open'),
  gateConfirm: document.getElementById('map-gate-confirm'),
  gateYes: document.getElementById('map-gate-yes'),
  gateNo: document.getElementById('map-gate-no')
};

updateLayerButtons(mapState.currentStyle);

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

function getMapboxToken() {
  try {
    return (window.GUESSR_CONFIG?.mapboxToken || window.MAPBOX_TOKEN || '').trim();
  } catch {
    return '';
  }
}

let controlsBound = false;
function bindMapControls() {
  if (controlsBound) return;
  controlsBound = true;
  mapEls.layerButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.mapStyle;
      if (key) setMapStyle(key);
    });
  });
}

function createNumberedMarker(index) {
  const el = document.createElement('div');
  el.className = 'photo-marker';
  const label = index < 5 ? String(index + 1) : '•';
  el.textContent = label;
  el.setAttribute('aria-label', `Photo ${index + 1}`);
  return el;
}

function updateLayerButtons(activeKey) {
  mapEls.layerButtons.forEach((btn) => {
    const isActive = btn.dataset.mapStyle === activeKey;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}

function setMapStyle(styleKey) {
  if (!MAPBOX_STYLES[styleKey] || mapState.currentStyle === styleKey) return;
  mapState.currentStyle = styleKey;
  updateLayerButtons(styleKey);
  if (mapState.map) {
    mapState.map.setStyle(MAPBOX_STYLES[styleKey]);
    if (mapState.lastPhotos) {
      mapState.map.once('styledata', () => {
        renderPhotosOnMap(mapState.lastPhotos, { preserveView: true });
      });
    }
  }
}

function hideMap() {
  if (mapEls.wrapper) mapEls.wrapper.hidden = true;
  if (mapEls.controls) mapEls.controls.hidden = true;
}

function setMapStatus(text) {
  if (mapEls.status) mapEls.status.textContent = text || '';
}

async function ensureMapReady() {
  if (!mapEls.canvas || !mapEls.wrapper) return null;
  if (mapState.ready) return mapState.ready;
  const token = getMapboxToken();
  if (!token) {
    setMapStatus('Map unavailable: missing Mapbox token.');
    return null;
  }
  if (typeof mapboxgl === 'undefined') {
    setMapStatus('Map unavailable: Mapbox library failed to load.');
    return null;
  }
  mapboxgl.accessToken = token;
  console.log(mapEls.canvas);
  mapState.map = new mapboxgl.Map({
    container: mapEls.canvas,
    style: MAPBOX_STYLES[mapState.currentStyle],
    center: [0, 25],
    zoom: 1.3,
    projection: 'globe',
    renderWorldCopies: true,
    dragRotate: true,
  });
  mapState.map.addControl(new mapboxgl.FullscreenControl());
  mapState.map.addControl(new mapboxgl.NavigationControl());
  mapState.ready = new Promise((resolve) => {
    mapState.map.once('load', () => {
      console.log("Map loaded");
      resolve(mapState.map);
    });
  });
  bindMapControls();
  return mapState.ready;
}

function clearMarkers() {
  mapState.markers.forEach((marker) => marker.remove());
  mapState.markers = [];
}

async function renderPhotosOnMap(photos, options = {}) {
  const map = await ensureMapReady();
  if (!map) return false;
  const { preserveView = false } = options;
  if (mapEls.wrapper) mapEls.wrapper.hidden = false;
  if (mapEls.controls) mapEls.controls.hidden = false;
  clearMarkers();
  const bounds = new mapboxgl.LngLatBounds();
  let hasBounds = false;
  let firstPoint = null;
  let validCount = 0;
  (photos || []).forEach((photo, index) => {
    const lat = photo?.Location?.lat;
    const lng = photo?.Location?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
    const popupNode = document.createElement('div');
    popupNode.className = 'map-popup-inner';
    const img = localImageFromURL(photo.URL);
    popupNode.innerHTML = `
      ${img ? `<img alt="" src="${img}" style="display:block;width:100%;height:auto;border-radius:8px;margin-bottom:6px;">` : ''}
      <div style="font-weight:700;margin-bottom:4px;">${photo.Country || ''}${photo.Year ? ` · ${photo.Year}` : ''}</div>
      <div style="color:#9aa3b2;font-size:12px;margin-bottom:6px;">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
      <div>${photo.Description || ''}</div>`;
    const popup = new mapboxgl.Popup({ offset: 16, maxWidth: '360px' }).setDOMContent(popupNode);
    const marker = new mapboxgl.Marker({ element: createNumberedMarker(index), anchor: 'bottom' })
      .setLngLat([lng, lat])
      .setPopup(popup)
      .addTo(map);
    mapState.markers.push(marker);
    bounds.extend([lng, lat]);
    if (!firstPoint) firstPoint = [lng, lat];
    hasBounds = true;
    validCount++;
  });
  if (!preserveView) {
    if (validCount === 1 && firstPoint) {
      map.easeTo({ center: firstPoint, zoom: 5, duration: 900 });
    } else if (hasBounds) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 8, duration: 900 });
    } else {
      map.easeTo({ center: [0, 25], zoom: 1.2, duration: 600 });
    }
  }
  // for some reason we need to delay this a bit to ensure proper resizing
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
    console.log("Map resized");
  }, 1);
  return validCount > 0;
}

async function revealTodayMap() {
  if (!mapEls.card || !mapEls.status || !mapEls.gate || !mapEls.wrapper || state.date !== state.today) return;
  const date = state.date;
  const yesBtn = mapEls.gateYes;
  const noBtn = mapEls.gateNo;

  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;
  setMapStatus('Loading…');

  try {
    const photos = await fetchJSON(`${BASE}/${date}/photos.json`);
    if (state.date !== date) return;
    if (!Array.isArray(photos) || photos.length === 0) {
      setMapStatus('No photos available.');
      if (yesBtn) yesBtn.disabled = false;
      if (noBtn) noBtn.disabled = false;
      resetMapGate();
      if (mapEls.gate) mapEls.gate.hidden = false;
      return;
    }
    const rendered = await renderPhotosOnMap(photos);
    if (!rendered) {
      setMapStatus('Unable to display map.');
      if (yesBtn) yesBtn.disabled = false;
      if (noBtn) noBtn.disabled = false;
      resetMapGate();
      if (mapEls.gate) mapEls.gate.hidden = false;
      return;
    }
    mapEls.card.hidden = false;
    if (mapEls.gate) mapEls.gate.hidden = true;
    setMapStatus(`${photos.length} photos`);
  } catch (e) {
    if (state.date === date) {
      setMapStatus('Error loading map.');
      if (yesBtn) yesBtn.disabled = false;
      if (noBtn) noBtn.disabled = false;
      resetMapGate();
      if (mapEls.gate) mapEls.gate.hidden = false;
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
  if (!mapEls.card || !mapEls.status || !mapEls.wrapper) return;
  const currentDate = state.date;
  const isPast = currentDate < state.today;
  const isToday = currentDate === state.today;

  setMapStatus('');
  hideMap();
  mapEls.card.hidden = true;
  resetMapGate();
  if (mapEls.gate) mapEls.gate.hidden = true;

  if (isPast) {
    try {
      const photos = await fetchJSON(`${BASE}/${currentDate}/photos.json`);
      if (state.date !== currentDate) return;
      if (!Array.isArray(photos) || photos.length === 0) return;
      const rendered = await renderPhotosOnMap(photos);
      if (!rendered) {
        mapEls.card.hidden = false;
        return;
      }
      mapEls.card.hidden = false;
      if (mapEls.gate) mapEls.gate.hidden = true;
      setMapStatus(`${photos.length} photos`);
    } catch (e) {
      if (state.date === currentDate) {
        mapEls.card.hidden = true;
        setMapStatus('Unable to load photo locations.');
      }
    }
    return;
  }

  if (isToday) {
    mapEls.card.hidden = false;
    if (mapEls.gate) mapEls.gate.hidden = false;
    setMapStatus('Spoiler protection active.');
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

window.addEventListener('resize', () => {
  if (mapState.map) {
    mapState.map.resize();
  }
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
