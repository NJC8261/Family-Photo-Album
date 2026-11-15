'use strict';
const root = document.getElementById('app');
const ALLOWED = 'jpg,jpeg,png,gif,webp,avif,heic,heif,tif,tiff,bmp,pdf,mp4,m4v,mov,webm'.split(',');
const ACCEPT = ALLOWED.map((e) => '.' + e).join(',');
const PREVIEWABLE = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
let authed = false;

/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}
function fmt(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const ICON = { pdf: '📄', video: '🎞️', image: '🖼️' };

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { authed = false; loginView(); throw new Error('auth'); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const guard = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { if (e.message !== 'auth') toast(e.message); }
};

/* ---------- views ---------- */
function loginView() {
  const err = h('p', { class: 'err' });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  root.replaceChildren(
    h('div', { class: 'login' },
      h('h1', {}, 'Albums'),
      h('p', { class: 'muted' }, 'Sign in to manage your albums.'),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          try {
            await api('POST', '/api/login', { password: pw.value });
            authed = true;
            route();
          } catch (ex) { err.textContent = ex.message; }
        },
      }, pw, h('button', { class: 'primary', type: 'submit' }, 'Sign in'), err)));
  pw.focus();
}

async function listView() {
  root.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'muted' }, 'Loading…')));
  let albums;
  try { albums = (await api('GET', '/api/albums')).albums; } catch (e) { return; }
  const title = h('input', { type: 'text', placeholder: 'New album name', maxlength: 100 });
  const create = guard(async (e) => {
    e.preventDefault();
    const a = await api('POST', '/api/albums', { title: title.value });
    location.hash = '#/album/' + a.id;
  });
  root.replaceChildren(h('div', { class: 'wrap' },
    h('div', { class: 'top' },
      h('h1', {}, 'Albums'),
      h('button', { onclick: guard(async () => { await api('POST', '/api/logout'); authed = false; loginView(); }) }, 'Sign out')),
    h('form', { class: 'panel row', onsubmit: create }, title, h('button', { class: 'primary', type: 'submit' }, 'Create album')),
    albums.length
      ? h('div', { class: 'albums' }, albums.map((a) =>
        h('a', { class: 'acard', href: '#/album/' + a.id },
          h('div', { class: 'acover' }, a.cover ? h('img', { src: `/s/${a.token}/f/${a.cover}/preview`, loading: 'lazy', alt: '' }) : '🖼️'),
          h('div', { class: 'ameta' }, h('b', {}, a.title), h('span', { class: 'muted' }, `${a.count} file${a.count === 1 ? '' : 's'} · ${fmt(a.bytes)}`)))))
      : h('p', { class: 'muted' }, 'No albums yet. Create one above, then add photos and PDFs.')));
}

async function albumViewPage(id) {
  root.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'muted' }, 'Loading…')));
  let album;
  try { album = await api('GET', '/api/albums/' + id); } catch (e) { if (e.message !== 'auth') { toast(e.message); location.hash = '#/'; } return; }

  const itemsBox = h('div');
  const uploadsBox = h('div', { class: 'uploads' });
  const titleEl = h('h1', {}, album.title);
  const countEl = h('p', { class: 'muted' });
  const shareInput = h('input', { type: 'text', readonly: true, 'aria-label': 'Share link' });
  const shareLink = () => `${location.origin}/a/${album.token}`;

  function renderAll() {
    titleEl.textContent = album.title;
    shareInput.value = shareLink();
    countEl.textContent = `${album.files.length} file${album.files.length === 1 ? '' : 's'} · ${fmt(album.files.reduce((s, f) => s + f.size, 0))} (stored as originals)`;
    itemsBox.replaceChildren(album.files.length
      ? h('div', { class: 'items' }, album.files.map((f) =>
        h('div', { class: 'item' },
          h('div', { class: 'thumb' }, f.kind === 'image' ? h('img', { src: `/s/${album.token}/f/${f.id}/preview`, loading: 'lazy', alt: '', onerror: (e) => e.target.replaceWith(ICON.image) }) : ICON[f.kind]),
          h('div', { class: 'meta' }, h('b', { title: f.name }, f.name), h('span', { class: 'muted' }, fmt(f.size))),
          h('div', { class: 'acts' },
            h('a', { class: 'btn', href: `/s/${album.token}/f/${f.id}/download`, download: f.name }, 'Download'),
            h('button', { class: 'danger', onclick: guard(async () => {
              if (!confirm(`Delete “${f.name}”?`)) return;
              await api('DELETE', `/api/albums/${album.id}/files/${f.id}`);
              album.files = album.files.filter((x) => x.id !== f.id);
              renderAll();
            }) }, 'Delete')))))
      : h('p', { class: 'muted' }, 'This album is empty.'));
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(shareLink()); toast('Link copied'); }
    catch { shareInput.select(); document.execCommand && document.execCommand('copy'); toast('Link copied'); }
  }

  /* ----- uploads ----- */
  function xhrUpload(url, blob, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      x.onload = () => {
        let body = {};
        try { body = JSON.parse(x.responseText); } catch { /* ignore */ }
        x.status < 300 ? resolve(body) : reject(new Error(body.error || 'Upload failed (HTTP ' + x.status + ')'));
      };
      x.onerror = () => reject(new Error('Network error'));
      x.send(blob);
    });
  }

  async function makePreview(file, ext) {
    if (!PREVIEWABLE.includes(ext) || file.size < 400 * 1024) return null;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    } catch { return null; }
  }

  async function uploadOne(file) {
    const bar = h('i');
    const state = h('span', { class: 'state muted' }, 'Waiting…');
    const row = h('div', { class: 'up' }, h('span', { class: 'name' }, file.name), state, h('div', { class: 'bar' }, bar));
    uploadsBox.append(row);
    const ext = extOf(file.name);
    if (!ALLOWED.includes(ext)) { row.classList.add('fail'); state.textContent = 'Type not supported'; return; }
    try {
      state.textContent = '0%';
      const meta = await xhrUpload(`/api/albums/${album.id}/files`, file, { 'X-File-Name': encodeURIComponent(file.name) }, (p) => {
        bar.style.width = Math.round(p * 100) + '%';
        state.textContent = Math.round(p * 100) + '%';
      });
      album.files.push(meta);
      renderAll();
      if (meta.kind === 'image') {
        state.textContent = 'Making preview…';
        const prev = await makePreview(file, ext);
        if (prev) {
          try {
            await xhrUpload(`/api/albums/${album.id}/files/${meta.id}/preview`, prev, {});
            meta.preview = true;
          } catch { /* original is still used as the preview */ }
        }
      }
      bar.style.width = '100%';
      state.textContent = 'Done';
      renderAll();
      setTimeout(() => row.remove(), 2500);
    } catch (e) {
      row.classList.add('fail');
      state.textContent = e.message;
    }
  }

  async function uploadMany(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    let i = 0;
    const worker = async () => { while (i < files.length) await uploadOne(files[i++]); };
    await Promise.all([worker(), worker(), worker()]);
  }

  const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, onchange: (e) => { uploadMany(e.target.files); e.target.value = ''; } });
  const drop = h('label', { class: 'drop' },
    h('b', {}, 'Add photos & PDFs'),
    h('span', { class: 'muted' }, 'Tap to choose files, or drop them here. Originals are stored untouched.'),
    input);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => uploadMany(e.dataTransfer.files));

  root.replaceChildren(h('div', { class: 'wrap' },
    h('div', { class: 'top' },
      h('a', { class: 'back', href: '#/' }, '← Albums'),
      titleEl,
      h('button', { onclick: guard(async () => {
        const t = prompt('Album name', album.title);
        if (t == null) return;
        album = { ...album, ...(await api('PATCH', '/api/albums/' + album.id, { title: t })) };
        renderAll();
      }) }, 'Rename')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Share link'),
      h('div', { class: 'row' },
        shareInput,
        h('button', { class: 'primary', onclick: copyLink }, 'Copy link'),
        navigator.share ? h('button', { onclick: () => navigator.share({ title: album.title, url: shareLink() }).catch(() => {}) }, 'Share…') : null,
        h('a', { class: 'btn', href: '/a/' + album.token, target: '_blank', rel: 'noopener' }, 'Open'),
        h('button', { onclick: guard(async () => {
          if (!confirm('Create a new link? The old link will stop working.')) return;
          album = { ...album, ...(await api('POST', `/api/albums/${album.id}/rotate`)) };
          renderAll();
          toast('New link created');
        }) }, 'New link')),
      h('p', { class: 'muted' }, 'Anyone with this link can view the album and download the original files.')),
    h('div', { class: 'panel' }, drop, uploadsBox),
    countEl,
    itemsBox,
    h('div', { class: 'panel' },
      h('button', { class: 'danger', onclick: guard(async () => {
        if (!confirm(`Delete the album “${album.title}” and all its files? This cannot be undone.`)) return;
        await api('DELETE', '/api/albums/' + album.id);
        location.hash = '#/';
      }) }, 'Delete album'))));
  renderAll();
}

/* ---------- routing ---------- */
function route() {
  const m = /^#\/album\/([a-f0-9]{16})$/.exec(location.hash);
  if (m) albumViewPage(m[1]); else listView();
}
window.addEventListener('hashchange', () => { if (authed) route(); });
(async () => {
  try {
    const s = await (await fetch('/api/session', { credentials: 'same-origin' })).json();
    authed = !!s.admin;
  } catch { /* offline */ }
  authed ? route() : loginView();
})();
