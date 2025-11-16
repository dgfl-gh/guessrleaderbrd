import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { BASE_DATA, $, fetchJSON, normalizeRows, buildColorMap, fmtDateRome, todayRomeStr, getQueryParam, colorForName } from './utils.js';

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]; // Monday-first

function setStatus(msg='', isErr=false) {
  const el = $("status");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'status';
    return;
  }
  el.hidden = false;
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

function dateFromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function hexToRgb(hex) {
  const normalized = (hex || '').replace('#', '');
  if (normalized.length !== 6) return null;
  const num = parseInt(normalized, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function colorWithIntensity(hex, ratio) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#1b1f2a';
  const base = { r: 15, g: 16, b: 21 };
  const grid = [
    { threshold: 0, value: 0.00 },
    { threshold: 0.1, value: 0.1 },
    { threshold: 0.25, value: 0.4 },
    { threshold: 0.5, value: 0.7 },
    { threshold: 1, value: 1 }
  ];
  const clamped = clamp01(ratio);
  let t = grid[0].value;
  for (let i = 1; i < grid.length; i++) {
    if (clamped <= grid[i].threshold) {
      const prev = grid[i - 1];
      const span = grid[i].threshold - prev.threshold || 1;
      const local = (clamped - prev.threshold) / span;
      t = prev.value + (grid[i].value - prev.value) * local;
      break;
    }
    t = grid[i].value;
  }
  const r = Math.round(base.r + (rgb.r - base.r) * t);
  const g = Math.round(base.g + (rgb.g - base.g) * t);
  const b = Math.round(base.b + (rgb.b - base.b) * t);
  return rgbToHex(r, g, b);
}

async function loadDailyStats(dates) {
  const stats = new Map();
  await Promise.all(dates.map(async (iso) => {
    try {
      const data = await fetchJSON(`${BASE_DATA}/${iso}/leaderboard.json`);
      const rows = normalizeRows(data);
      const winner = rows[0]?.username ?? null;
      stats.set(iso, {
        winner,
        count: rows.length,
        color: winner ? colorForName(winner) : null
      });
    } catch (e) {
      stats.set(iso, { winner: null, count: 0, color: null });
    }
  }));
  let maxCount = 0;
  stats.forEach((value) => { if ((value.count || 0) > maxCount) maxCount = value.count || 0; });
  return { stats, maxCount: Math.max(1, maxCount) };
}

function fillMonthYearSelectors(allDates) {
  const first = allDates[0] || todayRomeStr();
  const last = allDates[allDates.length-1] || todayRomeStr();
  const [fy,fm] = first.split('-').map(Number);
  const [ly,lm] = last.split('-').map(Number);
  const years = [];
  for (let y=fy; y<=ly; y++) years.push(y);
  const selY = $("year"), selM = $("month");
  selY.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  selM.innerHTML = MONTHS.map((m,i) => `<option value="${i}">${m}</option>`).join('');
}

function monthKey(y,m) { return `${y}-${String(m+1).padStart(2,'0')}`; }

function getMonthDates(y, m /* 0-based */) {
  const first = new Date(Date.UTC(y, m, 1));
  let day = first.getUTCDay(); // 0=Sun..6=Sat
  day = day === 0 ? 7 : day;   // 1..7
  const start = new Date(Date.UTC(y, m, 1 - (day - 1))); // Monday-first grid start
  const dates = [];
  for (let i=0; i<42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dates.push({ iso: fmtDateRome(d), inMonth: d.getUTCMonth() === m });
  }
  return dates;
}

function renderDOW(container) {
  container.innerHTML = '';
  for (const label of DOW) {
    const el = document.createElement('div');
    el.className = 'dow'; el.textContent = label;
    container.appendChild(el);
  }
}

function renderMonth(allDates, stats, y, m) {
  const cal = $("calendar");
  cal.innerHTML = '';
  renderDOW(cal);

  const set = new Set(allDates);
  const dates = getMonthDates(y,m);
  const winners = new Map();
  const uniqueNames = new Set();
  for (const d of dates) {
    if (!d.inMonth) continue;
    const stat = stats.get(d.iso);
    if (stat?.winner) {
      winners.set(d.iso, stat);
      uniqueNames.add(stat.winner);
    }
  }

  const colorMap = buildColorMap(Array.from(uniqueNames));

  for (const d of dates) {
    const el = document.createElement('div');
    el.className = 'day' + (d.inMonth ? '' : ' inactive');
    const stat = stats.get(d.iso);
    const winnerName = stat?.winner ?? null;
    const color = winnerName ? (colorMap.get(winnerName) || stat?.color || colorForName(winnerName)) : null;
    if (winnerName && color) {
      el.style.background = `linear-gradient(180deg, ${color} 0%, ${color} 60%, rgba(0,0,0,.2) 60%)`;
    }
    el.innerHTML = `<div class="num">${Number(d.iso.slice(-2))}</div>` + (winnerName ? `<div class="meta">${winnerName}</div>` : '');
    if (d.inMonth && set.has(d.iso)) {
      el.addEventListener('click', () => {
        location.href = `/daily?date=${d.iso}`;
      });
    } else {
      el.classList.add('blank');
    }
    cal.appendChild(el);
  }

  // Legend
  const legend = $("legend"); legend.innerHTML='';
  for (const name of colorMap.keys()) {
    const color = colorMap.get(name);
    const li = document.createElement('div');
    li.className = 'legend-item';
    li.innerHTML = `<span class=\"swatch\" style=\"background:${color}\"></span><span>${name}</span>`;
    legend.appendChild(li);
  }

  $("meta-badge").textContent = `${MONTHS[m]} ${y}`;
}

function setCalendarURL(y, m /* 0-based */, replace=false) {
  const url = `/calendar?y=${y}&m=${m+1}`; // 1-based in URL
  try {
    if (replace) history.replaceState({ y, m }, '', url);
    else history.pushState({ y, m }, '', url);
  } catch {}
}

function renderHeatmap(stats, dates, maxCount, year) {
  const section = $("heatmap-section");
  const caption = $("heatmap-caption");
  const chartEl = document.getElementById('heatmap-chart');
  if (!section || !chartEl) return;

  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  const days = d3.utcDays(start, d3.utcDay.offset(end, 1));
  if (!days.length) { section.hidden = true; return; }

  const startWeek = d3.utcMonday.floor(start);
  const weeks = d3.utcWeek.count(startWeek, d3.utcDay.offset(end, 1));

  const CELL = 14;
  const GAP = 3;
  const LEFT = 40;
  const TOP = 24;
  const RIGHT = 8;
  const BOTTOM = 10;
  const WIDTH = LEFT + weeks * (CELL + GAP) + RIGHT;
  const HEIGHT = TOP + 7 * (CELL + GAP) + BOTTOM;

  section.hidden = false;
  if (caption) caption.textContent = `${year}`;

  const available = new Set(dates);
  chartEl.innerHTML = '';
  const svg = d3.select(chartEl)
    .append('svg')
    .attr('class', 'heatmap-svg')
    .attr('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)
    .attr('preserveAspectRatio', 'xMinYMin meet');

  const weekdayLabels = ['Mon', 'Wed', 'Fri'];
  const weekdayIndices = [0, 2, 4];
  weekdayLabels.forEach((label, idx) => {
    svg.append('text')
      .attr('x', LEFT - 8)
      .attr('y', TOP + (weekdayIndices[idx] + 0.7) * (CELL + GAP))
      .attr('fill', 'var(--muted)')
      .attr('font-size', 9)
      .attr('text-anchor', 'end')
      .text(label);
  });

  const months = d3.utcMonths(start, d3.utcMonth.offset(end, 0));
  months.forEach((monthDate) => {
    const weekIndex = d3.utcWeek.count(startWeek, monthDate);
    svg.append('text')
      .attr('x', LEFT + weekIndex * (CELL + GAP))
      .attr('y', TOP - 10)
      .attr('fill', 'var(--muted)')
      .attr('font-size', 9)
      .attr('text-anchor', 'start')
      .text(MONTHS[monthDate.getUTCMonth()].slice(0, 3).toUpperCase());
  });

  const cells = svg.append('g');
  days.forEach((date) => {
    const iso = fmtDateRome(date);
    const stat = stats.get(iso);
    const weekIndex = d3.utcWeek.count(startWeek, date);
    const dow = (date.getUTCDay() + 6) % 7;
    const hasPlayers = !!(stat && stat.count > 0 && stat.color);
    const color = hasPlayers ? colorWithIntensity(stat.color, stat.count / maxCount) : '#151821';
    const titleParts = [iso];
    if (stat) {
      titleParts.push(`${stat.count} player${stat.count === 1 ? '' : 's'}`);
      if (stat.winner) titleParts.push(`winner: ${stat.winner}`);
    } else {
      titleParts.push('no data');
    }

    const cellGroup = cells.append('g')
      .attr('transform', `translate(${LEFT + weekIndex * (CELL + GAP)}, ${TOP + dow * (CELL + GAP)})`);

    const rect = cellGroup.append('rect')
      .attr('width', CELL)
      .attr('height', CELL)
      .attr('rx', 3)
      .attr('ry', 3)
      .attr('fill', color)
      .attr('stroke', hasPlayers ? 'rgba(0,0,0,.25)' : 'rgba(255,255,255,.08)')
      .attr('stroke-width', 0.5)
      .attr('opacity', hasPlayers ? 1 : 0.35);

    const clickable = available.has(iso);
    if (clickable) {
      rect.style('cursor', 'pointer')
        .on('click', () => { location.href = `/daily?date=${iso}`; });
    }

    cellGroup.append('title').text(titleParts.join(' · '));
  });
}

async function init() {
  let dates;
  try {
    dates = await loadIndex();
  } catch (e) {
    setStatus(`Error loading index.json: ${e.message}`, true); return;
  }
  if (!dates.length) { setStatus('No dates found.'); return; }
  const { stats } = await loadDailyStats(dates);
  const heatmapYear = Number(todayRomeStr().slice(0, 4));
  const yearDates = dates.filter((iso) => iso.startsWith(`${heatmapYear}-`));
  const yearMaxCount = Math.max(1, yearDates.reduce((max, iso) => {
    const stat = stats.get(iso);
    return Math.max(max, stat?.count || 0);
  }, 0));
  renderHeatmap(stats, yearDates, yearMaxCount, heatmapYear);
  fillMonthYearSelectors(dates);

  const last = dates[dates.length-1];
  let [y,m] = last.split('-').map(Number); m -= 1;
  const qy = Number(getQueryParam('y'));
  const qm1 = Number(getQueryParam('m'));
  if (!Number.isNaN(qy) && qy >= 1970 && qy <= 3000) y = qy;
  if (!Number.isNaN(qm1) && qm1 >= 1 && qm1 <= 12) m = qm1 - 1;
  $("year").value = String(y);
  $("month").value = String(m);
  setCalendarURL(y, m, true);

  $("prev").addEventListener('click', () => {
    if (--m < 0) { m = 11; y--; }
    $("year").value = String(y); $("month").value = String(m);
    setCalendarURL(y, m, false);
    renderMonth(dates, stats, y, m);
  });
  $("next").addEventListener('click', () => {
    if (++m > 11) { m = 0; y++; }
    $("year").value = String(y); $("month").value = String(m);
    setCalendarURL(y, m, false);
    renderMonth(dates, stats, y, m);
  });
  $("year").addEventListener('change', () => { y = Number($("year").value); setCalendarURL(y, m, false); renderMonth(dates, stats, y, m); });
  $("month").addEventListener('change', () => { m = Number($("month").value); setCalendarURL(y, m, false); renderMonth(dates, stats, y, m); });

  // Back/forward support
  window.addEventListener('popstate', () => {
    const qy2 = Number(getQueryParam('y'));
    const qm12 = Number(getQueryParam('m'));
    let ny = y, nm = m;
    if (!Number.isNaN(qy2) && qy2 >= 1970 && qy2 <= 3000) ny = qy2;
    if (!Number.isNaN(qm12) && qm12 >= 1 && qm12 <= 12) nm = qm12 - 1;
    if (ny !== y || nm !== m) {
      y = ny; m = nm;
      $("year").value = String(y);
      $("month").value = String(m);
      renderMonth(dates, stats, y, m);
    }
  });

  renderMonth(dates, stats, y, m);
}

init();
