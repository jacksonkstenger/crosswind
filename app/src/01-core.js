'use strict';
// ---------- DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
function build(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const h = (tag, attrs, ...kids) => build(document.createElement(tag), attrs, kids);
const s = (tag, attrs, ...kids) => build(document.createElementNS(SVG_NS, tag), attrs, kids);
const put = (el, ...kids) => build(el, null, kids);   // append, skipping null / false

// ---------- formatting ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY0 = Date.UTC(2013, 0, 1);
const dayIdx = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - DAY0) / 864e5);
const idxDate = i => new Date(DAY0 + i * 864e5).toISOString().slice(0, 10);
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const F = {
  int: n => n == null ? '–' : Math.round(n).toLocaleString('en-US'),
  pct: (v, d = 0) => v == null ? '–' : (v * 100).toFixed(d) + '%',
  num: (v, d = 1) => v == null ? '–' : Number(v).toFixed(d),
  min: v => v == null ? '–' : `${Math.round(v)} min`,
  smin: v => { if (v == null) return '–'; const r = Math.round(v); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + ' min'; },
  date: iso => { const d = new Date(iso + 'T00:00:00Z'); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; },
  hhmm: v => v == null ? '–' : String(Math.floor(v / 100)).padStart(2, '0') + ':' + String(v % 100).padStart(2, '0'),
  p: v => { if (v == null) return '–'; if (v >= 0.001) return v.toFixed(3);
    const [m, e] = v.toExponential(1).split('e'); return `${m} × 10${[...String(+e)].map(c => SUP[c]).join('')}`; },
};

// ---------- colour ----------
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
function ramp(stops) {
  const cols = stops.map(rgb);
  return t => {
    const x = Math.max(0, Math.min(1, t)) * (cols.length - 1), i = Math.min(cols.length - 2, Math.floor(x)), f = x - i;
    return `rgb(${cols[i].map((c, k) => Math.round(c + (cols[i + 1][k] - c) * f)).join(',')})`;
  };
}
let PAL = {};
function readPalette() {
  const seq = ramp([1, 2, 3, 4, 5, 6, 7].map(i => cssVar('--seq-' + i)));
  const pos = ramp([cssVar('--div-mid'), cssVar('--div-pos-1'), cssVar('--div-pos-2'), cssVar('--div-pos-3')]);
  const neg = ramp([cssVar('--div-mid'), cssVar('--div-neg-1'), cssVar('--div-neg-2'), cssVar('--div-neg-3')]);
  PAL = { seq, div: t => (t >= 0 ? pos(t) : neg(-t)), series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => cssVar('--s' + i)),
    quiet: cssVar('--quiet'), surface: cssVar('--surface'), accent: cssVar('--accent') };
}

// ---------- icons ----------
const ICONS = {
  inbox: 'M4 6h16M4 12h16M4 18h10', map: 'M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z',
  explore: 'M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z', delays: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4.5l3 1.8',
  pipeline: 'M3 6h5v4H3zM16 4h5v4h-5zM16 15h5v4h-5zM8 8h4V6h4M12 8v9h4', ask: 'M4 5h16v11H10l-5 4v-4H4z',
  now: 'M3 12h4l3-7 4 14 3-7h4', back: 'M15 5l-7 7 7 7', close: 'M6 6l12 12M18 6L6 18',
  brand: 'M3 14c4-6 7-6 9 0s5 6 9 0M3 8c4-5 7-5 9 0s5 5 9 0',
};
const icon = name => s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
const SEV_SHAPE = { critical: 'M8 2h8l6 6v8l-6 6H8l-6-6V8z', high: 'M12 3l10 18H2z', medium: 'M12 2l10 10-10 10L2 12z' };
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium' };
const sevMark = v => h('span', { class: 'sev', 'data-v': v },
  s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: SEV_SHAPE[v], fill: 'currentColor' })), SEV_LABEL[v]);
const STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', investigating: 'Investigating', resolved: 'Resolved', dismissed: 'Dismissed' };
const statusPill = st => h('span', { class: 'pill', 'data-s': st, text: STATUS_LABEL[st] || st });
const TYPE_LABEL = { delay_spike: 'Delay spike', cancellation_cluster: 'Cancellation cluster', chronic_lateness: 'Chronically late week' };

// ---------- tooltip ----------
const Tip = {
  el: null,
  show(evt, content) {
    const el = this.el || (this.el = $('#tip'));
    el.replaceChildren(...[content].flat());
    el.hidden = false;
    const r = el.getBoundingClientRect(), pad = 12;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > innerWidth - 6) x = Math.max(6, evt.clientX - r.width - pad);
    if (y + r.height > innerHeight - 6) y = Math.max(6, evt.clientY - r.height - pad);
    el.style.left = x + 'px'; el.style.top = y + 'px';
  },
  hide() { if (Tip.el) Tip.el.hidden = true; },
};
function tipOn(el, make) {
  const show = e => Tip.show(e.clientX == null ? { clientX: el.getBoundingClientRect().left, clientY: el.getBoundingClientRect().bottom } : e, make());
  el.addEventListener('pointermove', show); el.addEventListener('pointerdown', show);
  el.addEventListener('pointerleave', Tip.hide); el.addEventListener('focus', show); el.addEventListener('blur', Tip.hide);
  return el;
}
const tipRows = (title, rows) => [h('b', { text: title }), ...rows.map(([k, v]) => h('div', null, h('b', { text: v }), ' ', k))];

// ---------- data ----------
const D = { byId: {} };
const getJSON = name => fetch(`data/${name}.json`).then(r => { if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`); return r.json(); });
const pending = {};
const need = name => (pending[name] ??= getJSON(name).then(v => {
  if (name === 'aircraft') {
    const cols = v[0];
    v = v.slice(1).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    D.byId.aircraft = new Map(v.map(a => [a.id, a]));
  }
  if (name === 'route_daily') D.byId.daily = new Map(v.map(r => [r.id, r]));
  return (D[name] = v);
}));
const index = (rows, key = 'id') => new Map(rows.map(r => [r[key], r]));

// ---------- state + routing ----------
// Two separate modes: the live feeds, and the 2013 archive.
const MODES = { live: [['now', 'Now'], ['live-map', 'Map']],
  archive: [['inbox', 'Alerts'], ['map', 'Map'], ['explore', 'Objects'], ['delays', 'Delays'], ['pipeline', 'Pipeline'], ['ask', 'Ask']] };
const VIEWS = [...MODES.live, ...MODES.archive];
const modeOf = v => (MODES.live.some(x => x[0] === v) ? 'live' : 'archive');
const NAV_ICON = { 'live-map': 'map' };
const VIEW = {};      // name -> { render(root) }
const DETAIL = {};    // object type -> { kind, get(id), render(obj), title(obj) }
const S = { view: 'inbox', home: 'inbox', last: { live: 'now', archive: 'inbox' }, stack: [], selfHash: null, width: innerWidth, askReady: false };
const HASHABLE = ['alert', 'route', 'airline', 'airport', 'aircraft', 'day'];

function hashFor(top) {
  if (!top || !HASHABLE.includes(top.type)) return S.view;
  return `${top.type}-${top.type === 'day' ? top.id.replace('_', '-') : top.id}`;
}
function syncHash() {
  const want = hashFor(S.stack.at(-1));
  if (location.hash.slice(1) !== want) { S.selfHash = want; location.hash = want; }
}
function applyHash(initial) {
  const x = location.hash.slice(1), m = /^([a-z]+)-(.+)$/.exec(x);
  if (m && HASHABLE.includes(m[1])) {
    if (initial || modeOf(S.view) === 'live') S.view = m[1] === 'alert' ? 'inbox' : 'explore';
    S.stack = [{ type: m[1], id: m[1] === 'day' ? m[2].replace('-', '_') : m[2] }];
  } else {
    S.view = VIEWS.some(v => v[0] === x) && (x !== 'ask' || S.askReady) ? x : (initial ? S.home : S.view);
    S.stack = [];
  }
  renderAll();
}
function setView(v) { S.view = v; S.stack = []; syncHash(); renderAll(); $('#main').scrollTop = 0; }
function openObj(type, id, fresh) {
  const top = S.stack.at(-1);
  if (top && top.type === type && top.id === id) return;
  if (fresh) S.stack = [];
  S.stack.push({ type, id }); syncHash(); renderDrawer(); VIEW[S.view].onSelect?.();
}
function popObj() { S.stack.pop(); syncHash(); renderDrawer(); VIEW[S.view].onSelect?.(); }
function closeDrawer() { S.stack = []; syncHash(); renderDrawer(); VIEW[S.view].onSelect?.(); }
const selected = type => { const t = S.stack.at(-1); return t && t.type === type ? t.id : null; };
const link = (type, id, label) => h('button', { class: 'linkish', type: 'button', onclick: e => { e.stopPropagation(); openObj(type, id); } }, label ?? id);

function renderNav() {
  const mode = modeOf(S.view);
  S.last[mode] = S.view;
  $('#top').replaceChildren(h('span', { class: 'brand' }, icon('brand'), 'Crosswind'),
    seg([['live', 'Live'], ['archive', '2013']], mode, m => { if (m !== mode) setView(S.last[m]); }, 'Data mode'));
  $('#nav').replaceChildren(...MODES[mode].filter(([id]) => id !== 'ask' || S.askReady).map(([id, label]) =>
    h('button', { type: 'button', 'aria-current': S.view === id ? 'page' : null, onclick: () => setView(id) },
      icon(NAV_ICON[id] || id), label)));
}
function renderDrawer() {
  const el = $('#drawer'), top = S.stack.at(-1);
  Tip.hide();
  if (!top) { el.hidden = true; el.replaceChildren(); return; }
  const def = DETAIL[top.type], body = h('div', { class: 'd-body' }, h('p', { class: 'muted', text: 'Loading…' }));
  el.hidden = false;
  el.replaceChildren(h('div', { class: 'd-head' },
    S.stack.length > 1 && h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: popObj }, icon('back')),
    h('span', { class: 'kind', text: def.kind }),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close details', onclick: closeDrawer }, icon('close'))), body);
  el.scrollTop = 0;
  Promise.resolve(def.get(top.id)).then(obj => {
    if (S.stack.at(-1) !== top) return;
    body.replaceChildren(); put(body, obj ? def.render(obj) : h('p', { text: `Nothing found for ${top.id}.` }));
  }).catch(err => body.replaceChildren(h('p', { text: `Could not load this: ${err.message}` })));
}
function renderAll() {
  readPalette(); renderNav();
  const main = $('#main'), root = h('div', { class: 'view' });
  VIEW[S.view].render(root);
  main.replaceChildren(root);
  renderDrawer();
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const viewHead = (title, lede) => h('header', { class: 'view-head' }, h('h1', { text: title }), lede && h('p', { class: 'lede', text: lede }));
const seg = (options, value, onPick, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
  options.map(([v, text]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onPick(v) }, text)));
