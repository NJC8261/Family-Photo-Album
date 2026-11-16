'use strict';
/*
 * Photo Albums — a tiny, dependency-free album sharing server.
 * Requires Node.js 20.15+ (uses zlib.crc32). Run: node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { once } = require('events');
const { execFile } = require('child_process');
const fsp = fs.promises;

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_FILE = (Number(process.env.MAX_FILE_MB) || 2000) * 1024 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PDF_MAX_PAGES = Number(process.env.PDF_MAX_PAGES) || 100; // pages rendered per PDF for the swipe viewer
const PUBLIC = path.join(__dirname, 'public');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const CFG_PATH = path.join(DATA_DIR, 'config.json');

/* ---------- small helpers ---------- */
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url'); // 24 chars
const isId = (s) => typeof s === 'string' && /^[a-f0-9]{16}$/.test(s);
const isToken = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{24}$/.test(s);

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function send(res, status, body, headers = {}) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Length': b.length, ...headers });
  res.end(b);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(httpErr(413, 'Request too large'));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpErr(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------- file types ---------- */
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const kindOf = (ext) => (ext === 'pdf' ? 'pdf' : TYPES[ext]?.startsWith('video/') ? 'video' : 'image');

function cleanName(n) {
  n = String(n || '')
    .normalize('NFC')
    .replace(/[\\/\u0000-\u001f\u007f:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (n.length > 200) n = n.slice(-200);
  return n || 'file';
}

function sniffOk(ext, head) {
  if (ext === 'jpg' || ext === 'jpeg') return head[0] === 0xff && head[1] === 0xd8;
  if (ext === 'png') return head.length >= 4 && head.readUInt32BE(0) === 0x89504e47;
  if (ext === 'gif') return head.slice(0, 3).toString('latin1') === 'GIF';
  if (ext === 'pdf') return head.slice(0, 1024).includes('%PDF');
  return true;
}

/* ---------- config / auth ---------- */
let cfg;
const scryptHash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

async function loadConfig() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  let c = {};
  try { c = JSON.parse(await fsp.readFile(CFG_PATH, 'utf8')); } catch { /* first run */ }
  let dirty = false;
  if (!c.secret) { c.secret = rid(32); dirty = true; }
  if (!c.salt) { c.salt = rid(16); dirty = true; }
  let hash = c.hash;
  if (process.env.ADMIN_PASSWORD) {
    hash = scryptHash(process.env.ADMIN_PASSWORD, c.salt);
  } else if (!c.hash) {
    const pw = crypto.randomBytes(9).toString('base64url');
    c.hash = hash = scryptHash(pw, c.salt);
    dirty = true;
    console.log('\n  No ADMIN_PASSWORD set. Generated one for you (shown once):');
    console.log('  ' + pw + '\n');
  }
  if (dirty) {
    await fsp.writeFile(CFG_PATH, JSON.stringify({ secret: c.secret, salt: c.salt, hash: c.hash }), { mode: 0o600 });
  }
  cfg = { secret: c.secret, salt: c.salt, hash };
}

const SESSION_MS = 30 * 24 * 3600 * 1000;
const sign = (s) => crypto.createHmac('sha256', cfg.secret).update(s).digest('base64url');
const makeSession = () => { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); };

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isAdmin(req) {
  const c = parseCookies(req.headers.cookie).sid;
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}
const isHttps = (req) => !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, value, maxAge) =>
  `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

const fails = new Map();
const ipOf = (req) =>
  (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
function throttled(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.until) { fails.delete(ip); return false; }
  return f.count >= 5;
}
function noteFail(ip) {
  const f = fails.get(ip) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  f.count++;
  fails.set(ip, f);
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

/* ---------- database (single JSON file, atomic writes) ---------- */
let db = { albums: {} };
let saving = Promise.resolve();
function save() {
  saving = saving
    .then(async () => {
      const tmp = DB_PATH + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db));
      await fsp.rename(tmp, DB_PATH);
    })
    .catch((e) => console.error('Could not save database:', e));
  return saving;
}
async function loadDb() {
  try { db = JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); } catch { db = { albums: {} }; }
  if (!db.albums) db.albums = {};
}
const albumById = (id) => (isId(id) ? db.albums[id] : undefined);
const albumByToken = (t) => (isToken(t) ? Object.values(db.albums).find((a) => a.token === t) : undefined);
const albumDir = (a) => path.join(FILES_DIR, a.id);
const filePath = (a, f) => path.join(albumDir(a), f.id + '.bin');
const previewPath = (a, f) => path.join(albumDir(a), f.id + '.prev.jpg');

const publicFile = (f) => ({
  id: f.id, name: f.name, kind: f.kind, size: f.size, preview: !!f.preview,
  pages: f.pages || 0, pagesCapped: !!f.pagesCapped,
});

/* ---------- PDF page rendering (poppler's pdftoppm; originals are never touched) ---------- */
const pagesDir = (a, f) => path.join(albumDir(a), f.id + '.pages');
const pagePath = (a, f, n) => path.join(pagesDir(a, f), n + '.jpg');
const execP = (cmd, args, timeout) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())));
let warnedNoPoppler = false;

async function renderPdf(album, f) {
  const dir = pagesDir(album, f);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  try {
    await execP('pdftoppm', ['-jpeg', '-jpegopt', 'quality=85', '-r', '110', '-l', String(PDF_MAX_PAGES), filePath(album, f), path.join(dir, 'p')], 180000);
    const found = (await fsp.readdir(dir))
      .map((n) => /^p-(\d+)\.jpg$/.exec(n))
      .filter(Boolean)
      .map((m) => ({ name: m[0], n: Number(m[1]) }))
      .sort((a, b) => a.n - b.n);
    let i = 0;
    for (const { name } of found) await fsp.rename(path.join(dir, name), pagePath(album, f, ++i));
    f.pages = found.length;
    f.pagesCapped = found.length >= PDF_MAX_PAGES;
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    if (e.code === 'ENOENT') {
      if (!warnedNoPoppler) { console.warn('pdftoppm not found: PDF page previews are disabled (install poppler-utils).'); warnedNoPoppler = true; }
      return; // leave f.pages unset so it is retried on a later start
    }
    console.error('PDF render failed for', f.name, '-', e.message);
    f.pages = 0;
  }
  if (db.albums[album.id]) await save();
}

async function backfillPdfPages() {
  for (const album of Object.values(db.albums)) {
    for (const f of [...album.files]) {
      if (f.kind === 'pdf' && f.pages === undefined && db.albums[album.id] && album.files.includes(f)) await renderPdf(album, f);
    }
  }
}
function albumView(a, admin) {
  const o = {
    id: a.id, title: a.title, created: a.created,
    count: a.files.length, bytes: a.files.reduce((s, f) => s + f.size, 0),
    files: a.files.map(publicFile),
  };
  if (admin) o.token = a.token;
  return o;
}

/* ---------- streaming upload to disk ---------- */
function receiveToFile(req, dest, { max, ext }) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let size = 0, crc = 0, head = Buffer.alloc(0), checked = false, failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err;
      ws.destroy();
      req.resume(); // drain the rest so we can still send a response
    };
    ws.on('error', (e) => { fail(e); reject(e); });
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) return fail(httpErr(413, 'File is too large'));
      if (!checked) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 16) {
          checked = true;
          if (!sniffOk(ext, head)) return fail(httpErr(415, 'File contents do not match its type'));
        }
      }
      crc = zlib.crc32(chunk, crc);
      if (!ws.write(chunk)) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (failed) return reject(failed);
      if (!checked && !sniffOk(ext, head)) return reject(httpErr(415, 'File contents do not match its type'));
      if (size === 0) return reject(httpErr(400, 'Empty file'));
      ws.end(() => resolve({ size, crc: crc >>> 0 }));
    });
    req.on('close', () => {
      if (!req.complete) { ws.destroy(); reject(httpErr(400, 'Upload interrupted')); }
    });
    req.on('error', (e) => { ws.destroy(); reject(e); });
  });
}

/* ---------- file serving (original bytes, no compression, Range support) ---------- */
function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

async function serveFile(req, res, p, { mime, name, attachment, cache }) {
  let st;
  try { st = await fsp.stat(p); } catch { return json(res, 404, { error: 'Not found' }); }
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'Content-Disposition': contentDisposition(attachment ? 'attachment' : 'inline', name),
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(p, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

/* ---------- ZIP (stored, i.e. uncompressed; sizes/CRCs known up front) ---------- */
function dosDateTime(ms) {
  const d = new Date(ms);
  const y = Math.max(1980, d.getFullYear());
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}
function uniqueName(name, used) {
  let n = name, i = 1;
  const ext = path.extname(name), base = path.basename(name, ext);
  while (used.has(n.toLowerCase())) { i++; n = `${base} (${i})${ext}`; }
  used.add(n.toLowerCase());
  return n;
}

async function serveZip(req, res, album) {
  if (!album.files.length) return json(res, 404, { error: 'This album is empty' });
  const used = new Set();
  const entries = [];
  const central = [];
  let offset = 0;
  for (const f of album.files) {
    if (f.size > 0xffffffff) return json(res, 413, { error: 'A file is too large for ZIP; download files individually' });
    const nameBuf = Buffer.from(uniqueName(f.name, used), 'utf8');
    const { date, time } = dosDateTime(f.added);
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(f.crc >>> 0, 14); lh.writeUInt32LE(f.size, 18); lh.writeUInt32LE(f.size, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28); nameBuf.copy(lh, 30);
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(f.crc >>> 0, 16); ch.writeUInt32LE(f.size, 20); ch.writeUInt32LE(f.size, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42); nameBuf.copy(ch, 46);
    entries.push({ lh, path: filePath(album, f) });
    central.push(ch);
    offset += lh.length + f.size;
  }
  if (entries.length > 0xffff) return json(res, 413, { error: 'Too many files for one ZIP' });
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  const total = offset + cdSize + 22;
  if (total > 0xffffffff) return json(res, 413, { error: 'Album is over 4 GB; download files individually' });

  const zipName = cleanName(album.title) + '.zip';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': total,
    'Content-Disposition': contentDisposition('attachment', zipName),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();

  let aborted = false;
  res.on('close', () => { aborted = true; });
  const write = async (buf) => { if (!res.write(buf)) await once(res, 'drain'); };
  try {
    for (const e of entries) {
      if (aborted) return;
      await write(e.lh);
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(e.path);
        res.once('close', () => rs.destroy());
        rs.on('error', reject);
        rs.on('close', resolve);
        rs.on('data', (c) => { if (!res.write(c)) { rs.pause(); res.once('drain', () => rs.resume()); } });
      });
    }
    for (const c of central) await write(c);
    res.end(end);
  } catch (e) {
    res.destroy();
  }
}

/* ---------- static pages ---------- */
const STATIC = {
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function sendPublicFile(res, name, type, extra = {}) {
  try {
    const body = await fsp.readFile(path.join(PUBLIC, name));
    send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

/* ---------- routes ---------- */
async function publicRoute(req, res, parts) {
  const album = albumByToken(parts[0]);
  if (!album) return json(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });

  if (parts[1] === 'data' && parts.length === 2) {
    return json(res, 200, { title: album.title, count: album.files.length, bytes: album.files.reduce((s, f) => s + f.size, 0), files: album.files.map(publicFile) });
  }
  if (parts[1] === 'zip' && parts.length === 2) return serveZip(req, res, album);

  if (parts[1] === 'f' && isId(parts[2])) {
    const f = album.files.find((x) => x.id === parts[2]);
    if (!f) return json(res, 404, { error: 'Not found' });
    const mime = TYPES[f.ext] || 'application/octet-stream';
    if (parts.length === 3) {
      return serveFile(req, res, filePath(album, f), { mime, name: f.name, attachment: false, cache: 'private, max-age=3600' });
    }
    if (parts.length === 4 && parts[3] === 'download') {
      return serveFile(req, res, filePath(album, f), { mime: 'application/octet-stream', name: f.name, attachment: true, cache: 'private, no-cache' });
    }
    if (parts.length === 4 && parts[3] === 'preview') {
      if (f.preview) return serveFile(req, res, previewPath(album, f), { mime: 'image/jpeg', name: f.name + '.jpg', attachment: false, cache: 'private, max-age=86400' });
      if (f.kind === 'image') return serveFile(req, res, filePath(album, f), { mime, name: f.name, attachment: false, cache: 'private, max-age=3600' });
      if (f.kind === 'pdf' && f.pages > 0) return serveFile(req, res, pagePath(album, f, 1), { mime: 'image/jpeg', name: f.name + '-p1.jpg', attachment: false, cache: 'private, max-age=86400' });
    }
    if (parts.length === 5 && parts[3] === 'page' && f.kind === 'pdf' && /^\d{1,4}$/.test(parts[4])) {
      const n = Number(parts[4]);
      if (n >= 1 && n <= (f.pages || 0)) {
        return serveFile(req, res, pagePath(album, f, n), { mime: 'image/jpeg', name: `${f.name}-p${n}.jpg`, attachment: false, cache: 'private, max-age=86400' });
      }
    }
  }
  return json(res, 404, { error: 'Not found' });
}

async function apiRoute(req, res, parts) {
  const m = req.method;

  if (parts[0] === 'session' && m === 'GET') return json(res, 200, { admin: isAdmin(req) });

  if (parts[0] === 'login' && m === 'POST') {
    const ip = ipOf(req);
    if (throttled(ip)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const body = await readJson(req);
    const given = Buffer.from(scryptHash(String(body.password || ''), cfg.salt));
    const real = Buffer.from(cfg.hash);
    if (given.length === real.length && crypto.timingSafeEqual(given, real)) {
      fails.delete(ip);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, makeSession(), SESSION_MS / 1000) });
    }
    noteFail(ip);
    return json(res, 401, { error: 'Wrong password' });
  }
  if (parts[0] === 'logout' && m === 'POST') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
  }

  if (!isAdmin(req)) return json(res, 401, { error: 'Not signed in' });
  if (parts[0] !== 'albums') return json(res, 404, { error: 'Not found' });

  if (parts.length === 1) {
    if (m === 'GET') {
      const list = Object.values(db.albums)
        .sort((a, b) => b.created - a.created)
        .map((a) => {
          const v = albumView(a, true);
          const cover = a.files.find((f) => f.kind === 'image');
          v.cover = cover ? cover.id : null;
          delete v.files;
          return v;
        });
      return json(res, 200, { albums: list });
    }
    if (m === 'POST') {
      const body = await readJson(req);
      const title = String(body.title || '').trim().slice(0, 100) || 'Untitled album';
      const a = { id: rid(8), title, token: newToken(), created: Date.now(), files: [] };
      db.albums[a.id] = a;
      await fsp.mkdir(albumDir(a), { recursive: true });
      await save();
      return json(res, 201, albumView(a, true));
    }
  }

  const album = albumById(parts[1]);
  if (!album) return json(res, 404, { error: 'Album not found' });

  if (parts.length === 2) {
    if (m === 'GET') return json(res, 200, albumView(album, true));
    if (m === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.title === 'string') album.title = body.title.trim().slice(0, 100) || album.title;
      await save();
      return json(res, 200, albumView(album, true));
    }
    if (m === 'DELETE') {
      delete db.albums[album.id];
      await save();
      await fsp.rm(albumDir(album), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
  }

  if (parts[2] === 'rotate' && parts.length === 3 && m === 'POST') {
    album.token = newToken();
    await save();
    return json(res, 200, albumView(album, true));
  }

  if (parts[2] === 'files') {
    if (parts.length === 3 && m === 'POST') {
      const name = cleanName(decodeURIComponent(String(req.headers['x-file-name'] || '')));
      const ext = path.extname(name).slice(1).toLowerCase();
      if (!TYPES[ext]) { req.resume(); return json(res, 415, { error: 'File type not allowed' }); }
      if (Number(req.headers['content-length']) > MAX_FILE) {
        req.resume();
        return json(res, 413, { error: `File is larger than the ${Math.round(MAX_FILE / 1048576)} MB limit` }, { Connection: 'close' });
      }
      const f = { id: rid(8), name, ext, kind: kindOf(ext), size: 0, crc: 0, added: Date.now(), preview: false };
      await fsp.mkdir(albumDir(album), { recursive: true });
      const dest = filePath(album, f);
      try {
        const r = await receiveToFile(req, dest, { max: MAX_FILE, ext });
        f.size = r.size; f.crc = r.crc;
      } catch (e) {
        await fsp.rm(dest, { force: true });
        throw e;
      }
      if (!db.albums[album.id]) { await fsp.rm(dest, { force: true }); return json(res, 404, { error: 'Album was deleted' }); }
      album.files.push(f);
      await save();
      if (f.kind === 'pdf') await renderPdf(album, f); // page images for the swipe viewer
      return json(res, 201, publicFile(f));
    }

    const f = album.files.find((x) => x.id === parts[3]);
    if (!f) { if (m === 'POST') req.resume(); return json(res, 404, { error: 'File not found' }); }

    if (parts.length === 4 && m === 'DELETE') {
      album.files = album.files.filter((x) => x !== f);
      await save();
      await fsp.rm(filePath(album, f), { force: true });
      await fsp.rm(previewPath(album, f), { force: true });
      await fsp.rm(pagesDir(album, f), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (parts.length === 5 && parts[4] === 'preview' && m === 'POST') {
      if (f.kind !== 'image') { req.resume(); return json(res, 400, { error: 'Only images have previews' }); }
      const dest = previewPath(album, f);
      try {
        await receiveToFile(req, dest, { max: 12 * 1024 * 1024, ext: 'jpg' });
      } catch (e) {
        await fsp.rm(dest, { force: true });
        throw e;
      }
      f.preview = true;
      await save();
      return json(res, 200, publicFile(f));
    }
  }
  return json(res, 404, { error: 'Not found' });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean);
  const method = req.method;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate');

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    req.resume();
    return json(res, 403, { error: 'Cross-origin request blocked' });
  }

  if (p === '/robots.txt' && (method === 'GET' || method === 'HEAD')) {
    return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  }
  if (p === '/' && (method === 'GET' || method === 'HEAD')) {
    return sendPublicFile(res, 'index.html', 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
  }
  if (parts[0] === 'a' && parts.length === 2 && isToken(parts[1]) && (method === 'GET' || method === 'HEAD')) {
    return sendPublicFile(res, 'view.html', 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
  }
  if (STATIC[p] && (method === 'GET' || method === 'HEAD')) return sendPublicFile(res, STATIC[p][0], STATIC[p][1]);
  if (parts[0] === 's' && parts.length >= 3) return publicRoute(req, res, parts.slice(1));
  if (parts[0] === 'api') return apiRoute(req, res, parts.slice(1));
  return json(res, 404, { error: 'Not found' });
}

/* ---------- start ---------- */
(async () => {
  await loadConfig();
  await loadDb();
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Server error' : e.message });
      else res.destroy();
    });
  });
  server.requestTimeout = 0;       // allow very large uploads
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Photo Albums running on http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    backfillPdfPages().catch((e) => console.error('PDF backfill failed:', e));
  });
  const stop = async () => { await saving; process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})();
