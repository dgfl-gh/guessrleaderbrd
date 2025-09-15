V2 TODO

- Parse stored /finalscoredaily HTML into JSON
  - Extract rounds, actual vs guessed coords, distances, per‑round points, total.
  - Persist parsed JSON alongside HTML and expose as GET /api/my/detailed?date=YYYY‑MM‑DD.

- Daily page enhancements
  - Show login state in header (username, Logout).
  - Add a “Fetch my results” button that calls POST /api/finalscoredaily and then loads parsed JSON.
  - Visualize per‑round guesses (table + map markers, per‑user color).

- Backfill and scheduling
  - Endpoint/CLI to backfill a date range for the logged‑in user.
  - Optional: light scheduler or doc for cron/systemd timer to fetch daily.

- Admin/overview
  - List onboarded users and which dates are stored (HTML/JSON).

- Security & ops
  - Config: PORT, GL_SECURE_COOKIES, base URL.
  - Passphrase rotation command to rewrap stored secrets with a new passphrase.
  - Timeouts/retries and clearer upstream error handling.

