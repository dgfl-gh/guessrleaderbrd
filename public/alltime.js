import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { BASE_DATA, $, fetchJSON, buildColorMap } from './utils.js';

const MAX_USERS = 10; // Show top N lines
let CHART_MODE = 'total'; // 'total' | 'mean'
const ROLLING_MIN = 1;
const ROLLING_MAX = 31;
let rollingWindow = 7;
let cachedReport = null;
let reportPromise = null;
let tableSort = { key: 'total', direction: 'desc' };
const disabledUsers = new Set();
let highlightedUser = null;
let chartInspector = null;
const bisectDate = d3.bisector((d) => d).center;
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

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

function lightenColor(colorStr) {
  const c = d3.color(colorStr);
  if (!c) return colorStr;
  return c.brighter(0.6).formatRgb();
}

async function fetchAggregatedReport() {
  const url = `${BASE_DATA}/alltime.json`;
  const data = await fetchJSON(url);
  if (!data || !Array.isArray(data.dates)) {
    throw new Error('Invalid alltime.json payload');
  }
  return normalizeAggregatedReport(data);
}

function normalizeAggregatedReport(raw = {}) {
  const dates = Array.isArray(raw.dates) ? raw.dates.slice() : [];
  dates.sort();
  const users = Array.isArray(raw.users) ? raw.users.slice() : [];
  const topUsersRaw = Array.isArray(raw.topUsers) ? raw.topUsers.slice() : [];
  const colorMap = buildColorMap(users.map((u) => u.username));

  users.forEach((user, idx) => {
    if (!user.rank) user.rank = idx + 1;
    user.color = colorMap.get(user.username);
    if (typeof user.days !== 'number' && user.total && dates.length) {
      user.days = Math.max(0, Math.min(dates.length, user.rank));
    }
  });

  const hydratedTop = [];
  const maxSeriesUsers = Math.min(MAX_USERS, Math.max(topUsersRaw.length, users.length));
  const preferred = topUsersRaw.length ? topUsersRaw : users.slice(0, maxSeriesUsers);

  preferred.slice(0, maxSeriesUsers).forEach((entry) => {
    const clone = { ...entry };
    clone.color = colorMap.get(clone.username);
    ensureUserSeries(clone, dates);
    hydratedTop.push(clone);
  });

  return {
    dates,
    users,
    topUsers: hydratedTop,
    generatedAt: raw.generatedAt,
  };
}

function formatScore(value, mode = 'total') {
  if (value == null || Number.isNaN(value)) return null;
  if (mode === 'mean') return value.toFixed(1);
  if (mode === 'scatter') return value.toLocaleString('en-US');
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function formatDateLabel(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) return '';
  return dateFormatter.format(dateObj);
}

function ensureTooltip(container) {
  if (!container) return null;
  let el = container.querySelector('.chart-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chart-tooltip';
    container.appendChild(el);
  }
  return el;
}

function positionTooltip(tooltip, container, event) {
  if (!tooltip || !container || !event) return;
  const rect = container.getBoundingClientRect();
  const { clientX, clientY } = event;
  let left = clientX - rect.left + 12;
  let top = clientY - rect.top - 12;
  requestAnimationFrame(() => {
    const w = tooltip.offsetWidth || 0;
    const h = tooltip.offsetHeight || 0;
    left = Math.min(Math.max(8, left), Math.max(8, rect.width - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, rect.height - h - 8));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  });
}

function hideTooltipElement(tooltip) {
  if (tooltip) tooltip.classList.remove('visible');
}

function detachInspector() {
  if (chartInspector?.svg) {
    d3.select(chartInspector.svg).on('.inspector', null);
  }
  if (chartInspector?.tooltip) hideTooltipElement(chartInspector.tooltip);
  chartInspector = null;
}

function renderMetricChart(report) {
  if (CHART_MODE === 'scatter') return;
  const svgElement = $("chart");
  if (!svgElement) {
    detachInspector();
    return;
  }

  const dates = report.dates;
  const svg = d3.select(svgElement);
  if (!dates.length) {
    svg.selectAll('*').remove();
    detachInspector();
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

  const topUsers = getVisibleTopUsers(report.topUsers || []);
  const baseSeries = topUsers.map((user) => ({
    user,
    values: getSeriesForMode(user)
  }));
  const showRolling = shouldShowRollingOverlay();
  const rollingSeries = showRolling ? topUsers.map((user) => ({
    user,
    points: getRollingSeries(user, rollingWindow)
  })) : [];
  const rollingMap = new Map(rollingSeries.map((entry) => [entry.user.username, entry.points]));

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

  const seriesLayer = root.append('g').attr('class', 'series-layer metric-series');
  topUsers.forEach((user, idx) => {
    const group = seriesLayer.append('g')
      .attr('class', 'chart-series')
      .attr('data-username', user.username);

    group.append('path')
      .datum(baseSeries[idx].values)
      .attr('class', 'series-line base-line')
      .attr('fill', 'none')
      .attr('stroke', user.color)
      .attr('stroke-width', 2)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .attr('d', lineGenerator);

    if (showRolling) {
      const rollPoints = rollingMap.get(user.username) || [];
      if (rollPoints.length) {
        group.append('path')
          .datum(rollPoints)
          .attr('class', 'series-line rolling-line')
          .attr('fill', 'none')
          .attr('stroke', lightenColor(user.color))
          .attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '5 4')
          .attr('opacity', 0.95)
          .attr('stroke-linejoin', 'round')
          .attr('stroke-linecap', 'round')
          .attr('d', rollingLine);
      }
    }
  });

  setupInspector({
    mode: CHART_MODE,
    svg: svgElement,
    root,
    margin,
    innerWidth,
    innerHeight,
    dateObjs,
    dates,
    xScale: x,
    yScale: y,
    users: topUsers
  });
}

function renderScatterChart(report) {
  const svgElement = $("chart");
  if (!svgElement) {
    detachInspector();
    return;
  }
  const svg = d3.select(svgElement);
  if (CHART_MODE !== 'scatter') {
    svg.selectAll('*').remove();
    detachInspector();
    return;
  }
  const dates = report.dates;
  if (!dates.length) {
    svg.selectAll('*').remove();
    detachInspector();
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

  const topUsers = getVisibleTopUsers(report.topUsers || []);
  const rollingSeries = topUsers.map((user) => ({
    user,
    points: getRollingSeries(user, rollingWindow)
  }));
  const pointsByUser = topUsers.map((user) => ({
    user,
    points: (user.dailyScores || []).map((value, idx) => {
      if (value == null) return null;
      return { user, value, index: idx, date: dateObjs[idx], dateStr: dates[idx] };
    }).filter(Boolean)
  }));

  const allPoints = pointsByUser.flatMap((entry) => entry.points);
  const rollingValues = rollingSeries.flatMap((s) => s.points.map((p) => p.value));
  const yCandidates = [];
  if (allPoints.length) yCandidates.push(d3.max(allPoints, (p) => p.value));
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

  const seriesLayer = new Map();
  const scatterRoot = root.append('g').attr('class', 'series-layer scatter-series');
  pointsByUser.forEach((entry) => {
    const group = scatterRoot.append('g')
      .attr('class', 'chart-series')
      .attr('data-username', entry.user.username);
    seriesLayer.set(entry.user.username, group);

    group.append('g')
      .attr('class', 'points')
      .selectAll('circle')
      .data(entry.points)
      .join('circle')
      .attr('cx', (d) => x(d.date))
      .attr('cy', (d) => y(d.value))
      .attr('r', 3)
      .attr('fill', entry.user.color)
      .attr('fill-opacity', 0.85)
      .attr('stroke', 'rgba(0,0,0,0.45)')
      .attr('stroke-width', 0.5)
      .style('cursor', 'pointer');
  });

  for (const series of rollingSeries) {
    if (!series.points.length) continue;
    const group = seriesLayer.get(series.user.username) || scatterRoot.append('g')
      .attr('class', 'chart-series')
      .attr('data-username', series.user.username);
    group.append('path')
      .datum(series.points)
      .attr('class', 'series-line rolling-line')
      .attr('fill', 'none')
      .attr('stroke', lightenColor(series.user.color))
      .attr('stroke-width', 1.8)
      .attr('stroke-dasharray', '4 3')
      .attr('opacity', 0.95)
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .attr('d', rollingLine);
  }

  setupInspector({
    mode: 'scatter',
    svg: svgElement,
    root,
    margin,
    innerWidth,
    innerHeight,
    dateObjs,
    dates,
    xScale: x,
    yScale: y,
    users: topUsers
  });
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

function ensureUserSeries(user, dates) {
  if (!user) return;
  const hasSeries = Array.isArray(user.dailyScores) && user.dailyScores.length === dates.length;
  if (hasSeries && Array.isArray(user.cumulative) && Array.isArray(user.meanSeries)) {
    user.rollingCache = new Map();
    return;
  }
  if (user.perDay instanceof Map || (user.perDay && typeof user.perDay === 'object')) {
    if (!(user.perDay instanceof Map)) {
      user.perDay = new Map(Object.entries(user.perDay));
    }
    hydrateUserSeries(user, dates);
    return;
  }
  // Fallback to zero-filled arrays to avoid rendering errors.
  user.dailyScores = new Array(dates.length).fill(null);
  user.cumulative = new Array(dates.length).fill(0);
  user.meanSeries = new Array(dates.length).fill(null);
  user.firstPlayIndex = -1;
  user.rollingCache = new Map();
}

function setupInspector(config) {
  if (!config || !config.users || !config.users.length) {
    detachInspector();
    return;
  }
  if (chartInspector?.svg) {
    d3.select(chartInspector.svg).on('.inspector', null);
  }
  const svgSelection = d3.select(config.svg);
  svgSelection.on('.inspector', null);
  const wrap = config.svg.closest('.chart-wrap');
  chartInspector = {
    ...config,
    wrap,
    tooltip: ensureTooltip(wrap)
  };
  const layer = config.root.append('g')
    .attr('class', 'inspector-layer')
    .attr('pointer-events', 'none');
  chartInspector.layer = layer;
  chartInspector.line = layer.append('line')
    .attr('class', 'inspector-line')
    .attr('y1', 0)
    .attr('y2', config.innerHeight)
    .attr('opacity', 0);
  chartInspector.dots = layer.append('g')
    .attr('class', 'inspector-dots')
    .selectAll('circle')
    .data(config.users, (d) => d.username)
    .join('circle')
    .attr('class', 'inspector-dot')
    .attr('r', 4)
    .attr('fill', (d) => d.color)
    .attr('opacity', 0);

  svgSelection.on('pointermove.inspector', (event) => handleInspectorMove(event));
  svgSelection.on('pointerleave.inspector', () => hideInspector());
  svgSelection.on('click.inspector', (event) => handleInspectorClick(event));
  hideInspector();
  raiseInspectorLayer();
}

function raiseInspectorLayer() {
  if (chartInspector?.layer && typeof chartInspector.layer.raise === 'function') {
    chartInspector.layer.raise();
  }
}

function handleInspectorMove(event) {
  if (!chartInspector || !chartInspector.users.length) return;
  const { svg, margin, innerWidth, innerHeight, dateObjs, xScale, yScale, users, mode } = chartInspector;
  const [px, py] = d3.pointer(event, svg);
  const mx = px - margin.left;
  const my = py - margin.top;
  if (mx < 0 || mx > innerWidth || my < 0 || my > innerHeight) {
    hideInspector();
    return;
  }
  const date = xScale.invert(mx);
  const idx = Math.min(Math.max(0, bisectDate(dateObjs, date)), dateObjs.length - 1);
  const xPos = xScale(dateObjs[idx]);
  chartInspector.currentIndex = idx;
  chartInspector.currentDate = dateObjs[idx];
  chartInspector.currentDateStr = chartInspector.dates?.[idx] || null;
  chartInspector.line
    .attr('x1', xPos)
    .attr('x2', xPos)
    .attr('opacity', 1);

  chartInspector.dots.each(function(user) {
    const value = getInspectorValue(user, idx, mode);
    const circle = d3.select(this);
    if (value == null) {
      circle.attr('opacity', 0);
      return;
    }
    circle
      .attr('cx', xPos)
      .attr('cy', yScale(value))
      .attr('opacity', 1);
  });

  const tooltip = chartInspector.tooltip;
  if (tooltip) {
    const dateLabel = formatDateLabel(dateObjs[idx]);
    const rows = users.map((user) => {
      const value = getInspectorValue(user, idx, mode);
      if (value == null) return null;
      return {
        username: user.username,
        color: user.color,
        value: formatScore(value, mode)
      };
    }).filter(Boolean);
    let html = `<div class="tooltip-date">${dateLabel}</div>`;
    if (rows.length) {
      html += rows.map((row) => `
        <div class="tooltip-row">
          <span class="tooltip-name">
            <span class="tooltip-swatch" style="background:${row.color}"></span>${row.username}
          </span>
          <span class="tooltip-value">${row.value}</span>
        </div>
      `).join('');
    } else {
      html += '<div class="tooltip-empty">No scores</div>';
    }
    tooltip.innerHTML = html;
    tooltip.classList.add('visible');
    positionTooltip(tooltip, chartInspector.wrap, event);
  }
  chartInspector.tooltipVisible = true;
}

function hideInspector() {
  if (!chartInspector) return;
  if (chartInspector.line) chartInspector.line.attr('opacity', 0);
  if (chartInspector.dots) chartInspector.dots.attr('opacity', 0);
  hideTooltipElement(chartInspector.tooltip);
  chartInspector.currentIndex = null;
  chartInspector.currentDate = null;
  chartInspector.currentDateStr = null;
  chartInspector.tooltipVisible = false;
}

function getInspectorValue(user, idx, mode) {
  if (!user) return null;
  if (mode === 'mean') return user.meanSeries?.[idx] ?? null;
  if (mode === 'scatter') return user.dailyScores?.[idx] ?? null;
  return user.cumulative?.[idx] ?? null;
}

function handleInspectorClick(event) {
  if (!chartInspector || !chartInspector.tooltipVisible || !chartInspector.currentDateStr) return;
  if (event && event.button !== undefined && event.button !== 0) return;
  const url = `/daily?date=${encodeURIComponent(chartInspector.currentDateStr)}`;
  if (event && (event.metaKey || event.ctrlKey)) {
    window.open(url, '_blank');
  } else {
    location.href = url;
  }
}

function getVisibleTopUsers(users = []) {
  return users.filter((user) => !disabledUsers.has(user.username));
}

function pruneLegendState(users = []) {
  const available = new Set(users.map((u) => u.username));
  Array.from(disabledUsers).forEach((username) => {
    if (!available.has(username)) disabledUsers.delete(username);
  });
  if (highlightedUser && !available.has(highlightedUser)) {
    highlightedUser = null;
  }
}

function setHighlightedUser(username) {
  const next = username && disabledUsers.has(username) ? null : (username || null);
  if (highlightedUser === next) return;
  highlightedUser = next;
  syncLegendState();
  syncSeriesHighlight();
}

function syncLegendState() {
  const items = document.querySelectorAll('.legend-item[data-username]');
  const hasHighlight = Boolean(highlightedUser);
  items.forEach((item) => {
    const username = item.dataset.username;
    const disabled = disabledUsers.has(username);
    const highlighted = hasHighlight && highlightedUser === username;
    item.classList.toggle('is-disabled', disabled);
    item.classList.toggle('is-highlighted', highlighted);
    item.setAttribute('aria-pressed', disabled ? 'false' : 'true');
    item.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  });
}

function syncSeriesHighlight() {
  const svgElement = $("chart");
  if (!svgElement) return;
  const series = svgElement.querySelectorAll('.chart-series');
  const hasHighlight = Boolean(highlightedUser);
  series.forEach((node) => {
    const isMatch = hasHighlight && node.dataset.username === highlightedUser;
    node.classList.toggle('is-highlighted', isMatch);
    if (isMatch && node.parentNode) {
      node.parentNode.appendChild(node);
    }
  });
  raiseInspectorLayer();
}

function handleLegendHover(username) {
  if (!username || disabledUsers.has(username)) return;
  setHighlightedUser(username);
}

function handleLegendLeave(username) {
  if (highlightedUser !== username) return;
  setHighlightedUser(null);
}

function handleLegendToggle(username) {
  if (!username) return;
  if (disabledUsers.has(username)) {
    disabledUsers.delete(username);
  } else {
    disabledUsers.add(username);
    if (highlightedUser === username) highlightedUser = null;
  }
  if (cachedReport) renderFromReport(cachedReport, 'cache');
  else {
    syncLegendState();
    syncSeriesHighlight();
  }
}

function bindLegendInteractions(el, username) {
  el.addEventListener('mouseenter', () => handleLegendHover(username));
  el.addEventListener('mouseleave', () => handleLegendLeave(username));
  el.addEventListener('focus', () => handleLegendHover(username));
  el.addEventListener('blur', () => handleLegendLeave(username));
  el.addEventListener('click', () => handleLegendToggle(username));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleLegendToggle(username);
    }
  });
}

function renderLegend(users) {
  const legend = $("legend");
  if (!legend) return;
  legend.innerHTML = '';
  pruneLegendState(users);
  legend.setAttribute('role', 'group');
  const frag = document.createDocumentFragment();
  for (const u of users) {
    const el = document.createElement('div');
    el.className = 'legend-item';
    el.dataset.username = u.username;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.innerHTML = `<span class="swatch" style="background:${u.color}"></span><span>${u.username}</span>`;
    bindLegendInteractions(el, u.username);
    frag.appendChild(el);
  }
  legend.appendChild(frag);
  syncLegendState();
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
  onProgress('Loading aggregated data…');
  const report = await fetchAggregatedReport();
  const userCount = report.users?.length || 0;
  onProgress(`Loaded aggregated data for ${userCount} users`);
  return report;
}

function renderFromReport(report, source = 'fresh') {
  if (!report) return;
  $("meta-badge").textContent = `${report.dates.length} days`;
  if (CHART_MODE === 'scatter') renderScatterChart(report);
  else renderMetricChart(report);
  renderLegend(report.topUsers || []);
  renderTable(report.users || []);
  syncSeriesHighlight();
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
