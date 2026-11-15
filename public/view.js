'use strict';
(async () => {
  const root = document.getElementById('v');
  const token = location.pathname.split('/')[2];
  const base = `/s/${token}`;

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
  const ICON = { pdf: '📄', video: '🎞️', image: '🖼️' };

  let data;
  try {
    const r = await fetch(`${base}/data`);
    if (!r.ok) throw new Error();
    data = await r.json();
  } catch {
    root.append(h('div', { class: 'vmsg' },
      h('h1', {}, 'This link isn’t available'),
      h('p', {}, 'The album may have been removed, or the link was replaced with a new one. Ask the sender for a fresh link.')));
    return;
  }

  const files = data.files;
  document.title = data.title;
  if (!files.length) {
    root.append(h('div', { class: 'vmsg' }, h('h1', {}, data.title), h('p', {}, 'This album is empty.')));
    return;
  }

  const url = (f) => `${base}/f/${f.id}`;
  let idx = 0;
  const built = new Set();

  /* ----- build DOM ----- */
  const title = h('div', { class: 'vtitle' }, data.title);
  const counter = h('div', { class: 'vcount' });
  const gridBtn = h('button', { 'aria-label': 'Show all', title: 'Show all (G)', onclick: () => openGrid() }, '▦ All');
  const zipBtn = h('a', { class: 'btn', href: `${base}/zip`, download: '' }, `Download all (${fmt(data.bytes)})`);
  const capName = h('b');
  const capMeta = h('span');
  const dl = h('a', { class: 'btn primary', download: '' }, 'Download original');
  const full = h('a', { class: 'btn', target: '_blank', rel: 'noopener' }, 'Open full size');
  const prev = h('button', { class: 'nav prev', 'aria-label': 'Previous', onclick: () => go(idx - 1) }, '‹');
  const next = h('button', { class: 'nav next', 'aria-label': 'Next', onclick: () => go(idx + 1) }, '›');
  const slides = files.map((f, i) => h('div', { class: 'slide', 'data-i': i }, h('div', { class: 'spin', 'aria-label': 'Loading' })));
  const track = h('div', { class: 'track', tabindex: '0', 'aria-label': 'Album' }, slides);

  root.append(
    h('div', { class: 'vbar' }, title, counter, gridBtn, zipBtn),
    h('div', { class: 'stage' }, track, prev, next),
    h('div', { class: 'vfoot' }, h('div', { class: 'vcap' }, capName, capMeta), h('div', { class: 'vacts' }, full, dl)));

  /* ----- slide content ----- */
  function fileCard(f, note) {
    return h('div', { class: 'fcard' },
      h('div', { class: 'ico' }, ICON[f.kind] || '📎'),
      h('b', {}, f.name),
      h('span', { class: 'vcount' }, fmt(f.size)),
      note ? h('span', { class: 'vcount' }, note) : null,
      h('div', { class: 'acts' },
        f.kind === 'pdf' || f.kind === 'video' ? h('a', { class: 'btn', href: url(f), target: '_blank', rel: 'noopener' }, f.kind === 'pdf' ? 'Open PDF' : 'Play') : null,
        h('a', { class: 'btn primary', href: `${url(f)}/download`, download: f.name }, 'Download')));
  }
  function build(i) {
    if (i < 0 || i >= files.length || built.has(i)) return;
    built.add(i);
    const f = files[i];
    const slide = slides[i];
    if (f.kind === 'image') {
      let triedOriginal = !f.preview;
      const img = h('img', { src: f.preview ? `${url(f)}/preview` : url(f), alt: f.name, draggable: 'false', decoding: 'async' });
      img.onerror = () => {
        if (!triedOriginal) { triedOriginal = true; img.src = url(f); return; }
        slide.replaceChildren(fileCard(f, 'This browser can’t display this format. You can still download the original.'));
      };
      img.onload = () => { const sp = slide.querySelector('.spin'); if (sp) sp.remove(); };
      slide.replaceChildren(h('div', { class: 'spin' }), img);
      img.style.display = 'none';
      img.addEventListener('load', () => { img.style.display = ''; });
    } else if (f.kind === 'video') {
      slide.replaceChildren(h('video', { src: url(f), controls: true, playsinline: true, preload: 'metadata' }));
    } else {
      slide.replaceChildren(fileCard(f));
    }
  }

  /* ----- navigation ----- */
  function update(i) {
    idx = i;
    const f = files[i];
    counter.textContent = `${i + 1} / ${files.length}`;
    capName.textContent = f.name;
    capMeta.textContent = fmt(f.size);
    dl.href = `${url(f)}/download`;
    dl.setAttribute('download', f.name);
    full.href = url(f);
    prev.disabled = i === 0;
    next.disabled = i === files.length - 1;
    [i - 1, i, i + 1, i + 2].forEach(build);
    try { history.replaceState(null, '', '#' + (i + 1)); } catch { /* ignore */ }
  }
  function go(i, smooth = true) {
    i = Math.max(0, Math.min(files.length - 1, i));
    track.scrollTo({ left: i * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    update(i);
  }
  let t;
  track.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (i !== idx && i >= 0 && i < files.length) update(i);
    }, 60);
  }, { passive: true });
  window.addEventListener('resize', () => { track.scrollLeft = idx * track.clientWidth; });

  /* ----- grid overlay ----- */
  let gridEl = null;
  function openGrid() {
    if (!gridEl) {
      gridEl = h('div', { class: 'grid', role: 'dialog', 'aria-label': 'All files' },
        h('div', { class: 'ghead' }, h('b', {}, `${files.length} file${files.length === 1 ? '' : 's'}`), h('button', { onclick: closeGrid }, 'Close')),
        h('div', { class: 'gitems' }, files.map((f, i) =>
          h('button', { class: 'g', 'aria-label': f.name, onclick: () => { closeGrid(); go(i, false); } },
            f.kind === 'image' ? h('img', { src: `${url(f)}/preview`, loading: 'lazy', alt: '', onerror: (e) => e.target.replaceWith(ICON.image) }) : ICON[f.kind]))));
      document.body.append(gridEl);
    }
    gridEl.hidden = false;
  }
  function closeGrid() { if (gridEl) gridEl.hidden = true; }

  /* ----- keyboard ----- */
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(idx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(idx - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(files.length - 1);
    else if (e.key === 'Escape') closeGrid();
    else if (e.key === 'g' || e.key === 'G') (gridEl && !gridEl.hidden ? closeGrid() : openGrid());
  });

  /* ----- start (supports #3 deep links) ----- */
  const start = parseInt(location.hash.slice(1), 10);
  idx = Number.isFinite(start) ? Math.max(0, Math.min(files.length - 1, start - 1)) : 0;
  update(idx);
  requestAnimationFrame(() => { track.scrollLeft = idx * track.clientWidth; track.focus({ preventScroll: true }); });
})();
