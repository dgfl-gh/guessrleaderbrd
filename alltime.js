import { BASE_DATA, $, fetchJSON, normalizeRows, colorForName } from '/src/guessrleaderbrd/utils.js';

const MAX_USERS = 8; // Show top N lines

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
  const maxY = Math.max(1, ...users.map(u => u.cumulative[u.cumulative.length - 1] || 0));

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
    path.setAttribute('d', linePath(u.cumulative, innerW, innerH, maxY));
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
    tr.innerHTML = `
      <td class=\"rank\">${r.rank}</td>
      <td class=\"username\">${r.username}</td>
      <td class=\"score\">${r.total.toLocaleString('en-US')}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

async function loadAllTime() {
  setStatus('Loading index…');
  let dates;
  try {
    dates = await loadIndex();
  } catch (e) {
    setStatus(`Error loading index.json: ${e.message}`, true); return;
  }
  $("meta-badge").textContent = `${dates.length} days`;
  if (!dates.length) { setStatus('No dates found.'); return; }

  const byUser = new Map();

  // Fetch in small batches to avoid overwhelming server
  const batch = 6;
  const allRowsByDate = [];
  for (let i=0; i<dates.length; i+=batch) {
    setStatus(`Loading days ${Math.min(i+1,dates.length)}-${Math.min(i+batch,dates.length)} of ${dates.length}…`);
    const part = dates.slice(i, i+batch).map(d => fetchDay(d).then(rows => ({date:d, rows})));
    const res = await Promise.all(part);
    allRowsByDate.push(...res);
  }
  allRowsByDate.sort((a,b)=> a.date.localeCompare(b.date));

  // Aggregate totals and cumulative
  for (const {date, rows} of allRowsByDate) {
    for (const r of rows) {
      if (!byUser.has(r.username)) byUser.set(r.username, { username:r.username, total:0, perDay:new Map() });
      const u = byUser.get(r.username);
      u.total += r.score;
      u.perDay.set(date, (u.perDay.get(date) || 0) + r.score);
    }
  }

  const users = Array.from(byUser.values());
  users.sort((a,b)=> b.total - a.total);

  // Build cumulative series per top users
  const topUsers = users.slice(0, MAX_USERS).map(u => ({...u, color: colorForName(u.username)}));
  for (const u of topUsers) {
    const cum = [];
    let acc = 0;
    for (const d of dates) { acc += (u.perDay.get(d) || 0); cum.push(acc); }
    u.cumulative = cum;
  }

  // Render chart + legend + table
  renderChart($("chart"), dates, topUsers);
  renderLegend(topUsers);
  renderTable(users);
  setStatus(`Loaded ${dates.length} days, ${users.length} users`);
}

loadAllTime();

