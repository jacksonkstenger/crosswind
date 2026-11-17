// ---------- chart primitives (SVG, sized to the container at render time) ----------
function niceTicks(lo, hi, n = 4) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const chartWidth = root => Math.max(260, Math.min(1120, (root?.clientWidth || $('#main').clientWidth - 32)));

// Columns from a zero baseline. items: [{ label, value, color?, tip?: [title, rows], pick? }]
function colChart({ width, height = 150, items, yFmt = F.int, xEvery = 1, ref, yMax, barMax = 24 }) {
  const m = { l: 38, r: 8, t: items.some(d => d.mark) ? 20 : 10, b: 20 }, w = width - m.l - m.r, hh = height - m.t - m.b;
  const vals = items.map(d => d.value ?? 0);
  const lo = Math.min(0, ...vals), hi = Math.max(yMax ?? 0, ref?.value ?? 0, ...vals, 1e-9);
  const ticks = niceTicks(lo, hi, 3), y0 = Math.min(lo, ticks[0]), y1 = Math.max(hi, ticks.at(-1));
  const y = v => m.t + hh - (v - y0) / (y1 - y0) * hh, band = w / items.length, bw = Math.max(1.5, Math.min(barMax, band - 2));
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  for (const t of ticks) {
    svg.append(s('line', { class: t === 0 ? 'axis' : 'gridl', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }),
      s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, yFmt(t)));
  }
  if (ref) svg.append(s('line', { class: 'axis', x1: m.l, x2: width - m.r, y1: y(ref.value), y2: y(ref.value) }),
    s('text', { x: width - m.r, y: y(ref.value) - 4, 'text-anchor': 'end' }, ref.label));
  items.forEach((d, i) => {
    const cx = m.l + band * (i + 0.5), g = s('g');
    if (d.value != null) {
      const top = y(Math.max(0, d.value)), bot = y(Math.min(0, d.value)), r = Math.min(4, bw / 2, (bot - top));
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const path = d.value >= 0
        ? `M${x0} ${bot}V${top + r}Q${x0} ${top} ${x0 + r} ${top}H${x1 - r}Q${x1} ${top} ${x1} ${top + r}V${bot}Z`
        : `M${x0} ${top}V${bot - r}Q${x0} ${bot} ${x0 + r} ${bot}H${x1 - r}Q${x1} ${bot} ${x1} ${bot - r}V${top}Z`;
      g.append(s('path', { d: path, fill: d.color || PAL.series[0] }));
      if (d.mark) g.append(s('text', { x: cx, y: top - 5, 'text-anchor': 'middle', style: 'fill:var(--ink);font-weight:650' }, d.mark));
    }
    if (i % xEvery === 0 && d.label != null) {
      const edge = cx > width - 26;
      g.append(s('text', { x: edge ? width - 2 : cx, y: height - 5, 'text-anchor': edge ? 'end' : 'middle' }, d.label));
    }
    const hit = s('rect', { x: cx - band / 2, y: m.t, width: band, height: hh, fill: 'transparent', tabindex: d.tip ? 0 : null });
    if (d.tip) tipOn(hit, () => tipRows(d.tip[0], d.tip[1]));
    if (d.pick) { hit.style.cursor = 'pointer'; hit.addEventListener('click', d.pick); }
    g.append(hit); svg.append(g);
  });
  return svg;
}

// Lines sharing one axis. series: [{ name, color, pts: [[x, y], ...] }]
function lineChart({ width, height = 190, series, xTicks, xFmt = String, yFmt = F.int, tipTitle = String }) {
  const m = { l: 38, r: 48, t: 10, b: 22 }, w = width - m.l - m.r, hh = height - m.t - m.b;
  const xs = [...new Set(series.flatMap(sr => sr.pts.map(p => p[0])))].sort((a, b) => a - b);
  const ys = series.flatMap(sr => sr.pts.map(p => p[1]));
  const ticks = niceTicks(Math.min(0, ...ys), Math.max(...ys), 4), y0 = ticks[0], y1 = Math.max(ticks.at(-1), ...ys);
  const x = v => m.l + (v - xs[0]) / (xs.at(-1) - xs[0] || 1) * w, y = v => m.t + hh - (v - y0) / (y1 - y0) * hh;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });
  for (const t of ticks) svg.append(s('line', { class: t === 0 ? 'axis' : 'gridl', x1: m.l, x2: m.l + w, y1: y(t), y2: y(t) }),
    s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, yFmt(t)));
  for (const t of xTicks || xs) svg.append(s('text', { x: x(t), y: height - 5, 'text-anchor': 'middle' }, xFmt(t)));
  const ends = series.map(sr => ({ sr, yy: y(sr.pts.at(-1)[1]) })).sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 12) ends[i].yy = ends[i - 1].yy + 12;
  for (const sr of series) {
    svg.append(s('path', { d: 'M' + sr.pts.map(p => `${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('L'), fill: 'none',
      stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const e = sr.pts.at(-1), lab = ends.find(d => d.sr === sr);
    svg.append(s('circle', { cx: x(e[0]), cy: y(e[1]), r: 4, fill: sr.color, stroke: PAL.surface, 'stroke-width': 2 }),
      s('text', { x: x(e[0]) + 8, y: lab.yy + 4, style: 'fill:var(--ink-2);font-weight:600' }, sr.name));
  }
  const cross = s('line', { class: 'axis', y1: m.t, y2: m.t + hh, visibility: 'hidden' });
  const hit = s('rect', { x: m.l, y: m.t, width: w, height: hh, fill: 'transparent' });
  const move = e => {
    const box = svg.getBoundingClientRect(), px = (e.clientX - box.left) * (width / box.width);
    const xv = xs.reduce((a, b) => Math.abs(x(b) - px) < Math.abs(x(a) - px) ? b : a);
    cross.setAttribute('x1', x(xv)); cross.setAttribute('x2', x(xv)); cross.setAttribute('visibility', 'visible');
    Tip.show(e, [h('b', { text: tipTitle(xv) }), ...series.map(sr => {
      const p = sr.pts.find(q => q[0] === xv);
      return h('div', null, h('i', { style: { display: 'inline-block', width: '12px', height: '3px', background: sr.color, marginRight: '6px', verticalAlign: 'middle' } }),
        h('b', { text: p ? yFmt(p[1]) : '–' }), ' ', sr.name);
    })]);
  };
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); Tip.hide(); });
  svg.append(cross, hit);
  return svg;
}

// Horizontal ranked bars with the value at the tip (HTML, so labels wrap and stay legible).
function hbars(rows, { max, color } = {}) {
  const top = max ?? Math.max(...rows.map(r => r.value), 1e-9);
  return h('div', { class: 'hbars' }, rows.map(r => [
    h('span', { class: 'lbl' }, r.link || r.label),
    h('span', { class: 'track' }, h('span', { class: 'bar', style: { width: Math.max(0, r.value / top * 100) + '%', background: r.color || color || null } })),
    h('span', { class: 'val', text: r.text })]));
}

// A year of days as week columns. days: [{ date, value, flag, tip: [title, rows], pick }]
function calendarHeat({ width, days, color, cell }) {
  const first = new Date(days[0].date + 'T00:00:00Z').getUTCDay(), cols = Math.ceil((days.length + first) / 7);
  const c = cell || Math.max(4, Math.min(15, Math.floor((width - 24) / cols))), gap = c > 7 ? 2 : 1, top = 14;
  const svg = s('svg', { viewBox: `0 0 ${24 + cols * c} ${top + 7 * c}`, width: 24 + cols * c, height: top + 7 * c, role: 'img' });
  ['M', 'W', 'F'].forEach((d, i) => svg.append(s('text', { x: 0, y: top + (1 + i * 2) * c + c * 0.75, style: `font-size:${Math.min(10, c + 2)}px` }, d)));
  let lastMonth = -1;
  days.forEach((d, i) => {
    const k = i + first, col = Math.floor(k / 7), row = k % 7, mo = +d.date.slice(5, 7) - 1;
    if (mo !== lastMonth && +d.date.slice(8) <= 7) { lastMonth = mo; svg.append(s('text', { x: 24 + col * c, y: 10, style: 'font-size:10px' }, MONTHS[mo])); }
    const r = s('rect', { x: 24 + col * c, y: top + row * c, width: c - gap, height: c - gap, rx: 1.5,
      fill: d.value == null ? 'none' : color(d.value), tabindex: 0 });
    if (d.flag) r.setAttribute('stroke', PAL.accent), r.setAttribute('stroke-width', 1.5);
    tipOn(r, () => tipRows(d.tip[0], d.tip[1]));
    if (d.pick) { r.style.cursor = 'pointer'; r.addEventListener('click', d.pick); }
    svg.append(r);
  });
  return svg;
}

// ---------- tables ----------
function simpleTable(cols, rows) {
  return h('div', { class: 'scroll-x' }, h('table', null,
    h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.num ? 'r' : null, text: c.label })))),
    h('tbody', null, rows.map(r => h('tr', null, cols.map(c => h('td', { class: (c.num ? 'r ' : '') + (c.wrap ? 'wrap' : '') },
      c.render ? c.render(r) : (c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '–')))))))));
}
// Sortable table. cols: [{ key, label, num, fmt, render, sortVal }]
function dataTable({ cols, rows, sort, onRow, page = 60 }) {
  const state = { key: sort?.key, dir: sort?.dir || 'desc', shown: page };
  const wrap = h('div', { class: 'fig' });
  const draw = () => {
    const col = cols.find(c => c.key === state.key), val = col?.sortVal || (r => r[state.key]);
    const sorted = col ? [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * (state.dir === 'asc' ? 1 : -1);
    }) : rows;
    wrap.replaceChildren(h('div', { class: 'scroll-x' }, h('table', null,
      h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.num ? 'r' : null },
        h('button', { type: 'button', 'aria-sort': c.key === state.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : null,
          onclick: () => { state.dir = c.key === state.key ? (state.dir === 'asc' ? 'desc' : 'asc') : (c.num ? 'desc' : 'asc'); state.key = c.key; draw(); } }, c.label))))),
      h('tbody', null, sorted.slice(0, state.shown).map(r => h('tr', { class: onRow ? 'click' : null, onclick: onRow ? () => onRow(r) : null },
        cols.map(c => h('td', { class: c.num ? 'r' : null }, c.render ? c.render(r) : (c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '–'))))))))),
      sorted.length > state.shown && h('button', { class: 'btn', type: 'button', style: { justifySelf: 'start' },
        onclick: () => { state.shown += page * 3; draw(); } }, `Show more (${F.int(sorted.length - state.shown)} left)`));
  };
  draw();
  return wrap;
}

// A figure with a chart and its table twin behind one toggle.
function figure({ title, sub, chart, table, caption, legend }) {
  let mode = 'chart';
  const body = h('div', { class: 'scroll-x' }), fig = h('figure', { class: 'fig' });
  const toggle = h('button', { class: 'linkish', type: 'button', style: { fontSize: '12px' } });
  const draw = () => {
    toggle.textContent = mode === 'chart' ? 'Show table' : 'Show chart';
    body.replaceChildren(mode === 'chart' ? chart(chartWidth(fig)) : simpleTable(table.cols, table.rows));
  };
  toggle.addEventListener('click', () => { mode = mode === 'chart' ? 'table' : 'chart'; draw(); });
  put(fig, h('div', { class: 'fig-head' }, h('div', null, h('h2', { text: title }), sub && h('p', { text: sub })), table && toggle),
    legend && h('div', { class: 'legend' }, legend.map(([name, color, box]) => h('span', null, h('i', { class: box ? 'box' : null, style: { background: color } }), name))),
    body, caption && h('figcaption', { text: caption }));
  queueMicrotask(draw);
  return fig;
}
const tiles = items => h('div', { class: 'tiles' }, items.map(([value, label, small]) =>
  h('div', { class: 'tile' }, h('b', { text: value }), h('span', { text: label }), small && h('small', { text: small }))));
const kv = pairs => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));
