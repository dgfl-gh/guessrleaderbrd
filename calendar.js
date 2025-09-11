import { BASE_DATA, $, fetchJSON, normalizeRows, buildColorMap, fmtDateRome, todayRomeStr } from '/src/guessrleaderbrd/utils.js';

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]; // Monday-first

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

async function fetchWinner(date) {
  const url = `${BASE_DATA}/${date}/leaderboard.json`;
  try {
    const data = await fetchJSON(url);
    const rows = normalizeRows(data);
    return rows[0] || null;
  } catch (e) {
    return null;
  }
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

async function renderMonth(allDates, y, m) {
  const cal = $("calendar");
  cal.innerHTML = '';
  renderDOW(cal);

  const set = new Set(allDates);
  const dates = getMonthDates(y,m);
  const winners = new Map();
  const usersSeen = new Map();

  setStatus('Loading winners…');
  // Fetch winners only for in-month dates that exist in index
  const tasks = dates
    .filter(d => d.inMonth && set.has(d.iso))
    .map(d => fetchWinner(d.iso).then(w => ({ iso: d.iso, w })));
  const res = await Promise.all(tasks);
  for (const {iso, w} of res) if (w) winners.set(iso, w);

  const colorMap = buildColorMap(Array.from(new Set(Array.from(winners.values()).map(w=>w.username))));

  for (const d of dates) {
    const el = document.createElement('div');
    el.className = 'day' + (d.inMonth ? '' : ' inactive');
    const w = winners.get(d.iso);
    const color = w ? colorMap.get(w.username) : null;
    if (w && color) el.style.background = `linear-gradient(180deg, ${color} 0%, ${color} 60%, rgba(0,0,0,.2) 60%)`;
    el.innerHTML = `<div class=\"num\">${Number(d.iso.slice(-2))}</div>` + (w ? `<div class=\"meta\">${w.username}</div>` : '');
    if (d.inMonth && winners.has(d.iso)) {
      el.addEventListener('click', () => {
        location.href = `/src/guessrleaderbrd/leaderboard.html?date=${d.iso}`;
      });
    } else {
      el.classList.add('empty');
    }
    cal.appendChild(el);
  }

  // Legend
  const legend = $("legend"); legend.innerHTML='';
  for (const name of Array.from(colorMap.keys())) {
    const color = colorMap.get(name);
    const li = document.createElement('div');
    li.className = 'legend-item';
    li.innerHTML = `<span class=\"swatch\" style=\"background:${color}\"></span><span>${name}</span>`;
    legend.appendChild(li);
  }

  $("meta-badge").textContent = `${MONTHS[m]} ${y}`;
  setStatus(`${winners.size} winner${winners.size===1?'':'s'} this month`);
}

async function init() {
  let dates;
  try {
    dates = await loadIndex();
  } catch (e) {
    setStatus(`Error loading index.json: ${e.message}`, true); return;
  }
  if (!dates.length) { setStatus('No dates found.'); return; }
  fillMonthYearSelectors(dates);

  const last = dates[dates.length-1];
  let [y,m] = last.split('-').map(Number); m -= 1;
  $("year").value = String(y);
  $("month").value = String(m);

  $("prev").addEventListener('click', () => {
    if (--m < 0) { m = 11; y--; }
    $("year").value = String(y); $("month").value = String(m);
    renderMonth(dates, y, m);
  });
  $("next").addEventListener('click', () => {
    if (++m > 11) { m = 0; y++; }
    $("year").value = String(y); $("month").value = String(m);
    renderMonth(dates, y, m);
  });
  $("year").addEventListener('change', () => { y = Number($("year").value); renderMonth(dates, y, m); });
  $("month").addEventListener('change', () => { m = Number($("month").value); renderMonth(dates, y, m); });

  renderMonth(dates, y, m);
}

init();
