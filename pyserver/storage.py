import os
import json
import time
from base64 import b64encode, b64decode
import urllib.parse
import hashlib

from .crypto import encrypt, decrypt


ROOT = os.path.join(os.getcwd(), 'server_data')
USERS_FILE = os.path.join(ROOT, 'users.json')
SESSIONS_FILE = os.path.join(ROOT, 'sessions.json')
KEYSTORE_FILE = os.path.join(ROOT, 'keystore.json')


def _now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def _read_json(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, obj):
    _ensure_dir(os.path.dirname(path))
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def kdf_scrypt(passphrase: str, salt: bytes, n=16384, r=8, p=1, dklen=32) -> bytes:
    return hashlib.scrypt(passphrase.encode('utf-8'), salt=salt, n=n, r=r, p=p, dklen=dklen)


def load_or_create_keystore(passphrase: str):
    """Load keystore; if missing, create with provided passphrase (requires confirmation upstream).
    Returns (master_key: bytes, keystore: dict)
    """
    if not os.path.exists(KEYSTORE_FILE):
        salt = os.urandom(16)
        params = { 'kdf': 'scrypt', 'N': 16384, 'r': 8, 'p': 1 }
        mk = kdf_scrypt(passphrase, salt, n=params['N'], r=params['r'], p=params['p'])
        check = encrypt(mk, b'ok')
        ks = {
            'version': 1,
            'createdAt': _now_iso(),
            'kdf': 'scrypt',
            'salt_b64': b64encode(salt).decode('ascii'),
            'params': params,
            'check': check,
        }
        _write_json(KEYSTORE_FILE, ks)
        return mk, ks
    else:
        ks = _read_json(KEYSTORE_FILE, {})
        if not ks:
            raise RuntimeError('keystore.json unreadable')
        salt = b64decode(ks['salt_b64'])
        params = ks.get('params', { 'N': 16384, 'r': 8, 'p': 1 })
        mk = kdf_scrypt(passphrase, salt, n=params['N'], r=params['r'], p=params['p'])
        # verify
        try:
            v = decrypt(mk, ks['check'])
            if v != b'ok':
                raise ValueError('keystore check mismatch')
        except Exception as e:
            raise RuntimeError('invalid passphrase for keystore') from e
        return mk, ks


def get_users():
    return _read_json(USERS_FILE, {})


def save_users(users: dict):
    _write_json(USERS_FILE, users)


def put_user_encrypted_password(master_key: bytes, username: str, password: str):
    users = get_users()
    enc = encrypt(master_key, password.encode('utf-8'))
    rec = users.get(username) or {}
    rec.update({ 'username': username, 'enc_password': enc, 'updatedAt': _now_iso() })
    if 'createdAt' not in rec:
        rec['createdAt'] = _now_iso()
    users[username] = rec
    save_users(users)
    return rec


def get_user_password(master_key: bytes, username: str) -> str | None:
    users = get_users()
    rec = users.get(username)
    if not rec:
        return None
    try:
        pt = decrypt(master_key, rec['enc_password'])
        return pt.decode('utf-8')
    except Exception:
        return None


def get_sessions():
    return _read_json(SESSIONS_FILE, {})


def save_sessions(sessions: dict):
    _write_json(SESSIONS_FILE, sessions)


def create_session(username: str, ttl_seconds: int = 60*60*24*30) -> str:
    sessions = get_sessions()
    sid = os.urandom(16).hex()
    now = int(time.time())
    sessions[sid] = { 'username': username, 'createdAt': _now_iso(), 'expiresAt': now + ttl_seconds }
    save_sessions(sessions)
    return sid


def get_session(sid: str):
    if not sid:
        return None
    sessions = get_sessions()
    rec = sessions.get(sid)
    if not rec:
        return None
    if int(time.time()) > int(rec.get('expiresAt', 0)):
        del sessions[sid]
        save_sessions(sessions)
        return None
    return rec


def delete_session(sid: str):
    sessions = get_sessions()
    if sid in sessions:
        del sessions[sid]
        save_sessions(sessions)


def save_user_day_html(username: str, date_iso: str, html_text: str):
    safe_user = urllib.parse.quote(username, safe='')
    dirp = os.path.join(ROOT, 'users', safe_user, date_iso)
    _ensure_dir(dirp)
    with open(os.path.join(dirp, 'finalscoredaily.html'), 'w', encoding='utf-8') as f:
        f.write(html_text)


def read_user_day_html(username: str, date_iso: str) -> str | None:
    safe_user = urllib.parse.quote(username, safe='')
    filep = os.path.join(ROOT, 'users', safe_user, date_iso, 'finalscoredaily.html')
    try:
        with open(filep, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception:
        return None
