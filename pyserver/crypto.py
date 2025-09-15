import os
import hmac
import hashlib
from base64 import b64encode, b64decode

try:
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
except Exception as e:
    ChaCha20Poly1305 = None


def _require_crypto():
    if ChaCha20Poly1305 is None:
        raise ImportError("cryptography is required. Install with: pip install cryptography")


def _key32(master_key: bytes) -> bytes:
    # Ensure 32-byte key; master_key from scrypt is already 32 bytes.
    if len(master_key) == 32:
        return master_key
    return hashlib.sha256(master_key).digest()


def encrypt(master_key: bytes, plaintext: bytes) -> dict:
    """Encrypt using ChaCha20-Poly1305 (AEAD). Returns JSON-safe dict.
    Fields: { v, alg, nonce, ct }
    """
    _require_crypto()
    if not isinstance(plaintext, (bytes, bytearray)):
        raise TypeError('plaintext must be bytes')
    key = _key32(master_key)
    aead = ChaCha20Poly1305(key)
    nonce = os.urandom(12)
    ct = aead.encrypt(nonce, bytes(plaintext), associated_data=None)
    return {
        'v': 2,
        'alg': 'CHACHA20-POLY1305',
        'nonce': b64encode(nonce).decode('ascii'),
        'ct': b64encode(ct).decode('ascii'),
    }


def decrypt(master_key: bytes, blob: dict) -> bytes:
    if not isinstance(blob, dict):
        raise TypeError('blob must be dict')
    # Support legacy format with explicit tag
    if 'tag' in blob and blob.get('alg') == 'HMAC-STREAM-HKDF-SHA256':
        # Legacy fallback: validate and decrypt
        return _decrypt_legacy(master_key, blob)

    _require_crypto()
    key = _key32(master_key)
    aead = ChaCha20Poly1305(key)
    nonce = b64decode(blob['nonce'])
    ct = b64decode(blob['ct'])
    return aead.decrypt(nonce, ct, associated_data=None)


# Legacy support (v1) — minimal to allow reading prior data if present
def _hkdf_sha256(key_material: bytes, info: bytes, length: int) -> bytes:
    out = b""
    t = b""
    counter = 1
    while len(out) < length:
        t = hmac.new(key_material, t + info + bytes([counter]), hashlib.sha256).digest()
        out += t
        counter += 1
    return out[:length]


def _keystream(enc_key: bytes, nonce: bytes, length: int) -> bytes:
    blocks = []
    counter = 0
    total = 0
    while total < length:
        counter_bytes = counter.to_bytes(4, 'big')
        block = hmac.new(enc_key, nonce + counter_bytes, hashlib.sha256).digest()
        blocks.append(block)
        total += len(block)
        counter += 1
    return b"".join(blocks)[:length]


def _decrypt_legacy(master_key: bytes, blob: dict) -> bytes:
    nonce = b64decode(blob['nonce'])
    ct = b64decode(blob['ct'])
    tag = b64decode(blob['tag'])
    enc_key = _hkdf_sha256(master_key, b'enc', 32)
    mac_key = _hkdf_sha256(master_key, b'mac', 32)
    calc = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(calc, tag):
        raise ValueError('invalid tag')
    ks = _keystream(enc_key, nonce, len(ct))
    pt = bytes(a ^ b for a, b in zip(ct, ks))
    return pt
