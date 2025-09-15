import os
import sys
import json
import urllib.request
import urllib.parse
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime

from .storage import (
    load_or_create_keystore,
    put_user_encrypted_password,
    get_user_password,
    create_session,
    get_session,
    delete_session,
    save_user_day_html,
    read_user_day_html,
)


ROOT = os.getcwd()
PORT = int(os.environ.get('PORT', '5180'))
ORIGIN = f'http://localhost:{PORT}'
TIMEGUESSR = 'https://timeguessr.com'


def _systemd_ask_password(prompt: str, timeout_sec: int = 60) -> str | None:
    """Ask systemd for a password via systemd-ask-password, if available."""
    import shutil
    import subprocess
    exe = shutil.which('systemd-ask-password')
    if not exe:
        return None
    try:
        cp = subprocess.run([exe, f'--timeout={timeout_sec}', prompt], capture_output=True, text=True, check=True)
        pwd = (cp.stdout or '').strip('\r\n')
        return pwd or None
    except Exception:
        return None


def prompt_passphrase(new: bool):
    import getpass
    # Prefer systemd-ask-password when running under systemd or when available
    hint = ' (new; will be created)' if new else ''
    pwd = _systemd_ask_password(f'GuessrLB passphrase{hint}:')
    if pwd:
        return pwd
    if new:
        while True:
            p1 = getpass.getpass('Create server passphrase: ')
            if len(p1) < 8:
                print('Passphrase must be at least 8 characters.', file=sys.stderr)
                continue
            p2 = getpass.getpass('Repeat passphrase: ')
            if p1 != p2:
                print('Passphrases do not match. Try again.', file=sys.stderr)
                continue
            return p1
    else:
        return getpass.getpass('Enter server passphrase: ')


def parse_cookies(header: str):
    out = {}
    if not header:
        return out
    parts = header.split(';')
    for p in parts:
        if '=' in p:
            k, v = p.split('=', 1)
            out[k.strip()] = urllib.parse.unquote(v)
    return out


SECURE_COOKIES = os.environ.get('GL_SECURE_COOKIES', '').lower() in ('1','true','yes','on')


def set_cookie(handler: BaseHTTPRequestHandler, name: str, value: str, max_age: int | None = None):
    parts = [f"{name}={urllib.parse.quote(value)}", 'Path=/', 'HttpOnly', 'SameSite=Lax']
    if SECURE_COOKIES:
        parts.append('Secure')
    if max_age is not None:
        parts.append(f'Max-Age={int(max_age)}')
    handler.send_header('Set-Cookie', '; '.join(parts))


def http_post(url: str, data: dict, headers: dict):
    body = urllib.parse.urlencode(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST', headers=headers)
    return urllib.request.urlopen(req)


def http_get(url: str, headers: dict):
    req = urllib.request.Request(url, method='GET', headers=headers)
    return urllib.request.urlopen(req)


def proxy_login_cookie(username: str, password: str) -> str:
    resp = http_post(
        f'{TIMEGUESSR}/login',
        { 'username': username, 'password': password },
        {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 GuessrLB-Py/2',
        }
    )
    # Extract connect.sid from response headers
    hdrs = resp.headers
    sc = hdrs.get_all('Set-Cookie') or []
    for h in sc:
        parts = h.split(';')
        if parts and parts[0].strip().startswith('connect.sid='):
            return parts[0].strip()
    raise RuntimeError('Missing session cookie from upstream')


def upstream_finalscoredaily(cookie: str, date_iso: str) -> str:
    resp = http_get(
        f'{TIMEGUESSR}/finalscoredaily?date={urllib.parse.quote(date_iso)}',
        {
            'Accept': 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 GuessrLB-Py/2',
            'Cookie': cookie,
            'Referer': f'{TIMEGUESSR}/dailyroundresults',
        }
    )
    return resp.read().decode('utf-8', errors='replace')


def content_type(path: str) -> str:
    if path.endswith('.html'): return 'text/html; charset=utf-8'
    if path.endswith('.js'): return 'text/javascript; charset=utf-8'
    if path.endswith('.css'): return 'text/css; charset=utf-8'
    if path.endswith('.json'): return 'application/json; charset=utf-8'
    if path.endswith('.png'): return 'image/png'
    if path.endswith('.jpg') or path.endswith('.jpeg'): return 'image/jpeg'
    if path.endswith('.svg'): return 'image/svg+xml'
    return 'application/octet-stream'


class App(BaseHTTPRequestHandler):
    master_key = None

    def _send(self, code: int, obj):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode('utf-8'))

    def _send_text(self, code: int, text: str, ctype: str):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(text.encode('utf-8'))

    def _read_json(self):
        length = int(self.headers.get('Content-Length') or '0')
        data = self.rfile.read(length) if length else b''
        try:
            return json.loads(data.decode('utf-8'))
        except Exception:
            return {}

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path == '/api/login':
                body = self._read_json()
                username = str(body.get('username', '')).strip()
                password = str(body.get('password', ''))
                if not username or not password:
                    return self._send(400, { 'error': 'Missing username or password' })
                # Verify upstream credentials and also store encrypted password
                try:
                    cookie = proxy_login_cookie(username, password)
                except Exception as e:
                    return self._send(401, { 'error': 'Login failed', 'detail': str(e) })
                put_user_encrypted_password(App.master_key, username, password)
                sid = create_session(username)
                set_cookie(self, 'gl_sid', sid, 60*60*24*30)
                return self._send(200, { 'ok': True, 'username': username })

            if path == '/api/logout':
                cookies = parse_cookies(self.headers.get('Cookie'))
                sid = cookies.get('gl_sid')
                if sid:
                    delete_session(sid)
                set_cookie(self, 'gl_sid', '', 0)
                return self._send(200, { 'ok': True })

            if path == '/api/finalscoredaily':
                # Expect query param date
                q = urllib.parse.parse_qs(parsed.query)
                date = (q.get('date') or [''])[0]
                if not (date and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date)):
                    return self._send(400, { 'error': 'Invalid date' })
                cookies = parse_cookies(self.headers.get('Cookie'))
                sid = cookies.get('gl_sid')
                sess = get_session(sid)
                if not sess:
                    return self._send(401, { 'error': 'Not authenticated' })
                username = sess['username']
                # Fetch cookie by re-logging in using stored creds
                password = get_user_password(App.master_key, username)
                if not password:
                    return self._send(400, { 'error': 'Missing stored credentials, please login again.' })
                try:
                    cookie = proxy_login_cookie(username, password)
                    html = upstream_finalscoredaily(cookie, date)
                    save_user_day_html(username, date, html)
                    return self._send(200, { 'ok': True, 'stored': True })
                except Exception as e:
                    return self._send(502, { 'error': 'Upstream fetch failed', 'detail': str(e) })

            return self._send(404, { 'error': 'Not Found' })
        except Exception as e:
            return self._send(500, { 'error': 'Server error', 'detail': str(e) })

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            if path == '/api/me':
                cookies = parse_cookies(self.headers.get('Cookie'))
                sid = cookies.get('gl_sid')
                sess = get_session(sid)
                if not sess:
                    return self._send(200, { 'user': None })
                return self._send(200, { 'user': { 'username': sess['username'] } })

            if path == '/api/finalscoredaily':
                q = urllib.parse.parse_qs(parsed.query)
                date = (q.get('date') or [''])[0]
                if not (date and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date)):
                    return self._send(400, { 'error': 'Invalid date' })
                cookies = parse_cookies(self.headers.get('Cookie'))
                sid = cookies.get('gl_sid')
                sess = get_session(sid)
                if not sess:
                    return self._send(401, { 'error': 'Not authenticated' })
                username = sess['username']
                html = read_user_day_html(username, date)
                if not html:
                    return self._send(404, { 'error': 'Not found' })
                return self._send_text(200, html, 'text/html; charset=utf-8')

            # Static files and routes
            if path.startswith('/src/guessrleaderbrd/'):
                rel = path.replace('/src/guessrleaderbrd/', '')
                filep = self._safe_path(rel)
                return self._serve_file(filep)
            if path.startswith('/src/guessrleaderbrd/data/'):
                rel = path.replace('/src/guessrleaderbrd/', '')
                filep = self._safe_path(rel)
                return self._serve_file(filep)
            if path in ('/', '/daily'):
                return self._serve_file(self._safe_path('daily.html'))
            if path == '/alltime':
                return self._serve_file(self._safe_path('alltime.html'))
            if path == '/calendar':
                return self._serve_file(self._safe_path('calendar.html'))
            if path == '/login':
                return self._serve_file(self._safe_path('login.html'))
            # Fall back to path on disk
            filep = self._safe_path(path.lstrip('/'))
            return self._serve_file(filep)
        except Exception as e:
            return self._send(500, { 'error': 'Server error', 'detail': str(e) })

    def _serve_file(self, filep: str):
        try:
            with open(filep, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type(filep))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self._send(404, { 'error': 'Not Found' })

    def _safe_path(self, rel: str) -> str:
        # Prevent path traversal and strip any query fragment remnants
        rel = rel.split('?', 1)[0].split('#', 1)[0]
        joined = os.path.normpath(os.path.join(ROOT, rel))
        root_abs = os.path.abspath(ROOT)
        if not os.path.abspath(joined).startswith(root_abs):
            # fall back to root to avoid leaking files
            return os.path.join(ROOT, '404')
        return joined


def main():
    # Ensure passphrase and keystore
    new_keystore = not os.path.exists(os.path.join(os.getcwd(), 'server_data', 'keystore.json'))
    passphrase = os.environ.get('GL_PASSPHRASE')
    if not passphrase:
        passphrase = prompt_passphrase(new_keystore)
    master_key, _ = load_or_create_keystore(passphrase)
    App.master_key = master_key

    httpd = HTTPServer(('0.0.0.0', PORT), App)
    print(f'GuessrLB v2 Python server on {ORIGIN}')
    httpd.serve_forever()


if __name__ == '__main__':
    main()
