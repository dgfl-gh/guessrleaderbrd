Guessr Leaderboard v2 — Python Server

Overview

- Pure-stdlib Python server that:
  - Serves the existing frontend (daily, alltime, calendar, assets under /src/guessrleaderbrd/*).
  - Requires a passphrase at startup, derives a master key with scrypt, and verifies it via a stored keystore check.
  - Stores TimeGuessr credentials encrypted at rest using a keyed HMAC-based stream cipher + MAC (HKDF + HMAC-SHA256).
  - Re-logs into timeguessr.com on demand to fetch and store /finalscoredaily HTML per user/day.
  - Manages site sessions via an HttpOnly cookie `gl_sid`.

Requirements

- Python 3.9+ (uses hashlib.scrypt and http.server).
- cryptography library for AEAD encryption:
  - pip install cryptography

Run

- From repo root:
  - First time (creates keystore):
    python -m pyserver.server
  - Subsequent runs (prompts for passphrase):
    python -m pyserver.server

Endpoints

- POST /api/login { username, password } -> { ok, username }
- POST /api/logout -> { ok }
- GET  /api/me -> { user: { username } | null }
- POST /api/finalscoredaily?date=YYYY-MM-DD -> { ok, stored:true } (auth required)
- GET  /api/finalscoredaily?date=YYYY-MM-DD -> HTML snapshot (auth required)

Storage

- server_data/keystore.json — KDF params, salt, and an encryption check record.
- server_data/users.json — { username: { enc_password: {nonce, ct, tag}, createdAt, updatedAt } }
- server_data/sessions.json — { sid: { username, expiresAt } }
- server_data/users/<username>/<date>/finalscoredaily.html — raw HTML snapshot per user/day.

Notes

- Encryption now uses ChaCha20-Poly1305 AEAD from cryptography. Master key is derived with scrypt (salted) from the startup passphrase; per-record encryption uses a random 12-byte nonce. The ciphertext includes the authentication tag.
- Existing legacy records (if any) from a previous run are still readable by the server thanks to a compatibility decrypt path, but all new writes use AEAD.
