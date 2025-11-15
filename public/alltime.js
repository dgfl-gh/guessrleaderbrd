import { BASE_DATA, $, fetchJSON, normalizeRows, buildColorMap } from './utils.js';

const MAX_USERS = 8; // Show top N lines
let CHART_MODE = 'total'; // 'total' | 'mean'
let cachedReport = null;
let reportPromise = null;

function getModeFromURL() {
  const m = new URLSearchParams(location.search).get('mode');
  if (!m) return null;
  const v = String(m).toLowerCase();
  if (v === 'mean' || v === 'average' || v === 'avg') return 'mean';
  return 'total';
}

function setModeURL(mode, replace=false) {
  const m = mode === 'mean' ? 'average' : 'total';
  const url = `/alltime?mode=${m}`;
  try {
    if (replace) history.replaceState({ mode: m }, '', url);
    else history.pushState({ mode: m }, '', url);
  } catch {}
}

function setStatus(msg, isErr=false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isErr ? " err" : "");
}

async function loadIndex() {
  const url = `${BASE_DATA}/index.json`;
  const data = await fetchJSON(url);
  const dates = Array.isArray(data) ? data.slice() : (Array.isArray(data.dates) ? data.dates.slice() : []);
  dates.sort();
  return dates;
}

async function fetchDay(date) {
  const url = `${BASE_DATA}/${date}/leaderboard.json`;
  try {
    const data = await fetchJSON(url);
    return normalizeRows(data);
  } catch (e) {
    return [];
  }
}

function linePath(points, w, h, maxY) {
  if (!points.length) return '';
  const n = points.length - 1;
  const x = (i) => (i / (n || 1)) * w;
  const y = (v) => h - (maxY ? (v / maxY) * h : 0);
  let d = `M ${x(0)} ${y(points[0])}`;
  for (let i=1; i<points.length; i++) d += ` L ${x(i)} ${y(points[i])}`;
  return d;
}

function renderChart(svg, dates, users) {
  const w = 1000, h = 320, padL = 40, padB = 24, padR = 8, padT = 8;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const seriesLast = (u) => (CHART_MODE === 'mean' ? (u.meanSeries?.[u.meanSeries.length-1] || 0) : (u.cumulative?.[u.cumulative.length-1] || 0));
  const maxY = Math.max(1, ...users.map(seriesLast));

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = '';

  const g = document.createElementNS('http://www.w3.org/2000/svg','g');
  g.setAttribute('transform', `translate(${padL},${padT})`);

  // grid lines
  const grid = document.createElementNS('http://www.w3.org/2000/svg','g');
  grid.setAttribute('class', 'grid-lines');
  const ticks = 4;
  for (let i=0; i<=ticks; i++) {
    const y = (i / ticks) * innerH;
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1', '0'); line.setAttribute('x2', String(innerW));
    line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    grid.appendChild(line);
  }
  g.appendChild(grid);

  // lines
  for (const u of users) {
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', u.color);
    path.setAttribute('stroke-width', '2');
    const pts = (CHART_MODE === 'mean' ? u.meanSeries : u.cumulative) || [];
    path.setAttribute('d', linePath(pts, innerW, innerH, maxY));
    g.appendChild(path);
  }

  svg.appendChild(g);
}

function renderLegend(users) {
  const legend = $("legend");
  legend.innerHTML = '';
  for (const u of users) {
    const el = document.createElement('div');
    el.className = 'legend-item';
    el.innerHTML = `<span class=\"swatch\" style=\"background:${u.color}\"></span><span>${u.username}</span>`;
    legend.appendChild(el);
  }
}

function renderTable(users) {
  const tbody = $("tbody");
  tbody.innerHTML = '';
  if (!users.length) { $("empty").hidden = false; return; }
  $("empty").hidden = true;
  let rank = 0, prev = null;
  users.forEach((u,i)=>{ if (u.total !== prev) rank = i+1; u.rank = rank; prev = u.total; });
  const frag = document.createDocumentFragment();
  for (const r of users) {
    const tr = document.createElement('tr');
    const avg = r.days ? (r.total / r.days) : 0;
    tr.innerHTML = `
      <td class=\"rank\">${r.rank}</td>
      <td class=\"username\">${r.username}</td>
      <td class=\"score\">${r.total.toLocaleString('en-US')}</td>
      <td class=\"score\">${r.days}</td>
      <td class=\"score\">${r.days ? avg.toFixed(1) : '–'}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

async function gatherAllTimeData(onProgress = () => {}) {
  onProgress('Loading index…');
  let dates;
  try {
    dates = await loadIndex();
  } catch (e) {
    throw new Error(`Error loading index.json: ${e.message}`);
  }
  if (!dates.length) return { dates: [], users: [], topUsers: [] };

  const byUser = new Map();
  const batch = 6;
  const allRowsByDate = [];
  for (let i=0; i<dates.length; i+=batch) {
    onProgress(`Loading days ${Math.min(i+1,dates.length)}-${Math.min(i+batch,dates.length)} of ${dates.length}…`);
    const part = dates.slice(i, i+batch).map(d => fetchDay(d).then(rows => ({date:d, rows})));
    const res = await Promise.all(part);
    allRowsByDate.push(...res);
  }
  allRowsByDate.sort((a,b)=> a.date.localeCompare(b.date));

  for (const {date, rows} of allRowsByDate) {
    for (const r of rows) {
      if (!byUser.has(r.username)) byUser.set(r.username, { username:r.username, total:0, perDay:new Map() });
      const u = byUser.get(r.username);
      u.total += r.score;
      u.perDay.set(date, (u.perDay.get(date) || 0) + r.score);
    }
  }

  const users = Array.from(byUser.values());
  for (const u of users) u.days = u.perDay.size;
  users.sort((a,b)=> b.total - a.total);

  const colorMap = buildColorMap(users.map(u => u.username));
  const topUsers = users.slice(0, MAX_USERS).map(u => ({...u, color: colorMap.get(u.username)}));
  for (const u of topUsers) {
    const cum = [];
    const mean = [];
    let acc = 0, played = 0;
    for (const d of dates) {
      const v = u.perDay.get(d) || 0;
      acc += v;
      if (v > 0) played++;
      cum.push(acc);
      mean.push(played > 0 ? (acc / played) : 0);
    }
    u.cumulative = cum;
    u.meanSeries = mean;
  }

  return { dates, users, topUsers };
}

function renderAllTimeView({ dates, users, topUsers }) {
  renderChart($("chart"), dates, topUsers);
  renderLegend(topUsers);
  renderTable(users);
}

function renderFromReport(report, source = 'fresh') {
  if (!report) return;
  $("meta-badge").textContent = `${report.dates.length} days`;
  renderAllTimeView(report);
  if (!report.dates.length) setStatus('No dates found.');
  else {
    const suffix = source === 'cache' ? ' (cached)' : '';
    setStatus(`Loaded ${report.dates.length} days, ${report.users.length} users${suffix}`);
  }
}

async function loadAllTime({ force = false } = {}) {
  if (force) {
    cachedReport = null;
    reportPromise = null;
  }

  if (cachedReport && !force) {
    setStatus('Rendering cached data…');
    renderFromReport(cachedReport, 'cache');
    return cachedReport;
  }

  if (!reportPromise) {
    reportPromise = gatherAllTimeData(setStatus)
      .then((report) => {
        cachedReport = report;
        return report;
      })
      .catch((err) => {
        cachedReport = null;
        throw err;
      })
      .finally(() => {
        reportPromise = null;
      });
  }

  try {
    const report = await reportPromise;
    renderFromReport(report, 'fresh');
    return report;
  } catch (e) {
    setStatus(e.message || 'Unknown error loading data', true);
    return null;
  }
}

// Wire chart mode toggle
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'metric') {
    CHART_MODE = e.target.value === 'mean' ? 'mean' : 'total';
    setModeURL(CHART_MODE, false);
    if (cachedReport) renderFromReport(cachedReport, 'cache');
    else loadAllTime();
  }
});

// Initialize mode from URL if present
(function initMode() {
  const fromURL = getModeFromURL();
  if (fromURL) {
    CHART_MODE = fromURL;
    const sel = document.getElementById('metric');
    if (sel) sel.value = (CHART_MODE === 'mean' ? 'mean' : 'total');
  }
  // Ensure URL reflects current mode without growing history
  setModeURL(CHART_MODE, true);
})();

// Handle browser back/forward to keep mode in sync
window.addEventListener('popstate', () => {
  const fromURL = getModeFromURL();
  const newMode = fromURL || 'total';
  if (newMode !== CHART_MODE) {
    CHART_MODE = newMode;
    const sel = document.getElementById('metric');
    if (sel) sel.value = (CHART_MODE === 'mean' ? 'mean' : 'total');
    if (cachedReport) renderFromReport(cachedReport, 'cache');
    else loadAllTime();
  }
});

loadAllTime();
