// ---------- pipeline: lineage drawn from the DAG the pipeline actually ran ----------
const PL = { sel: null };
const LAYERS = [['raw', 'Raw'], ['clean', 'Clean'], ['processed', 'Processed'], ['enriched', 'Enriched'], ['transform', 'Transform'],
  ['metrics', 'Metrics'], ['alerts', 'Alerts'], ['ontology', 'Ontology tables'], ['object', 'Object types']];
const GROUPS = ['Operations source', 'Weather source', 'Reference data', 'Flight delays', 'Aviation metrics', 'Alerting', 'Aviation ontology', 'Object types'];
const CHECK_NOTES = {
  'tail_number resolves in processed/aircraft': 'Some carriers report fleet numbers instead of registered tail numbers. Their flights count everywhere but carry no Aircraft link.',
  'reported distance within 2% of great-circle': 'EWR to LGA is a 17-mile hop, where rounding to whole miles exceeds 2%.',
};
function lineageNodes() {
  if (D.nodes) return D.nodes;
  const nodes = D.core.lineage.map(d => ({ ...d, short: d.name.split('/')[1] }));
  for (const ot of D.core.ontology.objectTypes) {
    nodes.push({ name: 'object/' + ot.id, short: ot.name, layer: 'object', group: 'Object types', inputs: [ot.backing], rows: ot.objects,
      description: ot.description, objectType: ot, checks: [], health: 'pass', columns: [] });
  }
  const by = new Map(nodes.map(n => [n.name, n]));
  for (const n of nodes) n.outputs = [];
  for (const n of nodes) for (const i of n.inputs) by.get(i).outputs.push(n.name);
  D.nodes = nodes; D.byId.node = by;
  return nodes;
}
function closure(start, dir) {
  const seen = new Set(), todo = [start];
  while (todo.length) for (const nxt of D.byId.node.get(todo.pop())[dir]) if (!seen.has(nxt)) { seen.add(nxt); todo.push(nxt); }
  return seen;
}

function drawLineage() {
  const nodes = lineageNodes(), NW = 150, NH = 24, GX = 44, GY = 7, TOP = 30;
  const cols = LAYERS.map(([id]) => nodes.filter(n => n.layer === id));
  const tall = Math.max(...cols.map(c => c.length)) * (NH + GY);
  const place = () => cols.forEach((col, ci) => col.forEach((n, i) => {
    n.x = 8 + ci * (NW + GX); n.y = TOP + (tall - col.length * (NH + GY)) / 2 + i * (NH + GY);
  }));
  const mean = names => names.reduce((a, name) => a + D.byId.node.get(name).y, 0) / (names.length || 1);
  place();
  for (let sweep = 0; sweep < 4; sweep++) {
    const fwd = sweep % 2 === 0;
    for (const col of fwd ? cols.slice(1) : cols.slice(0, -1).reverse()) {
      col.sort((a, b) => { const ka = fwd ? a.inputs : a.outputs, kb = fwd ? b.inputs : b.outputs; return (ka.length ? mean(ka) : a.y) - (kb.length ? mean(kb) : b.y); });
      place();
    }
  }
  const W = 16 + cols.length * (NW + GX) - GX, H = TOP + tall + 8;
  const up = PL.sel ? closure(PL.sel, 'inputs') : new Set(), down = PL.sel ? closure(PL.sel, 'outputs') : new Set();
  const lit = name => name === PL.sel || up.has(name) || down.has(name);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': 'Data lineage from raw source files, through cleaning, enrichment and metrics, to ontology tables and object types' });
  LAYERS.forEach(([, label], ci) => svg.append(s('text', { x: 8 + ci * (NW + GX), y: 16, style: 'font-weight:650;fill:var(--ink-2);font-size:12px' }, label)));
  const edges = s('g');
  for (const n of nodes) for (const i of n.inputs) {
    const a = D.byId.node.get(i), x1 = a.x + NW, y1 = a.y + NH / 2, x2 = n.x, y2 = n.y + NH / 2, dx = Math.max(18, (x2 - x1) / 2);
    const on = PL.sel && lit(i) && lit(n.name) && (n.name === PL.sel || i === PL.sel || (up.has(n.name) && up.has(i)) || (down.has(n.name) && down.has(i)));
    edges.append(s('path', { class: 'edge' + (on ? ' on' : PL.sel ? ' dim' : ''), d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}` }));
  }
  svg.append(edges);
  for (const n of nodes) {
    const g = s('g', { class: 'node' + (n.name === PL.sel ? ' sel' : PL.sel && !lit(n.name) ? ' dim' : ''), tabindex: 0, role: 'button',
      'aria-label': `${n.name}, ${F.int(n.rows)} rows` });
    const label = n.short.length > 21 ? n.short.slice(0, 20) + '…' : n.short;
    g.append(s('rect', { x: n.x, y: n.y, width: NW, height: NH, rx: 3 }),
      s('rect', { x: n.x, y: n.y, width: 5, height: NH, rx: 2, style: `fill:${PAL.series[GROUPS.indexOf(n.group)]};stroke:none` }),
      s('text', { x: n.x + 11, y: n.y + 16 }, label));
    if (n.health !== 'pass') g.append(s('path', { d: `M${n.x + NW - 13} ${n.y + 6}l6 11h-12z`, fill: n.health === 'fail' ? 'var(--critical)' : 'var(--warning)' }));
    const pick = () => { PL.sel = n.name; VIEW.pipeline.redraw(); openObj('dataset', n.name, true); };
    g.addEventListener('click', pick); g.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
    tipOn(g, () => tipRows(n.name, [['rows', F.int(n.rows)], ...(n.health !== 'pass' ? [['', 'has a warning']] : [])]));
    svg.append(g);
  }
  return svg;
}

function drawOntology() {
  const P = { airline: [20, 20], airport: [560, 20], aircraft: [20, 140], flight: [290, 140], route: [560, 140], delay: [20, 260], origin_day: [290, 260], route_alert: [560, 260] };
  const NW = 124, NH = 34, ont = D.core.ontology, name = id => ont.objectTypes.find(o => o.id === id);
  const svg = s('svg', { viewBox: '0 0 704 314', width: 704, height: 314, role: 'img', 'aria-label': 'Object types and the links between them' },
    s('defs', null, s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      s('path', { d: 'M0 0L10 5L0 10z', fill: 'currentColor' }))));
  const pairs = new Map();
  for (const l of ont.linkTypes) { const key = l.from + '>' + l.to; pairs.set(key, [...(pairs.get(key) || []), l.name]); }
  const edge = (a, b) => {   // clip the centre line to both boxes
    const [ax, ay] = [P[a][0] + NW / 2, P[a][1] + NH / 2], [bx, by] = [P[b][0] + NW / 2, P[b][1] + NH / 2], dx = bx - ax, dy = by - ay;
    const t = Math.min(dx ? (NW / 2 + 2) / Math.abs(dx) : Infinity, dy ? (NH / 2 + 2) / Math.abs(dy) : Infinity);
    return [ax + dx * t, ay + dy * t, bx - dx * t, by - dy * t];
  };
  for (const [key, names] of pairs) {
    const [a, b] = key.split('>'), [x1, y1, x2, y2] = edge(a, b), t = key === 'origin_day>airport' ? 0.3 : 0.5, mx = x1 + (x2 - x1) * t, my = y1 + (y2 - y1) * t;
    svg.append(s('line', { x1, y1, x2, y2, stroke: 'currentColor', 'stroke-width': 1, 'marker-end': 'url(#arr)', style: 'color:var(--ink-3)' }),
      s('text', { x: mx, y: my + 3, 'text-anchor': 'middle', style: 'font-size:10.5px;fill:var(--ink-2);paint-order:stroke;stroke:var(--surface);stroke-width:4px' }, names.join(', ')));
  }
  for (const [id, [x, y]] of Object.entries(P)) {
    const ot = name(id), g = s('g', { class: 'node', tabindex: 0, role: 'button', 'aria-label': `${ot.name}, ${F.int(ot.objects)} objects` });
    g.append(s('rect', { x, y, width: NW, height: NH, rx: 3 }), s('text', { x: x + 10, y: y + 15 }, ot.name),
      s('text', { x: x + 10, y: y + 28, style: 'font-weight:400;fill:var(--ink-3);font-size:10.5px' }, F.int(ot.objects)));
    const pick = () => openObj('dataset', 'object/' + id, true);
    g.addEventListener('click', pick); g.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
    svg.append(g);
  }
  return svg;
}

VIEW.pipeline = {
  render(root) {
    const nodes = lineageNodes(), meta = D.core.meta, lin = h('div', { class: 'lin-wrap scroll-x' });
    const warned = nodes.filter(n => n.health !== 'pass');
    this.redraw = () => lin.replaceChildren(drawLineage());
    this.onSelect = () => { if (!S.stack.length && PL.sel) { PL.sel = null; this.redraw(); } };
    put(root, viewHead('Pipeline', `${D.core.lineage.length} datasets carry ${F.int(meta.kpis.flights)} raw flight records to eight object types in ${meta.pipeline_seconds} seconds. The graph is exported from the pipeline run itself: a transform that reads a table it did not declare stops the build.`),
      tiles([[String(D.core.lineage.length), 'datasets'], [String(meta.checks.pass + meta.checks.warn + meta.checks.fail), 'health checks'], [String(meta.checks.pass), 'passing'],
        [String(meta.checks.warn), 'warnings', `${meta.checks.fail} failing`]]),
      h('figure', { class: 'fig' }, h('div', { class: 'fig-head' }, h('div', null, h('h2', { text: 'Lineage' }), h('p', { text: 'Select a dataset to trace everything upstream and downstream of it and to see its schema and checks.' })),
        h('button', { class: 'linkish', type: 'button', style: { fontSize: '12px' }, onclick: () => { PL.sel = null; this.redraw(); } }, 'Clear trace')),
        h('div', { class: 'legend' }, GROUPS.map((g, i) => h('span', null, h('i', { class: 'box', style: { background: PAL.series[i] } }), g))),
        lin, h('figcaption', { text: 'Left to right: source files as delivered, typed and repaired, derived fields, the wide join, the delay and metric tables, alert detection, and the tables that back each object type. A triangle marks a dataset with a warning.' })),
      h('section', { class: 'sect' }, h('h2', { text: `Warnings (${warned.length})` }), warned.length ? warned.map(n => n.checks.filter(c => c.status !== 'pass').map(c =>
        h('div', { class: 'banner' }, link('dataset', n.name, n.name), `: ${c.name}. Observed ${c.observed}; expected ${c.expected}. `, CHECK_NOTES[c.name] || ''))) : h('p', { class: 'note', text: 'Every check passes.' })),
      h('section', { class: 'sect' }, h('h2', { text: 'Ontology' }),
        h('p', { class: 'lede', text: 'Object types are the nouns of the app. Arrows are link types, read from the tail to the head.' }),
        h('figure', { class: 'fig' }, h('div', { class: 'lin-wrap scroll-x' }, drawOntology()),
          h('figcaption', { text: 'Flight is the hub: it resolves to an airline, an aircraft, two airports, a route and the origin airport\'s day. Route Alert attaches to a route and to the day that gives it context.' })),
        simpleTable([{ label: 'From', render: l => D.core.ontology.objectTypes.find(o => o.id === l.from).name }, { key: 'name', label: 'Link' },
          { label: 'To', render: l => D.core.ontology.objectTypes.find(o => o.id === l.to).name }, { key: 'cardinality', label: 'Cardinality' }, { key: 'via', label: 'Through' }], D.core.ontology.linkTypes)),
      h('section', { class: 'sect' }, h('h2', { text: 'Source' }), h('p', { class: 'lede', text: meta.source }),
        h('p', { class: 'note', text: `Built ${meta.generated.slice(0, 10)}. An independent open-source build in Python and DuckDB; no proprietary platform is involved.` })));
    this.redraw();
  },
};

DETAIL.dataset = {
  kind: 'Dataset', get: id => { lineageNodes(); return D.byId.node.get(id); },
  render(n) {
    const names = list => (list.length ? h('div', { class: 'row' }, list.map(x => link('dataset', x, x))) : '–');
    const ot = n.objectType, act = ot && D.core.ontology.actions[ot.id];
    const links = ot ? D.core.ontology.linkTypes.filter(l => l.from === ot.id || l.to === ot.id) : [];
    const tname = id => D.core.ontology.objectTypes.find(o => o.id === id).name;
    return [h('div', { class: 'fig' }, h('h1', { text: ot ? ot.name : n.name }), h('p', { text: n.description })),
      kv([[ot ? 'Objects' : 'Rows', F.int(n.rows)], ['Group', n.group], !ot && ['Layer', LAYERS.find(l => l[0] === n.layer)[1]],
        !ot && ['Size on disk', `${F.int(n.bytes / 1024)} KB`], !ot && ['Build time', `${n.seconds} s`], n.pk?.length && ['Primary key', n.pk.join(', ')],
        ot && ['Primary key', ot.pk], ot && ['Title property', ot.title], n.source && ['Provenance', n.source]]),
      h('section', { class: 'sect' }, h('h2', { text: ot ? 'Backed by' : 'Reads from' }), names(n.inputs), !ot && h('h2', { text: 'Feeds' }), !ot && names(n.outputs)),
      ot && h('section', { class: 'sect' }, h('h2', { text: 'Links' }), simpleTable([{ label: 'From', render: l => tname(l.from) }, { key: 'name', label: 'Link' },
        { label: 'To', render: l => tname(l.to) }, { key: 'cardinality', label: 'Cardinality' }], links)),
      act && h('section', { class: 'sect' }, h('h2', { text: 'Action: change status' }),
        simpleTable([{ label: 'From', render: r => STATUS_LABEL[r[0]] }, { label: 'Allowed next', wrap: true, render: r => r[1].map(x => STATUS_LABEL[x]).join(', ') }], Object.entries(act.transitions))),
      n.checks.length ? h('section', { class: 'sect' }, h('h2', { text: `Health checks (${n.checks.length})` }),
        simpleTable([{ label: 'Result', render: c => ({ pass: 'Pass', warn: 'Warning', fail: 'Fail' })[c.status] }, { key: 'name', label: 'Check', wrap: true }, { key: 'observed', label: 'Observed', wrap: true }], n.checks)) : null,
      n.columns.length ? h('section', { class: 'sect' }, h('h2', { text: `Schema (${n.columns.length} columns)` }),
        simpleTable([{ key: 'name', label: 'Column' }, { key: 'type', label: 'Type' }], n.columns)) : null];
  },
};
