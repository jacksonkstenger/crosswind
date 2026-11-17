// ---------- route map (geometry is pre-projected in miles from New York) ----------
const MP = { metric: 'on_time', origin: 'all', zoom: 'mainland', sel: null };
const METRICS = {
  on_time: { label: 'On-time arrivals', fmt: v => F.pct(v), worstFirst: (a, b) => a - b,
    color: v => PAL.div((v - D.core.meta.kpis.on_time) / 0.15), legend: () => ['60%', `${F.pct(D.core.meta.kpis.on_time, 1)}, all routes`, '90%'],
    stops: () => [-1, -0.5, 0, 0.5, 1].map(PAL.div) },
  cancel_rate: { label: 'Cancellations', fmt: v => F.pct(v, 1), worstFirst: (a, b) => b - a,
    color: v => PAL.seq(v / 0.06), legend: () => ['0%', '3%', '6% or more'], stops: () => [0, 0.25, 0.5, 0.75, 1].map(PAL.seq) },
  alerts: { label: 'Alerts raised', fmt: v => F.int(v), worstFirst: (a, b) => b - a,
    color: v => (v ? PAL.seq(0.25 + 0.75 * v / 12) : PAL.quiet), legend: () => ['1', '6', '12 or more'], stops: () => [0.25, 0.45, 0.65, 0.85, 1].map(PAL.seq) },
};

METRICS.live = { label: 'Live FAA status', fmt: v => LIVE_STATUS[v][0], worstFirst: (a, b) => b - a,
  color: v => (v ? cssVar(LIVE_STATUS[v][1]) : PAL.quiet) };
const mapKey = () => (S.view === 'live-map' ? 'live' : MP.metric);
function mapRoutes() { return D.routes.filter(r => (MP.origin === 'all' || r.o === MP.origin) && r.o !== r.d && D.byId.airport.get(r.d).miles > 30); }
function destStats(routes) {
  const m = new Map();
  for (const r of routes) {
    const d = m.get(r.d) || m.set(r.d, { id: r.d, flights: 0, arrived: 0, late: 0, cancelled: 0, alerts: 0, routes: [] }).get(r.d);
    d.flights += r.flights; d.arrived += r.arrived; d.late += r.arrived * (1 - r.on_time); d.cancelled += r.cancelled; d.alerts += r.alerts; d.routes.push(r);
  }
  for (const d of m.values()) { d.on_time = d.arrived ? 1 - d.late / d.arrived : null; d.cancel_rate = d.cancelled / d.flights; d.live = Live.rank(d.id); }
  return m;
}

function drawMap(width) {
  const key = mapKey(), geo = D.geo, metric = METRICS[key], routes = mapRoutes(), dests = destStats(routes);
  if (key === 'live') for (const r of routes) r.live = Live.rank(r.d);
  const inView = [...dests.keys()].map(id => D.byId.airport.get(id)).filter(a => MP.zoom === 'all' || a.miles <= 2800);
  const xs = inView.map(a => a.x).concat(0), ys = inView.map(a => a.y).concat(0);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padX = (x1 - x0) * 0.06, padY = (y1 - y0) * 0.08; x0 -= padX; x1 += padX * 1.6; y0 -= padY; y1 += padY;
  const height = Math.round(Math.max(width * 0.55, Math.min(width * 1.05, width * (y1 - y0) / (x1 - x0))));
  const k = Math.min(width / (x1 - x0), height / (y1 - y0)), ox = (width - (x1 - x0) * k) / 2, oy = (height - (y1 - y0) * k) / 2;
  const X = x => ox + (x - x0) * k, Y = y => oy + (y - y0) * k;
  const ringPath = flat => { let d = ''; for (let i = 0; i < flat.length; i += 2) d += (i ? 'L' : 'M') + X(flat[i]).toFixed(1) + ' ' + Y(flat[i + 1]).toFixed(1); return d + 'Z'; };
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `Routes from New York coloured by ${metric.label.toLowerCase()}` });
  svg.append(s('path', { d: geo.land.map(ringPath).join(''), fill: 'var(--paper)', stroke: 'var(--line-2)', 'stroke-width': 0.6 }),
    s('path', { d: geo.states.flatMap(st => st.rings.map(ringPath)).join(''), fill: 'var(--paper)', stroke: 'var(--line-2)', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }));
  for (const miles of (MP.zoom === 'all' ? [1000, 2000, 3000, 4000, 5000] : [500, 1000, 1500, 2000, 2500])) {
    svg.append(s('circle', { cx: X(0), cy: Y(0), r: miles * k, fill: 'none', stroke: 'var(--line-2)', 'stroke-width': 0.7, opacity: 0.8 }),
      s('text', { x: X(miles * 0.259), y: Y(miles * 0.966) + 3, 'text-anchor': 'middle', style: 'font-size:10px;paint-order:stroke;stroke:var(--surface);stroke-width:3px' }, `${F.int(miles)} mi`));
  }
  const maxF = Math.max(...routes.map(r => r.flights)), lines = s('g');
  const ordered = [...routes].sort((a, b) => metric.worstFirst(b[key], a[key]));
  for (const r of ordered) {
    const o = D.byId.airport.get(r.o), d = D.byId.airport.get(r.d), dim = MP.sel && r.d !== MP.sel;
    lines.append(s('line', { x1: X(o.x), y1: Y(o.y), x2: X(d.x), y2: Y(d.y), stroke: metric.color(r[key]),
      'stroke-width': (0.7 + 2.6 * Math.sqrt(r.flights / maxF)).toFixed(2), 'stroke-linecap': 'round', opacity: dim ? 0.1 : 0.8 }));
  }
  svg.append(lines);
  const maxD = Math.max(...[...dests.values()].map(d => d.flights)), placed = [];
  const byFlights = [...dests.values()].sort((a, b) => b.flights - a.flights);
  const labelCount = width < 520 ? 12 : 30, labels = s('g'), points = [];
  placed.push([X(0) + 6, Y(0) + 3, X(0) + 66, Y(0) + 19]);   // keep airport codes clear of the New York label
  byFlights.forEach((d, rank) => {
    const a = D.byId.airport.get(d.id), cx = X(a.x), cy = Y(a.y);
    if (cx < -20 || cx > width + 20 || cy < -20 || cy > height + 20) return;
    const r = 2.5 + 5.5 * Math.sqrt(d.flights / maxD), g = s('g', { opacity: MP.sel && MP.sel !== d.id ? 0.35 : 1 });
    g.append(s('circle', { cx, cy, r, fill: metric.color(d[key]), stroke: MP.sel === d.id ? 'var(--accent)' : PAL.surface, 'stroke-width': MP.sel === d.id ? 2.5 : 1.5 }));
    const box = [cx + r + 2, cy - 7, cx + r + 2 + 24, cy + 6];
    if ((rank < labelCount || MP.sel === d.id) && !placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) {
      placed.push(box);
      labels.append(s('text', { x: cx + r + 3, y: cy + 4, opacity: MP.sel && MP.sel !== d.id ? 0.4 : 1, style: 'fill:var(--ink);font-weight:700;font-stretch:75%;paint-order:stroke;stroke:var(--surface);stroke-width:2.5px;pointer-events:none' }, d.id));
    }
    // Keyboard target only; pointer input goes through the nearest-airport layer below.
    const hit = s('circle', { cx, cy, r: r + 3, fill: 'transparent', tabindex: 0, role: 'button', style: 'pointer-events:none',
      'aria-label': `${a.name}, ${metric.label} ${metric.fmt(d[key])}` });
    const tip = () => tipRows(`${d.id}  ${a.name}`, [[metric.label.toLowerCase(), metric.fmt(d[key])], ['flights', F.int(d.flights)], ['miles', F.int(a.miles)]]);
    const pick = () => { MP.sel = MP.sel === d.id ? null : d.id; VIEW.map.redraw(); };
    hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    hit.addEventListener('focus', () => Tip.show({ clientX: svg.getBoundingClientRect().left + cx, clientY: svg.getBoundingClientRect().top + cy }, tip()));
    hit.addEventListener('blur', Tip.hide);
    points.push({ cx, cy, tip, pick });
    g.append(hit); svg.append(g);
  });
  // Dense clusters: the pointer only has to be closest to an airport, within 26px.
  const layer = s('rect', { x: 0, y: 0, width, height, fill: 'transparent' });
  const nearest = e => {
    const box = svg.getBoundingClientRect(), px = (e.clientX - box.left) * (width / box.width), py = (e.clientY - box.top) * (width / box.width);
    let best = null, bd = 26 * 26;
    for (const pt of points) { const dd = (pt.cx - px) ** 2 + (pt.cy - py) ** 2; if (dd < bd) { bd = dd; best = pt; } }
    return best;
  };
  layer.addEventListener('pointermove', e => { const pt = nearest(e); layer.style.cursor = pt ? 'pointer' : 'default'; pt ? Tip.show(e, pt.tip()) : Tip.hide(); });
  layer.addEventListener('pointerleave', Tip.hide);
  layer.addEventListener('click', e => { const pt = nearest(e); if (pt) { Tip.hide(); pt.pick(); } });
  svg.append(layer);
  svg.append(labels, s('circle', { cx: X(0), cy: Y(0), r: 4.5, fill: 'var(--ink)', stroke: PAL.surface, 'stroke-width': 1.5 }),
    s('text', { x: X(0) + 9, y: Y(0) + 15, style: 'fill:var(--ink);font-weight:700;paint-order:stroke;stroke:var(--surface);stroke-width:2.5px' }, 'New York'));
  return svg;
}

VIEW.map = {
  render(root) {
    const controls = h('div', { class: 'row' }), wrap = h('div', { class: 'mapwrap' }, h('p', { class: 'boot', text: 'Loading map…' }));
    const legend = h('div', { class: 'row', style: { fontSize: '12px', color: 'var(--ink-2)' } }), panel = h('div', { class: 'fig' }), list = h('div', { class: 'fig' });
    const redraw = () => {
      const live = mapKey() === 'live';
      controls.replaceChildren();
      put(controls,
        !live && seg(Object.entries(METRICS).filter(([key]) => key !== 'live').map(([key, m]) => [key, m.label]), MP.metric, v => { MP.metric = v; redraw(); }, 'Colour by'),
        seg([['all', 'All origins'], ['EWR', 'EWR'], ['JFK', 'JFK'], ['LGA', 'LGA']], MP.origin, v => { MP.origin = v; redraw(); }, 'Origin'),
        seg([['mainland', 'Within 2,800 mi'], ['all', 'All destinations']], MP.zoom, v => { MP.zoom = v; redraw(); }, 'Zoom'));
      if (!D.geo) return;
      const metric = METRICS[mapKey()], routes = mapRoutes(), dests = destStats(routes);
      if (MP.sel && !dests.has(MP.sel)) MP.sel = null;
      wrap.replaceChildren(drawMap(Math.max(280, wrap.clientWidth || $('#main').clientWidth - 34)));
      if (live) {
        legend.replaceChildren(...[0, 1, 2, 3].map(liveMark), h('span', { class: 'muted', text: `FAA feed, ${Live.age()}. Line width and dot size show 2013 flights.` }));
      } else {
        const [lo, mid, hi] = metric.legend();
        legend.replaceChildren(h('span', { text: metric.label }), h('span', { text: lo }),
          h('span', { style: { width: '120px', height: '10px', borderRadius: '2px', background: `linear-gradient(90deg, ${metric.stops().join(',')})` } }),
          h('span', { text: hi }), h('span', { class: 'muted', text: `Middle: ${mid}. Line width and dot size show flights.` }));
      }
      const sel = MP.sel && dests.get(MP.sel);
      panel.replaceChildren(...(sel ? [
        h('div', { class: 'fig-head' }, h('h2', null, link('airport', sel.id, `${sel.id}  ${D.byId.airport.get(sel.id).name}`)),
          h('button', { class: 'linkish', type: 'button', onclick: () => { MP.sel = null; redraw(); } }, 'Clear selection')),
        live && (Live.data.alerts.some(x => x.airport === sel.id) ? h('div', { class: 'bay' }, Live.data.alerts.filter(x => x.airport === sel.id).map(liveStrip))
          : h('p', { class: 'note', text: `${LIVE_STATUS[Live.rank(sel.id)][0]} now. The table shows the 2013 record.` })),
        simpleTable([{ label: 'Route', render: r => link('route', r.id, `${r.o} → ${r.d}`) }, { key: 'flights', label: 'Flights', num: true, fmt: F.int },
          { key: 'on_time', label: 'On time', num: true, fmt: v => F.pct(v) }, { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin },
          { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: v => F.pct(v, 1) }, { key: 'alerts', label: 'Alerts', num: true }], sel.routes)]
        : [h('p', { class: 'note', text: 'Select an airport on the map to see its routes.' })]));
      if (live) {
        const hit = Live.data.alerts.filter(x => x.scope === 'destination' && (MP.origin === 'all' || x.routes.some(r => r.startsWith(MP.origin))));
        list.replaceChildren(); put(list, h('h2', { text: `Destinations with an FAA programme now (${hit.length})` }),
          hit.length ? h('div', { class: 'bay' }, hit.map(liveStrip)) : h('p', { class: 'note', text: 'None. Every destination served from New York is operating normally.' }));
        return;
      }
      list.replaceChildren(h('h2', { text: `Routes, worst ${metric.label.toLowerCase()} first` }),
        dataTable({ rows: routes.filter(r => r.flights >= 200), page: 12, sort: { key: MP.metric, dir: MP.metric === 'on_time' ? 'asc' : 'desc' }, onRow: r => openObj('route', r.id, true),
          cols: [{ key: 'id', label: 'Route', render: r => `${r.o} → ${r.d}` }, { key: 'dest_name', label: 'Destination' }, { key: 'flights', label: 'Flights', num: true, fmt: F.int },
            { key: 'on_time', label: 'On time', num: true, fmt: v => F.pct(v) }, { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: v => F.pct(v, 1) },
            { key: 'alerts', label: 'Alerts', num: true }] }),
        h('p', { class: 'note', text: 'Routes with at least 200 flights in the year.' }));
    };
    this.redraw = redraw;
    if (mapKey() === 'live' && Live.state !== 'ok') { put(root, liveUnavailable()); return; }
    put(root, mapKey() === 'live' ? viewHead('Live map', 'Airports coloured by their current FAA status. A ground stop or delay programme at a destination holds the New York flights bound for it.')
      : viewHead('Route map', 'Azimuthal equidistant projection centred on New York. Distance and bearing from the city are true, so each route is a straight great-circle line and the range rings are circles.'),
      controls, wrap, legend, panel, h('section', { class: 'sect' }, list));
    redraw();
    need('geo').then(() => { if (wrap.isConnected) redraw(); }).catch(err => wrap.replaceChildren(h('p', { class: 'boot', text: `The map outline could not load (${err.message}). The route table below still works.` })));
  },
};
VIEW['live-map'] = VIEW.map;
