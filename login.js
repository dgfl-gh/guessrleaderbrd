const $ = (id) => document.getElementById(id);

async function onSubmit(e) {
  e.preventDefault();
  const btn = $('b'); const err = $('e'); err.textContent=''; btn.disabled = true;
  const username = $('u').value.trim();
  const password = $('p').value;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await r.json().catch(()=>({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    // success: go to daily
    location.href = '/daily';
  } catch (e) {
    err.textContent = `Login failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('f').addEventListener('submit', onSubmit);

