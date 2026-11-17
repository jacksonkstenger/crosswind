// ---------- ask the data: Claude plans, the page computes ----------
const ASK = { sample: null, tools: false, tier: 'quick', turns: [], log: [], busy: false, ctl: null };
const monthOf = iso => +iso.slice(5, 7);
const TABLES = {
  airlines: { about: 'one row per airline', rows: () => D.airlines.map(a => ({ id: a.id, name: a.name, type: a.type, flights: a.flights, routes: a.routes, cancelled: a.cancelled,
    cancel_rate: a.cancel_rate, on_time: a.on_time, mean_dep: a.mean_dep, mean_arr: a.mean_arr, median_arr: a.median_arr, registry_aircraft: a.registry_aircraft })) },
  airports: { about: 'one row per airport; origin=true for EWR, JFK, LGA', rows: () => D.airports.map(a => ({ id: a.id, name: a.name, origin: a.origin, flights: a.flights,
    airlines: a.carriers, on_time: a.on_time, mean_delay: a.mean_delay, cancel_rate: a.cancel_rate, miles_from_nyc: a.miles, time_zone: a.tz })) },
  routes: { about: 'one row per origin-destination pair, full-year figures', rows: () => D.routes.map(r => ({ id: r.id, origin: r.o, dest: r.d, dest_name: r.dest_name, flights: r.flights,
    cancelled: r.cancelled, arrived: r.arrived, cancel_rate: r.cancel_rate, on_time: r.on_time, mean_dep: r.mean_dep, mean_arr: r.mean_arr, median_arr: r.median_arr,
    p90_arr: r.p90_arr, distance_mi: r.dist, air_time_min: r.air_time, air_recovery_min: r.recovery, airlines: r.carriers.length, alerts: r.alerts })) },
  route_airlines: { about: 'one row per airline on a route', rows: () => D.routes.flatMap(r => r.carriers.map(c => ({ route: r.id, origin: r.o, dest: r.d, airline: c.id,
    flights: c.flights, on_time: c.on_time, mean_arr: c.mean_arr, cancel_rate: c.cancel_rate }))) },
  origin_days: { about: 'one row per New York airport per day, operations plus weather', rows: () => D.origin_days.map(o => ({ airport: o.a, date: o.date, month: monthOf(o.date),
    flights: o.flights, cancelled: o.cancelled, cancel_rate: o.cancel_rate, mean_dep: o.mean_dep, late_share: o.late_share, temp_min_f: o.tmin, temp_max_f: o.tmax,
    precip_in: o.precip, visibility_min_mi: o.vis, wind_max_mph: o.wind, gust_max_mph: o.gust, adverse_hours: o.adverse_hours, disruption_z: o.z, disrupted: o.disrupted })) },
  alerts: { about: 'one row per route alert; type is delay_spike, cancellation_cluster or chronic_lateness', rows: () => D.alerts.map(a => ({ id: a.id, type: a.type, severity: a.sev,
    route: a.route, origin: a.o, dest: a.d, date: a.date, month: monthOf(a.date), flights: a.n, observed: a.observed, expected: a.expected, statistic: a.stat,
    status: Triage.get(a.id).status, origin_disrupted: a.origin_disrupted })) },
  route_days: { about: 'one row per route per day with flights (about 64,000 rows); mean_dep in minutes', lazy: 'route_daily', rows: () => {
    const out = [];
    for (const r of D.route_daily) { const [o, d] = r.id.split('-'); for (let i = 0; i < 365; i++) if (r.n[i]) out.push({ route: r.id, origin: o, dest: d, date: idxDate(i),
      month: monthOf(idxDate(i)), flights: r.n[i], cancelled: r.c[i], mean_dep: r.dep[i], arrived: r.arr[i], arrived_late: r.late[i] }); }
    return out; } },
  aircraft: { about: 'one row per registered aircraft that flew', lazy: 'aircraft', rows: () => D.aircraft.map(a => ({ ...a })) },
  fleet: { about: 'one row per airline and aircraft model', rows: () => D.core.fleet.map(f => ({ ...f })) },
  hourly: { about: 'one row per origin and scheduled departure hour', rows: () => D.core.stats.hourly.map(r => ({ ...r })) },
  weather_bins: { about: 'departure delay by weather at the origin in the scheduled hour; dimension is Visibility, Wind speed, Precipitation or Temperature',
    rows: () => D.core.stats.weather.map(({ bin_order, ...r }) => r) },
  airline_months: { about: 'one row per airline and month', rows: () => D.airlines.flatMap(a => a.monthly.map(m => ({ airline: a.id, ...m }))) },
  distance_bands: { about: 'one row per 250-mile distance band', rows: () => D.core.stats.distance.map(({ g, ...r }) => r) },
};
const tableCache = {};
async function tableRows(name) {
  const t = TABLES[name];
  if (!t) throw new Error(`Unknown table "${name}". Tables: ${Object.keys(TABLES).join(', ')}`);
  if (!tableCache[name] || name === 'alerts') { if (t.lazy) await need(t.lazy); tableCache[name] = t.rows(); }
  return tableCache[name];
}
const OPS = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a), contains: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()) };
const AGG = {
  count: rows => rows.length,
  sum: (rows, c) => rows.reduce((n, r) => n + (r[c] ?? 0), 0),
  avg: (rows, c) => { const v = rows.map(r => r[c]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; },
  min: (rows, c) => rows.reduce((m, r) => (r[c] != null && (m == null || r[c] < m) ? r[c] : m), null),
  max: (rows, c) => rows.reduce((m, r) => (r[c] != null && (m == null || r[c] > m) ? r[c] : m), null),
  wavg: (rows, c, w) => { let num = 0, den = 0; for (const r of rows) if (r[c] != null && r[w] != null) { num += r[c] * r[w]; den += r[w]; } return den ? num / den : null; },
};
const tidy = v => (typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(5) : v);
async function runQuery(spec) {
  let rows = await tableRows(String(spec.table));
  const cols = Object.keys(rows[0] || {}), must = c => { if (!cols.includes(c)) throw new Error(`No column "${c}" in ${spec.table}. Columns: ${cols.join(', ')}`); return c; };
  for (const f of spec.where || []) {
    const op = OPS[f.op || '=']; if (!op) throw new Error(`Unknown operator "${f.op}". Use ${Object.keys(OPS).join(' ')}`);
    const c = must(String(f.col)); rows = rows.filter(r => op(r[c], f.value));
  }
  const matched = rows.length;
  let out;
  if (spec.aggregates?.length) {
    const keys = (spec.group_by || []).map(c => must(String(c))), groups = new Map();
    for (const r of rows) { const k = keys.map(c => r[c]).join('\u0001'); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    if (!keys.length && !groups.size) groups.set('', []);
    out = [...groups.values()].map(g => {
      const o = Object.fromEntries(keys.map(c => [c, g[0]?.[c]]));
      for (const a of spec.aggregates) {
        const fn = AGG[a.fn]; if (!fn) throw new Error(`Unknown aggregate "${a.fn}". Use ${Object.keys(AGG).join(', ')}`);
        if (a.fn !== 'count') must(String(a.col)); if (a.fn === 'wavg') must(String(a.weight));
        o[a.as || (a.fn === 'count' ? 'count' : `${a.fn}_${a.col}`)] = fn(g, a.col, a.weight);
      }
      return o;
    });
  } else {
    const pick = spec.columns?.length ? spec.columns.map(c => must(String(c))) : cols;
    out = rows.map(r => Object.fromEntries(pick.map(c => [c, r[c]])));
  }
  for (const o of [...(spec.order_by || [])].reverse()) {
    const dir = o.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => (a[o.col] == null ? 1 : b[o.col] == null ? -1 : typeof a[o.col] === 'string' ? a[o.col].localeCompare(b[o.col]) * dir : (a[o.col] - b[o.col]) * dir));
  }
  const limit = Math.max(1, Math.min(50, Number(spec.limit) || 20)), columns = Object.keys(out[0] || {});
  return { columns, rows: out.slice(0, limit).map(r => columns.map(c => tidy(r[c]))), rows_matched: matched, rows_returned: Math.min(limit, out.length), groups_total: out.length };
}
function schemaText() {
  return Object.entries(TABLES).map(([name, t]) => {
    const sample = name === 'route_days' ? { route: 0, origin: 0, dest: 0, date: 0, month: 0, flights: 0, cancelled: 0, mean_dep: 0, arrived: 0, arrived_late: 0 }
      : name === 'aircraft' ? { id: 0, airline: 0, maker: 0, model: 0, year: 0, seats: 0, engines: 0, flights: 0, routes: 0, mean_arr: 0, miles: 0 } : t.rows()[0];
    return `- ${name} (${t.about}): ${Object.keys(sample).join(', ')}`;
  }).join('\n');
}
const askRules = () => `You answer questions about flights that departed New York's three airports (EWR Newark, JFK Kennedy, LGA LaGuardia) in 2013: ${F.int(D.core.meta.kpis.flights)} flights, from US Bureau of Transportation Statistics on-time data joined to hourly airport weather.
${ASK.tools ? 'Use the query tool to compute every figure you state. Never state a number that did not come from a tool result. Plan first, then make as few calls as you can.' : 'Answer only from the tables given below. If they cannot answer the question, say what is missing.'}
Conventions: on_time, cancel_rate and late_share are fractions from 0 to 1 (on time means arriving under 15 minutes late). Delays are minutes; negative is early. Dates are ISO strings, month is 1 to 12. To combine a rate across rows, use wavg weighted by flights (by arrived for on_time). Airline ids are two-letter codes; join names from the airlines table.
Tables and columns:
${schemaText()}
Reply in plain text: two to five short sentences, or a short dash list for rankings. No headings, no tables. Give numbers with units, and name the table or filter when it matters.`;
const QUERY_TOOL = {
  name: 'query',
  description: 'Run one filter/group/aggregate query over a table in the page and return up to 50 rows as {columns, rows, rows_matched, groups_total}. Use it for every number. Errors name the valid tables, columns or operators.',
  inputSchema: { type: 'object', required: ['table'], properties: {
    table: { type: 'string' },
    where: { type: 'array', items: { type: 'object', required: ['col', 'value'], properties: { col: { type: 'string' }, op: { type: 'string', enum: Object.keys(OPS) }, value: {} } } },
    group_by: { type: 'array', items: { type: 'string' } },
    aggregates: { type: 'array', items: { type: 'object', required: ['fn'], properties: { fn: { type: 'string', enum: Object.keys(AGG) }, col: { type: 'string' }, weight: { type: 'string' }, as: { type: 'string' } } } },
    columns: { type: 'array', items: { type: 'string' } },
    order_by: { type: 'array', items: { type: 'object', required: ['col'], properties: { col: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } } },
    limit: { type: 'number' } } },
};
function richText(text) {
  const out = [], bold = line => line.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? h('b', { text: part }) : part));
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim(), m = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) { list = null; continue; }
    if (m) { if (!list) out.push(list = h('ul')); list.append(h('li', null, bold(m[1]))); }
    else { list = null; out.push(h('p', null, bold(line))); }
  }
  return out;
}
const ASK_ERRORS = { rate_limited: 'Claude is rate limited right now. Try again in a little while.', session_expired: 'Sign in to Claude again, then retry.',
  refused: 'Claude declined that question. Try asking it another way.', empty_completion: 'No answer came back. Try a simpler question.', prompt_too_large: 'That conversation got too long. Start a new one.' };
const ASK_GONE = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];

VIEW.ask = {
  render(root) {
    const chat = h('div', { class: 'chat' });
    const box = h('textarea', { class: 'field', id: 'ask-box', rows: 2, placeholder: 'Ask about airlines, routes, days, weather or alerts', maxlength: 600 });
    const send = h('button', { class: 'btn primary', type: 'button' }, 'Ask'), stop = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => ASK.ctl?.abort() }, 'Stop');
    const draw = () => {
      chat.replaceChildren(...ASK.log.map(m => m.role === 'q' ? h('div', { class: 'msg q', text: m.text })
        : h('div', { class: 'msg a' }, m.text ? richText(m.text) : h('p', { class: 'muted', text: 'Thinking…' }),
          m.error && h('p', { class: 'banner', text: m.error }),
          m.steps.length ? h('details', { class: 'q' }, h('summary', { text: `${m.steps.length} ${m.steps.length === 1 ? 'query' : 'queries'} run on this page` }),
            m.steps.map(st => h('pre', { text: JSON.stringify(st.spec) + '\n→ ' + (st.error || `${st.result.rows_returned} of ${st.result.groups_total} rows\n${st.result.columns.join(' | ')}\n${st.result.rows.slice(0, 12).map(r => r.join(' | ')).join('\n')}`) }))) : null)));
      send.disabled = ASK.busy; stop.hidden = !ASK.busy;
    };
    const ask = async text => {
      text = text.trim(); if (!text || ASK.busy || !ASK.sample) return;
      const m = { role: 'a', text: '', steps: [] };
      ASK.log.push({ role: 'q', text }, m); ASK.turns.push({ role: 'user', content: text }); ASK.busy = true; ASK.ctl = new AbortController(); box.value = ''; draw();
      const tool = { ...QUERY_TOOL, execute: async input => {
        const step = { spec: input }; m.steps.push(step);
        try { step.result = await runQuery(input); return step.result; } catch (err) { step.error = err.message; throw err; } finally { draw(); }
      } };
      try {
        const res = await ASK.sample([{ role: 'user', content: askRules() + (ASK.tools ? '' : '\n\nData:\n' + (await fallbackData())) }, ...ASK.turns.slice(-8)],
          { modelTier: ASK.tier, signal: ASK.ctl.signal, onText: ({ text: t }) => { m.text = t; draw(); }, ...(ASK.tools ? { tools: [tool] } : { cache: false }) });
        m.text = res.text; ASK.turns.push({ role: 'assistant', content: res.text });
        if (res.truncated) m.error = 'The answer was cut short. Ask for less at a time.';
      } catch (err) {
        ASK.turns.pop(); m.text = err.code === 'refused' ? '' : (err.text || m.text);
        if (ASK_GONE.includes(err.code)) { S.askReady = false; ASK.sample = null; m.error = 'Asking Claude is not available in this view.'; renderNav(); }
        else if (err.code !== 'cancelled') m.error = ASK_ERRORS[err.code] || 'Claude could not be reached. Try again.';
        if (!m.text && !m.error) m.text = 'Stopped.';
      } finally { ASK.busy = false; draw(); }
    };
    send.addEventListener('click', () => ask(box.value));
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(box.value); } });
    put(root, viewHead('Ask the data', 'Claude plans the question and this page runs the queries over its own tables, so every figure in an answer comes from a computation you can open and check. Answers use your Claude account.'),
      !ASK.log.length && h('div', { class: 'row' }, ['Which airline was most punctual out of JFK, and which least?', 'What were the five worst days at Newark, and what was the weather?',
        'How much do delays grow when visibility drops below one mile?', 'Which routes drew the most alerts, and of what kind?'].map(q => h('button', { class: 'chip', type: 'button', onclick: () => ask(q) }, q))),
      chat, h('div', { class: 'fig', style: { maxWidth: '760px' } }, box,
        h('div', { class: 'row' }, send, stop, seg([['quick', 'Fast'], ['default', 'Thorough']], ASK.tier, v => { ASK.tier = v; renderAll(); }, 'Answer depth'),
          ASK.log.length ? h('button', { class: 'linkish', type: 'button', onclick: () => { ASK.log = []; ASK.turns = []; renderAll(); } }, 'New conversation') : null),
        h('p', { class: 'note', text: ASK.tools ? 'Thorough thinks longer before each query and can take a minute.' : 'This view cannot run page queries, so answers draw on summary tables only.' })));
    draw();
  },
};
async function fallbackData() {
  const csv = async (name, limit) => { const r = await runQuery({ table: name, limit }); return `${name}\n${r.columns.join(',')}\n${r.rows.map(x => x.join(',')).join('\n')}`; };
  return (await Promise.all([csv('airlines', 50), csv('hourly', 50), csv('weather_bins', 50), csv('distance_bands', 50),
    runQuery({ table: 'routes', order_by: [{ col: 'flights', dir: 'desc' }], limit: 50 }).then(r => `routes (50 busiest)\n${r.columns.join(',')}\n${r.rows.map(x => x.join(',')).join('\n')}`)])).join('\n\n');
}
function initAsk() {
  if (!window.claude || !window.claude.use) return;
  window.claude.use('sample').then(async sample => {
    if (!sample) return;
    const caps = await sample.limits().catch(() => null);
    ASK.sample = sample; ASK.tools = !!(caps && caps.tools); S.askReady = true; renderNav();
  }).catch(() => {});
}
