// Shared header + nav for EMN TimeGuessr Leaderboard
export function mountHeader(active) {
  document.title = 'EMN TimeGuessr Leaderboard';

  const container = document.querySelector('.container');
  if (!container) return;

  const host = document.getElementById('site-header') || document.createElement('div');
  host.id = 'site-header';
  const isAttached = !!host.parentNode;

  host.innerHTML = `
    <header>
      <h1>EMN TimeGuessr Leaderboard</h1>
      <span id="meta-badge" class="badge">—</span>
    </header>
    <nav>
      <a class="tab" ${active==='daily' ? 'aria-current="page"' : ''} href="/daily">Daily</a>
      <a class="tab" ${active==='alltime' ? 'aria-current="page"' : ''} href="/alltime">All‑Time</a>
      <a class="tab" ${active==='calendar' ? 'aria-current="page"' : ''} href="/calendar">Calendar</a>
    </nav>
  `;

  if (!isAttached) container.prepend(host);
}
