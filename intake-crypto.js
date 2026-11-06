/* Pawfolio intake: end-to-end encryption + sitter inbox client. v1
 *
 * Shared, byte-for-byte, by:
 *   - the sitter app            (decrypts, owns the inbox)
 *   - /pet-sitter-intake-form/  (client encrypts + sends)
 *   - Pawfolio "Send to a sitter" (client encrypts + sends)
 *
 * Crypto: sitter holds a P-256 ECDH key pair. The client makes a throwaway
 * P-256 key, does ECDH with the sitter's public key, runs HKDF-SHA-256
 * (salt = client ephemeral public key raw bytes, info = "pawfolio-intake-v1")
 * to get an AES-GCM-256 key, and encrypts JSON (gzipped when the browser can).
 * The server stores { epk, iv, ct, z } and can't read it.
 *
 * Exposes window.PawfolioIntake (also module.exports under Node for tests).
 */
(function (root) {
  'use strict';
  var FN_URL = 'https://mpanuzarzcfgjbheepmj.supabase.co/functions/v1/pawfolio-sitter-inbox';
  var ANON = 'sb_publishable_gQ7s_Xuxnn9aYiJmaa6K_w_RYXbQRUk';
  var INFO = 'pawfolio-intake-v1';
  var MAX_CT_CHARS = 1500000; // ~1.1 MB of ciphertext after base64url; server rejects above this
  var subtle = (root.crypto || globalThis.crypto).subtle;
  var te = new TextEncoder(), td = new TextDecoder();

  function b64u(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function randomId(n) { return b64u((root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(n || 16))); }

  async function streamBytes(bytes, Stream, mode) {
    var s = new Blob([bytes]).stream().pipeThrough(new Stream(mode));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  var canZip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  async function hkdfKey(sharedBits, saltBytes, usage) {
    var ikm = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: te.encode(INFO) },
      ikm, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }

  /* Sitter: make keys once, keep privateJwk safe (include it in backups). */
  async function generateSitterKeys() {
    var kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    var pubRaw = await subtle.exportKey('raw', kp.publicKey);
    return {
      inboxId: randomId(16),       // public, goes in the client link
      inboxSecret: randomId(32),   // private, only the sitter app; server keeps sha256
      publicKey: b64u(pubRaw),     // public, goes in the client link
      privateJwk: await subtle.exportKey('jwk', kp.privateKey)
    };
  }

  /* Client: encrypt any JSON-able object for a sitter public key. */
  async function encryptFor(sitterPublicKey, obj) {
    var sitterPub = await subtle.importKey('raw', unb64u(sitterPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    var epkRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    var bits = await subtle.deriveBits({ name: 'ECDH', public: sitterPub }, eph.privateKey, 256);
    var key = await hkdfKey(bits, epkRaw, 'encrypt');
    var plain = te.encode(JSON.stringify(obj)), z = 0;
    if (canZip) { plain = await streamBytes(plain, CompressionStream, 'gzip'); z = 1; }
    var iv = (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(12));
    var ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plain);
    return { v: 1, z: z, epk: b64u(epkRaw), iv: b64u(iv), ct: b64u(ct) };
  }

  /* Sitter: decrypt an envelope with the stored private JWK. */
  async function decryptWith(privateJwk, env) {
    var priv = await subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    var epkRaw = unb64u(env.epk);
    var epk = await subtle.importKey('raw', epkRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    var bits = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
    var key = await hkdfKey(bits, epkRaw, 'decrypt');
    var plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv) }, key, unb64u(env.ct)));
    if (env.z) plain = await streamBytes(plain, DecompressionStream, 'gzip');
    return JSON.parse(td.decode(plain));
  }

  async function sha256Hex(s) {
    var buf = await subtle.digest('SHA-256', te.encode(s));
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* Link helpers. Inbox + key ride in the #fragment so they never hit server logs.
   * Format: <intake url>?b=..&p=..&e=..#s=<inboxId>.<publicKey>               */
  function parseSendTarget(hash) {
    var m = /(?:^#|&)s=([A-Za-z0-9_-]{16,40})\.([A-Za-z0-9_-]{80,100})/.exec(hash || '');
    return m ? { inboxId: m[1], publicKey: m[2] } : null;
  }
  function sendFragment(inboxId, publicKey) { return '#s=' + inboxId + '.' + publicKey; }

  async function call(body) {
    var url = root.PAWFOLIO_INTAKE_FN_URL || FN_URL; // tests may override
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: ANON, authorization: 'Bearer ' + ANON },
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok || !data || data.error) {
      var err = new Error((data && data.error) || ('HTTP ' + r.status));
      err.status = r.status; throw err;
    }
    return data;
  }

  /* Server actions (see SPEC.md). */
  /* Sitter code: 8 chars, no look-alikes (no 0/O/1/I/L). Shown as XXXX-XXXX. */
  function newSitterCode() {
    var A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', r = (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(8)), s = '';
    for (var i = 0; i < 8; i++) s += A[r[i] % A.length];
    return s;
  }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function fmtCode(c) { c = normCode(c); return c.slice(0, 4) + '-' + c.slice(4); }

  /* register is idempotent per inbox; also (re)publishes the code + label.
   * keys.code is created here if missing (retries on 409 code_taken). */
  async function register(keys, label) {
    var hash = await sha256Hex(keys.inboxSecret);
    for (var tries = 0; tries < 5; tries++) {
      if (!keys.code) keys.code = newSitterCode();
      try {
        return await call({ action: 'register', inbox: keys.inboxId, token_hash: hash,
          public_key: keys.publicKey, code: keys.code, label: String(label || '').slice(0, 80) });
      } catch (e) { if (e.status === 409) { keys.code = null; continue; } throw e; }
    }
    throw new Error('code_taken');
  }
  /* Client: turn a typed sitter code into a send target { inboxId, publicKey, label }. */
  async function lookupCode(code) {
    var d = await call({ action: 'lookup', code: normCode(code) });
    return { inboxId: d.inbox, publicKey: d.public_key, label: d.label || '' };
  }
  async function submit(target, payload) {
    var env = await encryptFor(target.publicKey, payload);
    if (env.ct.length > MAX_CT_CHARS) { var e = new Error('too_large'); e.code = 'too_large'; throw e; }
    return call({ action: 'submit', inbox: target.inboxId, envelope: env });
  }
  async function list(keys) {
    return call({ action: 'list', inbox: keys.inboxId, token: keys.inboxSecret });
  }
  async function ack(keys, ids) {
    return call({ action: 'ack', inbox: keys.inboxId, token: keys.inboxSecret, ids: ids });
  }

  /* Shrink a photo to a JPEG data URL (max side px, quality). */
  function shrinkPhoto(dataUrlOrBlob, maxSide, quality) {
    maxSide = maxSide || 720; quality = quality || 0.78;
    return new Promise(function (resolve, reject) {
      var src = typeof dataUrlOrBlob === 'string' ? dataUrlOrBlob : URL.createObjectURL(dataUrlOrBlob);
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  var api = {
    version: 1, FN_URL: FN_URL,
    generateSitterKeys: generateSitterKeys, encryptFor: encryptFor, decryptWith: decryptWith,
    parseSendTarget: parseSendTarget, sendFragment: sendFragment,
    register: register, lookupCode: lookupCode, newSitterCode: newSitterCode, normCode: normCode, fmtCode: fmtCode, submit: submit, list: list, ack: ack,
    sha256Hex: sha256Hex, shrinkPhoto: shrinkPhoto, b64u: b64u, unb64u: unb64u
  };
  root.PawfolioIntake = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
