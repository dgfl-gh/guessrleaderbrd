import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { BASE_DATA, $, fetchJSON, normalizeRows, buildColorMap } from './utils.js';

const MAX_USERS = 8; // Show top N lines
let CHART_MODE = 'total'; // 'total' | 'mean'
const ROLLING_MIN = 1;
const ROLLING_MAX = 60;
let rollingWindow = 7;
let cachedReport = null;
let reportPromise = null;
let tableSort = { key: 'total', direction: 'desc' };

function getModeFromURL() {
  const m = new URLSearchParams(location.search).get('mode');
  if (!m) return null;
  const v = String(m).toLowerCase();
  if (v === 'mean' || v === 'average' || v === 'avg') return 'mean';
  if (v === 'scatter' || v === 'daily') return 'scatter';
  return 'total';
}

function setModeURL(mode, replace=false) {
  let m = 'total';
  if (mode === 'mean') m = 'average';
  else if (mode === 'scatter') m = 'scatter';
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

function lightenColor(colorStr) {
  const c = d3.color(colorStr);
  if (!c) return colorStr;
  return c.brighter(0.6).formatRgb();
}

function renderMetricChart(report) {
  if (CHART_MODE === 'scatter') return;
  const svgElement = $("chart");
  if (!svgElement) return;

  const dates = report.dates;
  const svg = d3.select(svgElement);
  if (!dates.length) {
    svg.selectAll('*').remove();
    return;
  }
  const dateObjs = dates.map((d) => new Date(`${d}T00:00:00Z`));
  const width = svgElement.clientWidth || 1000;
  const height = 320;
  const margin = { top: 16, right: 32, bottom: 32, left: 48 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const x = d3.scaleTime()
    .domain(d3.extent(dateObjs))
    .range([0, innerWidth]);

  const topUsers = report.topUsers || [];
  const baseSeries = topUsers.map((user) => ({
    user,
    values: getSeriesForMode(user)
  }));
  const showRolling = shouldShowRollingOverlay();
  const rollingSeries = showRolling ? topUsers.map((user) => ({
    user,
    points: getRollingSeries(user, rollingWindow)
  })) : [];

  const allValues = baseSeries
    .flatMap((s) => s.values)
    .concat(showRolling ? rollingSeries.flatMap((s) => s.points.map((p) => p.value)) : [])
    .filter((v) => v != null);
  const maxY = Math.max(1, allValues.length ? d3.max(allValues) : 1);

  const y = d3.scaleLinear()
    .domain([0, maxY * 1.05])
    .range([innerHeight, 0])
    .nice();

  const lineGenerator = d3.line()
    .defined((d) => d != null)
    .x((_, i) => x(dateObjs[i]))
    .y((d) => y(d))
    .curve(d3.curveMonotoneX);
  const rollingLine = d3.line()
    .x((d) => x(dateObjs[d.index]))
    .y((d) => y(d.value))
    .curve(d3.curveMonotoneX);

  const root = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const axisY = d3.axisLeft(y).ticks(5).tickSize(-innerWidth).tickFormat(d3.format(','));
  const gy = root.append('g').attr('class', 'axis axis-y').call(axisY);
  gy.select('.domain').remove();
  gy.selectAll('.tick line').attr('stroke', '#1d2130');
  gy.selectAll('text').attr('fill', 'var(--muted)').attr('font-size', '11px');

  const axisX = d3.axisBottom(x)
    .ticks(Math.min(10, dates.length))
    .tickFormat(d3.timeFormat(dates.length > 120 ? '%Y-%m' : '%b %d'));
  const gx = root.append('g').attr('class', 'axis axis-x').attr('transform', `translate(0,${innerHeight})`).call(axisX);
  gx.select('.domain').attr('stroke', '#2a2f3a');
  gx.selectAll('text').attr('fill', 'var(--muted)').attr('font-size', '11px').attr('dy', '0.9em');

  for (const series of baseSeries) {
    root.append('path')
      .datum(series.values)
      .attr('fill', 'none')
      .attr('stroke', series.user.color)
      .attr('stroke-width', 2)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .attr('d', lineGenerator);
  }

  if (showRolling) {
    for (const series of rollingSeries) {
      if (!series.points.length) continue;
      root.append('path')
        .datum(series.points)
        .attr('fill', 'none')
        .attr('stroke', lightenColor(series.user.color))
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5 4')
        .attr('opacity', 0.95)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round')
        .attr('d', rollingLine);
    }
  }
}

function renderScatterChart(report) {
  const svgElement = $("chart");
  if (!svgElement) return;
  const svg = d3.select(svgElement);
  if (CHART_MODE !== 'scatter') {
    svg.selectAll('*').remove();
    return;
  }
  const dates = report.dates;
  if (!dates.length) {
    svg.selectAll('*').remove();
    return;
  }
  const dateObjs = dates.map((d) => new Date(`${d}T00:00:00Z`));
  const width = svgElement.clientWidth || 1000;
  const height = 320;
  const margin = { top: 16, right: 32, bottom: 32, left: 48 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.attr('viewBox', `0 0 ${width} ${height}`);
  svg.selectAll('*').remove();

  const x = d3.scaleTime()
    .domain(d3.extent(dateObjs))
    .range([0, innerWidth]);

  const topUsers = report.topUsers || [];
  const rollingSeries = topUsers.map((user) => ({
    user,
    points: getRollingSeries(user, rollingWindow)
  }));
  const points = [];
  topUsers.forEach((user) => {
    (user.dailyScores || []).forEach((value, idx) => {
      if (value == null) return;
      points.push({ user, value, index: idx, date: dateObjs[idx] });
    });
  });

  const rollingValues = rollingSeries.flatMap((s) => s.points.map((p) => p.value));
  const yCandidates = [];
  if (points.length) yCandidates.push(d3.max(points, (p) => p.value));
  if (rollingValues.length) yCandidates.push(d3.max(rollingValues));
  const maxY = Math.max(1, yCandidates.length ? d3.max(yCandidates) : 1);

  const y = d3.scaleLinear()
    .domain([0, maxY * 1.05])
    .range([innerHeight, 0])
    .nice();

  const rollingLine = d3.line()
    .x((d) => x(dateObjs[d.index]))
    .y((d) => y(d.value))
    .curve(d3.curveMonotoneX);

  const root = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const axisY = d3.axisLeft(y).ticks(5).tickSize(-innerWidth).tickFormat(d3.format(','));
  const gy = root.append('g').attr('class', 'axis axis-y').call(axisY);
  gy.select('.domain').remove();
  gy.selectAll('.tick line').attr('stroke', '#1d2130');
  gy.selectAll('text').attr('fill', 'var(--muted)').attr('font-size', '11px');

  const axisX = d3.axisBottom(x)
    .ticks(Math.min(10, dates.length))
    .tickFormat(d3.timeFormat(dates.length > 120 ? '%Y-%m' : '%b %d'));
  const gx = root.append('g').attr('class', 'axis axis-x').attr('transform', `translate(0,${innerHeight})`).call(axisX);
  gx.select('.domain').attr('stroke', '#2a2f3a');
  gx.selectAll('text').attr('fill', 'var(--muted)').attr('font-size', '11px').attr('dy', '0.9em');

  root.append('g')
    .attr('class', 'points')
    .selectAll('circle')
    .data(points)
    .join('circle')
    .attr('cx', (d) => x(d.date))
    .attr('cy', (d) => y(d.value))
    .attr('r', 3)
    .attr('fill', (d) => d.user.color)
    .attr('fill-opacity', 0.85)
    .attr('stroke', 'rgba(0,0,0,0.45)')
    .attr('stroke-width', 0.5);

  for (const series of rollingSeries) {
    if (!series.points.length) continue;
    root.append('path')
      .datum(series.points)
      .attr('fill', 'none')
      .attr('stroke', lightenColor(series.user.color))
      .attr('stroke-width', 1.8)
      .attr('stroke-dasharray', '4 3')
      .attr('opacity', 0.95)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .attr('d', rollingLine);
  }
}

function getSeriesForMode(user) {
  return CHART_MODE === 'mean' ? (user.meanSeries || []) : (user.cumulative || []);
}

function shouldShowRollingOverlay() {
  return CHART_MODE === 'mean' || CHART_MODE === 'scatter';
}

function getRollingSeries(user, windowSize) {
  if (!user.dailyScores) return [];
  if (!user.rollingCache) user.rollingCache = new Map();
  if (user.rollingCache.has(windowSize)) return user.rollingCache.get(windowSize);

  const scores = user.dailyScores;
  const windowValues = [];
  const firstIndex = user.firstPlayIndex ?? -1;
  let sum = 0;
  const points = [];

  for (let i=0; i<scores.length; i++) {
    const val = scores[i];
    if (val == null) continue;
    windowValues.push(val);
    sum += val;
    if (windowValues.length > windowSize) {
      sum -= windowValues.shift();
    }
    if (firstIndex !== -1 && i >= firstIndex) {
      const avg = windowValues.length ? (sum / windowValues.length) : null;
      if (avg != null) points.push({ index: i, value: avg });
    }
  }

  user.rollingCache.set(windowSize, points);
  return points;
}

function hydrateUserSeries(user, dates) {
  const dailyTotals = new Array(dates.length);
  const dailyScores = new Array(dates.length).fill(null);
  const cumulative = new Array(dates.length);
  const meanSeries = new Array(dates.length);
  let acc = 0;
  let played = 0;
  let firstPlayIndex = -1;

  for (let i=0; i<dates.length; i++) {
    const raw = user.perDay.has(dates[i]) ? user.perDay.get(dates[i]) : null;
    const value = raw ?? 0;
    dailyTotals[i] = value;
    const participated = raw != null;
    if (participated) {
      dailyScores[i] = value;
      if (firstPlayIndex === -1) firstPlayIndex = i;
      played++;
    }
    acc += value;
    cumulative[i] = acc;
    meanSeries[i] = played > 0 ? (acc / played) : null;
  }

  user.dailyTotals = dailyTotals;
  user.dailyScores = dailyScores;
  user.cumulative = cumulative;
  user.meanSeries = meanSeries;
  user.firstPlayIndex = firstPlayIndex;
  user.rollingCache = new Map();
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
  if (!users.length) { $("empty").hidden = false; updateSortIndicators(); return; }
  $("empty").hidden = true;
  const dir = tableSort.direction === 'asc' ? 1 : -1;
  const sorted = users.slice().sort((a, b) => compareUsers(a, b, tableSort.key) * dir);
  const frag = document.createDocumentFragment();
  for (const r of sorted) {
    const tr = document.createElement('tr');
    const avg = getUserAverage(r);
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
  updateSortIndicators();
}

function getUserAverage(user) {
  return user.days ? (user.total / user.days) : 0;
}

function compareUsers(a, b, key) {
  switch (key) {
    case 'rank':
      return a.rank - b.rank;
    case 'username':
      return a.username.localeCompare(b.username, undefined, { sensitivity: 'base' });
    case 'days':
      return a.days - b.days;
    case 'average':
      return getUserAverage(a) - getUserAverage(b);
    case 'total':
    default:
      return a.total - b.total;
  }
}

const sortableHeaders = Array.from(document.querySelectorAll('th[data-sort]'));

function updateSortIndicators() {
  sortableHeaders.forEach((th) => {
    const key = th.dataset.sort;
    if (!key) return;
    const dir = key === tableSort.key ? tableSort.direction : '';
    if (dir) {
      th.setAttribute('data-sort-dir', dir);
      th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('data-sort-dir');
      th.setAttribute('aria-sort', 'none');
    }
  });
}

function defaultSortDirection(key) {
  if (key === 'username' || key === 'rank') return 'asc';
  return 'desc';
}

sortableHeaders.forEach((th) => {
  const key = th.dataset.sort;
  if (!key) return;
  const activate = () => {
    if (tableSort.key === key) {
      tableSort.direction = tableSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      tableSort = { key, direction: defaultSortDirection(key) };
    }
    if (cachedReport) renderTable(cachedReport.users || []);
  };
  th.addEventListener('click', activate);
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
});
updateSortIndicators();

function clampWindow(value) {
  const num = Math.round(Number(value));
  if (Number.isNaN(num)) return ROLLING_MIN;
  return Math.min(ROLLING_MAX, Math.max(ROLLING_MIN, num));
}

const rollingControlsEl = document.getElementById('rolling-controls');
const rollingRange = document.getElementById('rolling-window');
const rollingValue = document.getElementById('rolling-window-value');

function syncRollingInputs(value) {
  if (rollingRange && document.activeElement !== rollingRange) rollingRange.value = String(value);
  if (rollingValue) {
    rollingValue.textContent = `${value} day${value === 1 ? '' : 's'}`;
  }
}

function updateRollingControlsVisibility() {
  if (!rollingControlsEl) return;
  const show = CHART_MODE !== 'total';
  rollingControlsEl.hidden = !show;
  rollingControlsEl.setAttribute('aria-hidden', show ? 'false' : 'true');
  rollingControlsEl.style.display = show ? '' : 'none';
}

function setRollingWindow(value, { rerender = true } = {}) {
  const next = clampWindow(value);
  if (next === rollingWindow) {
    syncRollingInputs(next);
    return;
  }
  rollingWindow = next;
  syncRollingInputs(next);
  if (rerender && cachedReport) renderFromReport(cachedReport, 'cache');
}

if (rollingRange) {
  rollingWindow = clampWindow(rollingRange.value || rollingWindow);
  rollingRange.addEventListener('input', (e) => setRollingWindow(e.target.value));
}
syncRollingInputs(rollingWindow);

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
  let rank = 0, prevTotal = null;
  users.forEach((u, idx) => {
    if (u.total !== prevTotal) rank = idx + 1;
    u.rank = rank;
    prevTotal = u.total;
  });

  const colorMap = buildColorMap(users.map(u => u.username));
  const topUsers = users.slice(0, MAX_USERS).map(u => ({...u, color: colorMap.get(u.username)}));
  for (const u of topUsers) hydrateUserSeries(u, dates);

  return { dates, users, topUsers };
}

function renderFromReport(report, source = 'fresh') {
  if (!report) return;
  $("meta-badge").textContent = `${report.dates.length} days`;
  if (CHART_MODE === 'scatter') renderScatterChart(report);
  else renderMetricChart(report);
  renderLegend(report.topUsers || []);
  renderTable(report.users || []);
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
    const value = String(e.target.value);
    if (value === 'mean') CHART_MODE = 'mean';
    else if (value === 'scatter') CHART_MODE = 'scatter';
    else CHART_MODE = 'total';
    setModeURL(CHART_MODE, false);
    updateRollingControlsVisibility();
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
    if (sel) sel.value = CHART_MODE;
  }
  // Ensure URL reflects current mode without growing history
  setModeURL(CHART_MODE, true);
  updateRollingControlsVisibility();
})();

// Handle browser back/forward to keep mode in sync
window.addEventListener('popstate', () => {
  const fromURL = getModeFromURL();
  const newMode = fromURL || 'total';
  if (newMode !== CHART_MODE) {
    CHART_MODE = newMode;
    const sel = document.getElementById('metric');
    if (sel) sel.value = CHART_MODE;
    updateRollingControlsVisibility();
    if (cachedReport) renderFromReport(cachedReport, 'cache');
    else loadAllTime();
  }
});

loadAllTime();

let resizeRaf = null;
window.addEventListener('resize', () => {
  if (!cachedReport) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => renderFromReport(cachedReport, 'cache'));
});
