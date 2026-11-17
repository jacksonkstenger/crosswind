// ---------- triage store: shared through the page's database when available, else this browser ----------
const Triage = {
  map: new Map(), mode: 'local', me: null, db: null, user: null, names: {}, queue: {}, onChange: null, stale: false,
  get(id) { return this.map.get(id) || { status: 'open', assignee: '', history: [] }; },
  emit() { VIEW.inbox.refresh?.(); this.onChange?.(); },
  apply(id, patch, entry) {
    if (this.mode === 'readonly') return;
    const cur = this.get(id), now = new Date().toISOString();
    const next = { status: cur.status, assignee: cur.assignee || '', ...patch, updated: now,
      history: [...(cur.history || []), ...(entry ? [{ at: now, by: this.me || 'local', ...entry }] : [])].slice(-40) };
    this.map.set(id, next); this.emit();
    if (this.mode === 'shared') {
      this.queue[id] = (this.queue[id] || Promise.resolve()).then(() => this.db.doc('triage/' + id).set(next)).catch(err => {
        if (err && err.code === 'invalid_argument') this.mode = 'readonly';
        this.error = 'That change was not saved. ' + (this.mode === 'readonly' ? 'You have view-only access.' : 'Try again in a moment.');
        this.emit();
      });
    } else {
      try { localStorage.setItem('crosswind.triage', JSON.stringify(Object.fromEntries(this.map))); } catch (e) { /* storage unavailable */ }
    }
  },
  who(id) { return id === 'local' || (this.me && id === this.me) ? 'you' : (this.names[id] || 'a collaborator'); },
  describe() {
    return { shared: 'Triage is saved with this page and shared with everyone who can open it.',
      readonly: 'You can read triage here. Changing it needs contributor access.',
      local: 'Triage is saved in this browser only.' }[this.mode] + (this.stale ? ' Saved triage has not loaded yet, so this may be out of date.' : '');
  },
  init() {
    try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem('crosswind.triage') || '{}'))) this.map.set(k, v); } catch (e) { /* none */ }
    if (!window.claude || !window.claude.use) return;
    Promise.all([window.claude.use('db'), window.claude.use('user')]).then(async ([db, user]) => {
      if (!db) return;
      this.db = db; this.user = user;
      let canWrite = null;
      try { this.me = user ? await user.id() : null; canWrite = user ? await user.can('data.write') : null; } catch (e) { /* not told */ }
      this.mode = canWrite === false ? 'readonly' : 'shared';
      const timer = setTimeout(() => { this.stale = true; this.emit(); }, 10000);
      db.collection('triage').onSnapshot(snap => {
        if (!snap.metadata.fromCache) { clearTimeout(timer); this.stale = false; }
        this.map = new Map(snap.docs.map(d => [d.id, d.data()]));
        const ids = [...new Set(snap.docs.flatMap(d => (d.data().history || []).map(e => e.by)))].filter(i => i && i !== 'local' && !this.names[i]);
        if (ids.length && user && user.profiles) {
          Promise.resolve(user.profiles(ids)).then(ps => { for (const i of ids) this.names[i] = (ps && ps[i] && ps[i].name) || 'a collaborator'; this.emit(); }).catch(() => {});
        }
        this.emit();
      }, () => { clearTimeout(timer); this.mode = 'local'; this.emit(); });
    }).catch(() => {});
  },
};

// ---------- inbox ----------
const IN = { status: 'open', sev: new Set(), type: new Set(), origin: new Set(), q: '', sort: 'date', open: false };
const STATUS_GROUP = { open: ['open'], active: ['acknowledged', 'investigating'], closed: ['resolved', 'dismissed'] };
const SEV_RANK = { critical: 0, high: 1, medium: 2 };
const alertWhen = a => a.type === 'chronic_lateness' ? `week of ${F.date(a.date)}` : F.date(a.date);
function alertStat(a) {
  if (a.type === 'delay_spike') return [`${Math.round(a.observed)} min`, 'mean departure delay'];
  if (a.type === 'cancellation_cluster') return [`${Math.round(a.observed * a.n)} of ${a.n}`, 'flights cancelled'];
  return [F.pct(a.observed), 'arrived 15+ min late'];
}
const BASE_FMT = { delay_spike: v => `${Math.round(v)} min`, cancellation_cluster: v => F.pct(v, 1), chronic_lateness: v => F.pct(v) };
const BASE_NAME = { delay_spike: 'Mean departure delay', cancellation_cluster: 'Share of flights cancelled', chronic_lateness: 'Share of arrivals 15+ min late' };
function baselineBlock(a) {
  const f = BASE_FMT[a.type], unit = a.type === 'chronic_lateness' ? 'week' : 'day', month = MONTHS[+a.date.slice(5, 7) - 1];
  const rows = [[`This ${unit}`, a.observed, true], [`This route in ${month}`, a.b_month], ['This route, all of 2013', a.b_route],
    [`All ${a.o} departures, 2013`, a.b_origin], ['All flights, 2013', a.b_all]].filter(r => r[1] != null);
  const times = a.b_route > 0 ? a.observed / a.b_route : null;
  return h('section', { class: 'sect' }, h('h2', { text: 'Baseline' }),
    h('p', { class: 'note', text: `${BASE_NAME[a.type]}.${times ? ` This ${unit} ran at ${F.num(times, 1)} times the route's rate for the year.` : ''}` }),
    hbars(rows.map(([label, v, hi]) => ({ label, value: Math.max(0, v), text: f(v), color: hi ? PAL.series[0] : PAL.quiet }))),
    h('p', { class: 'note', text: `How often this detector fires: on ${F.int(a.fired)} of ${F.int(a.elig)} route-${unit}s it examined in 2013 (${F.pct(a.fired / a.elig, 2)}), and on ${a.fired_r} of ${F.int(a.elig_r)} for this route.` }));
}
function toggleSet(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

VIEW.inbox = {
  render(root) {
    const controls = h('div', { class: 'fig' }), bay = h('div', { class: 'bay' }), count = h('p', { class: 'note' });
    const search = h('input', { class: 'field', id: 'alert-search', type: 'search', placeholder: 'Filter by airport code or name', value: IN.q,
      'aria-label': 'Filter alerts', style: { maxWidth: '280px' }, oninput: e => { IN.q = e.target.value.trim().toLowerCase(); drawList(); } });
    const passes = (a, skip) => (skip === 'status' || IN.status === 'all' || STATUS_GROUP[IN.status].includes(Triage.get(a.id).status))
      && (skip === 'sev' || !IN.sev.size || IN.sev.has(a.sev)) && (skip === 'type' || !IN.type.size || IN.type.has(a.type))
      && (skip === 'origin' || !IN.origin.size || IN.origin.has(a.o))
      && (!IN.q || `${a.o} ${a.d} ${D.byId.airport.get(a.d)?.name || ''} ${a.route}`.toLowerCase().includes(IN.q));
    const chips = (set, key, options) => options.map(([v, label]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(set.has(v)), onclick: () => { toggleSet(set, v); draw(); } },
        label, h('span', { class: 'n', text: D.alerts.filter(a => passes(a, key) && a[key === 'origin' ? 'o' : key] === v).length })));
    const drawControls = () => {
      const n = g => D.alerts.filter(a => passes(a, 'status') && (g === 'all' || STATUS_GROUP[g].includes(Triage.get(a.id).status))).length;
      // On a phone the filters fold away so the first alerts sit above the fold.
      const narrow = innerWidth < 620, open = !narrow || IN.open, active = IN.sev.size + IN.type.size + IN.origin.size + (IN.q ? 1 : 0);
      controls.replaceChildren();
      put(controls,
        h('div', { class: 'row' },
          seg([['open', `Open ${n('open')}`], ['active', `In progress ${n('active')}`], ['closed', `Closed ${n('closed')}`], ['all', `All ${n('all')}`]],
            IN.status, v => { IN.status = v; draw(); }, 'Triage status'),
          narrow && h('button', { class: 'chip', type: 'button', 'aria-expanded': String(!!IN.open), onclick: () => { IN.open = !IN.open; draw(); } },
            IN.open ? 'Hide filters' : 'Filter and sort', active ? h('span', { class: 'n', text: `${active} on` }) : null),
          open && seg([['date', 'Newest'], ['sev', 'Most severe']], IN.sort, v => { IN.sort = v; draw(); }, 'Sort')),
        open && h('div', { class: 'row' }, chips(IN.sev, 'sev', [['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium']]),
          chips(IN.type, 'type', Object.entries(TYPE_LABEL)), chips(IN.origin, 'origin', [['EWR', 'EWR'], ['JFK', 'JFK'], ['LGA', 'LGA']])),
        open && search);
    };
    const drawList = () => {
      const rows = D.alerts.filter(a => passes(a)).sort((a, b) =>
        (IN.sort === 'sev' ? SEV_RANK[a.sev] - SEV_RANK[b.sev] : 0) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      count.textContent = `${rows.length} of ${D.alerts.length} alerts. ${Triage.describe()}`;
      const sel = selected('alert');
      bay.replaceChildren(...rows.map(a => {
        const t = Triage.get(a.id), [big, small] = alertStat(a);
        return h('button', { class: 'strip' + (STATUS_GROUP.closed.includes(t.status) ? ' closed' : ''), type: 'button', 'data-v': a.sev, 'data-id': a.id,
          'aria-current': String(a.id === sel), onclick: () => openObj('alert', a.id, true) },
          h('span', { class: 'holder' }),
          h('span', { class: 'cells' },
            h('span', { class: 'route' }, a.o, h('span', { class: 'arr', text: '→' }), a.d),
            h('span', { class: 'what' }, sevMark(a.sev), h('span', { text: TYPE_LABEL[a.type] }), h('span', { class: 'muted', text: alertWhen(a) }),
              t.status !== 'open' && statusPill(t.status), t.assignee && h('span', { class: 'muted', text: t.assignee }))),
          h('span', { class: 'stat' }, h('b', { text: big }), h('span', { text: small }), a.b_route != null && h('span', { text: `usual ${BASE_FMT[a.type](a.b_route)}` })));
      }));
      if (!rows.length) bay.append(h('p', { class: 'muted', text: 'No alerts match these filters. Clear a filter to see more.' }));
    };
    const draw = () => { drawControls(); drawList(); };
    this.refresh = draw;
    this.onSelect = () => { const sel = selected('alert'); for (const el of bay.children) el.setAttribute?.('aria-current', String(el.dataset?.id === sel)); };
    put(root, viewHead('Route alerts', `${D.alerts.length} findings from three detectors over ${F.int(D.core.meta.kpis.flights)} departures from Newark, Kennedy and LaGuardia in 2013.`),
      controls, count, bay);
    draw();
  },
};

// ---------- alert detail ----------
function whyBlock(a) {
  const eq = (...parts) => h('div', { class: 'eq' }, parts);
  const v = t => h('i', { text: t });
  if (a.type === 'delay_spike') {
    const x = a.observed - a.ref;
    return h('div', { class: 'why' },
      kv([[`Mean departure delay, ${a.n} departures`, F.min(a.observed)], [`Rest of ${a.o} that day`, F.min(a.ref)], ['Gap x', F.smin(x)],
        [`Usual gap: median of the prior ${a.base_n} days`, F.smin(a.base_center)], ['Scale: max(1.4826 × MAD, 5)', F.num(a.base_scale) + ' min']]),
      eq(v('z'), ' = (', v('x'), ' − median) / scale = (', F.num(x, 0), ' − ', a.base_center < 0 ? `(${F.num(a.base_center, 0)})` : F.num(a.base_center, 0), ') / ', F.num(a.base_scale), ' = ', h('b', { text: F.num(a.stat) })),
      h('p', { class: 'note', text: 'Fires when z is at least 4, the gap is 30 min or more above its usual level, the route averages 30 min late or worse, and at least 60% of its departures left 15+ min late. Subtracting the rest of the airport removes airport-wide bad days; the median and MAD keep one extreme day from inflating the baseline.' }));
  }
  if (a.type === 'cancellation_cluster') {
    const c = Math.round(a.observed * a.n);
    return h('div', { class: 'why' },
      kv([['Cancelled', `${c} of ${a.n} (${F.pct(a.observed)})`], [`Route's 56-day rate, (C + ½) / (N + 1), N = ${F.int(a.base_n)}`, F.pct(a.base_center, 1)],
        [`Rest of ${a.o} that day`, F.pct(a.ref, 1)], ['Null rate p₀, the larger of the two', F.pct(a.expected, 1)]]),
      eq('P[Bin(', a.n, ', ', v('p'), '₀) ≥ ', c, '] = ', h('b', { text: F.p(a.p) }), ', adjusted ', h('b', { text: F.p(a.stat) })),
      h('p', { class: 'note', text: 'Fires when the Benjamini–Hochberg adjusted p-value is at most 0.05 and at least 2 flights were cancelled. The adjustment runs over every route-day with 3 or more scheduled flights, which holds the expected share of false alerts to 5%.' }));
  }
  const k = Math.round(a.observed * a.n);
  return h('div', { class: 'why' },
    kv([['Arrived 15+ min late', `${k} of ${a.n} (${F.pct(a.observed)})`], ['95% Wilson lower bound', F.pct(a.stat, 1)], ['Weeks in a row', a.streak]]),
    eq('lower = (', v('p̂'), ' + ', v('z'), '²/2', v('n'), ' − ', v('z'), '√(', v('p̂'), '(1 − ', v('p̂'), ')/', v('n'), ' + ', v('z'), '²/4', v('n'), '²)) / (1 + ', v('z'), '²/', v('n'), '), ', v('z'), ' = 1.96'),
    h('p', { class: 'note', text: 'Fires when the lower bound is above 50% with at least 15 arrivals in the week: more than half the flights were late, beyond what a small sample could explain.' }));
}

function alertChart(a) {
  const daily = D.byId.daily?.get(a.route);
  if (!daily) return null;
  const i0 = dayIdx(a.date), hi = PAL.series[0];
  if (a.type === 'chronic_lateness') {
    const weeks = [];
    for (let k = 0; 7 * k - 1 < 365; k++) {
      let arr = 0, late = 0;
      for (let i = Math.max(0, 7 * k - 1); i <= Math.min(364, 7 * k + 5); i++) { arr += daily.arr[i]; late += daily.late[i]; }
      const start = idxDate(Math.max(0, 7 * k - 1)), on = 7 * k - 1 === i0;
      weeks.push({ label: +start.slice(8) <= 7 ? MONTHS[+start.slice(5, 7) - 1] : null, value: arr ? late / arr : null, color: on ? hi : PAL.quiet,
        mark: on ? F.pct(late / arr) : null, date: start, arr, late,
        tip: [`Week of ${F.date(start)}`, [['of arrivals late', arr ? F.pct(late / arr) : '–'], ['arrivals', F.int(arr)]]] });
    }
    return figure({ title: 'Share of arrivals 15+ min late, by week', sub: `${a.o} → ${a.d}, 2013. The flagged week is highlighted.`,
      chart: w => colChart({ width: w, items: weeks, yFmt: v => F.pct(v), ref: { value: 0.5, label: '50%' }, yMax: 1 }),
      table: { cols: [{ key: 'date', label: 'Week starting', fmt: F.date }, { key: 'late', label: 'Late', num: true }, { key: 'arr', label: 'Arrivals', num: true },
        { key: 'value', label: 'Share', num: true, fmt: v => F.pct(v) }], rows: weeks } });
  }
  const spike = a.type === 'delay_spike', items = [];
  for (let i = Math.max(0, i0 - 28); i <= Math.min(364, i0 + 7); i++) {
    const date = idxDate(i), value = spike ? daily.dep[i] : (daily.n[i] ? daily.c[i] : null);
    items.push({ label: (i - i0) % 7 === 0 ? `${+date.slice(8)} ${MONTHS[+date.slice(5, 7) - 1]}` : null, value, date, n: daily.n[i], c: daily.c[i],
      color: i === i0 ? hi : PAL.quiet, mark: i === i0 ? (spike ? `${value} min` : `${value}`) : null,
      tip: [F.date(date), spike ? [['mean departure delay', value == null ? '–' : F.min(value)], ['scheduled', daily.n[i]]]
        : [['cancelled', daily.c[i]], ['scheduled', daily.n[i]]]] });
  }
  return figure({ title: spike ? 'Mean departure delay on this route, by day' : 'Cancelled flights on this route, by day',
    sub: 'Four weeks before the alert and one week after. The alert day is highlighted.',
    chart: w => colChart({ width: w, items, yFmt: spike ? v => `${v}` : F.int }),
    table: { cols: [{ key: 'date', label: 'Day', fmt: F.date }, { key: 'n', label: 'Scheduled', num: true },
      spike ? { key: 'value', label: 'Mean dep. delay (min)', num: true } : { key: 'c', label: 'Cancelled', num: true }], rows: items } });
}

function triagePanel(a) {
  const act = D.core.ontology.actions.route_alert;
  const state = h('div', { class: 'fig' }), log = h('ul', { class: 'log' }), mode = h('p', { class: 'note' });
  const who = h('input', { class: 'field', id: 'triage-assignee', type: 'text', placeholder: 'Name or team', maxlength: 60 });
  const note = h('textarea', { class: 'field', id: 'triage-note', rows: 2, placeholder: 'What you found or decided', maxlength: 500 });
  const draw = () => {
    const t = Triage.get(a.id), ro = Triage.mode === 'readonly';
    if (document.activeElement !== who) who.value = t.assignee || '';
    who.disabled = note.disabled = ro;
    state.replaceChildren(h('div', { class: 'row' }, statusPill(t.status), t.assignee && h('span', { class: 'muted', text: `Assigned to ${t.assignee}` })),
      h('div', { class: 'row' }, act.transitions[t.status].map((to, i) => h('button', { class: 'btn' + (i === 0 ? ' primary' : ''), type: 'button', disabled: ro,
        onclick: () => Triage.apply(a.id, { status: to }, { from: t.status, to }) }, act.labels[to]))),
      Triage.error && h('p', { class: 'banner', text: Triage.error }));
    log.replaceChildren(...[...(t.history || [])].reverse().map(e => {
      const when = new Date(e.at), stamp = `${when.getDate()} ${MONTHS[when.getMonth()]} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      const what = e.to ? `${STATUS_LABEL[e.to]} (was ${STATUS_LABEL[e.from].toLowerCase()})` : e.assignee != null ? (e.assignee ? `Assigned to ${e.assignee}` : 'Unassigned') : `Note: ${e.note}`;
      return h('li', { text: `${stamp}, ${Triage.who(e.by)}. ${what}` });
    }));
    mode.textContent = Triage.describe();
  };
  const saveWho = () => { const v = who.value.trim(); if (v !== (Triage.get(a.id).assignee || '')) Triage.apply(a.id, { assignee: v }, { assignee: v }); };
  who.addEventListener('change', saveWho);
  const add = h('button', { class: 'btn', type: 'button', style: { justifySelf: 'start' }, onclick: () => {
    const v = note.value.trim(); if (!v) return; Triage.apply(a.id, {}, { note: v }); note.value = ''; } }, 'Add note');
  Triage.onChange = () => { if (state.isConnected) draw(); };
  draw();
  return h('section', { class: 'sect' }, h('h2', { text: 'Triage' }), state,
    h('label', { class: 'lab' }, 'Assignee', who), h('label', { class: 'lab' }, 'Note', note), add, log, mode);
}

const FLIGHT_STATUS = { completed: 'Flew', cancelled: 'Cancelled', no_arrival: 'No arrival recorded' };
DETAIL.alert = {
  kind: 'Route alert',
  get: id => need('route_daily').catch(() => null).then(() => D.byId.alert.get(id)),
  render(a) {
    const od = a.origin_day && D.byId.oday.get(a.origin_day), route = D.byId.route.get(a.route);
    return [
      h('div', { class: 'fig' }, h('h1', { text: a.title }),
        h('div', { class: 'row' }, sevMark(a.sev), h('span', { class: 'muted', text: alertWhen(a) }), h('span', { class: 'muted', text: a.id }))),
      h('p', { text: a.summary }),
      h('section', { class: 'sect' }, h('h2', { text: 'Why this fired' }), whyBlock(a)),
      baselineBlock(a),
      h('section', { class: 'sect' }, alertChart(a)),
      h('section', { class: 'sect' }, h('h2', { text: 'Context' }), kv([
        ['Route', link('route', a.route, `${a.o} → ${a.d}`)],
        ['Destination', link('airport', a.d, D.byId.airport.get(a.d)?.name || a.d)],
        route && ['Route on-time arrivals, 2013', F.pct(route.on_time)],
        route && ['Other alerts on this route', String(route.alerts - 1)],
        od && ['Origin day', link('day', od.id, `${a.o}, ${F.date(od.date)}`)],
        od && [`${a.o} that day`, `${F.min(od.mean_dep)} mean delay, ${F.pct(od.cancel_rate)} cancelled`],
        od && ['Airport-wide disruption', od.disrupted ? 'Yes' : 'No'],
        od && ['Lowest visibility', od.vis == null ? '–' : `${od.vis} mi`],
        od && ['Precipitation', od.precip == null ? '–' : `${F.num(od.precip, 2)} in`],
        od && ['Peak gust', od.gust == null ? 'none recorded' : `${Math.round(od.gust)} mph`]])),
      a.flights.length ? h('section', { class: 'sect' }, h('h2', { text: `Flights that day (${a.flights.length})` }),
        simpleTable([{ label: 'Flight', render: r => r[0] }, { label: 'Airline', render: r => link('airline', r[1], r[1]) },
          { label: 'Sched.', render: r => F.hhmm(r[3]) }, { label: 'Outcome', render: r => FLIGHT_STATUS[r[4]] },
          { label: 'Dep. delay', num: true, render: r => r[5] == null ? '–' : F.smin(r[5]) }, { label: 'Arr. delay', num: true, render: r => r[6] == null ? '–' : F.smin(r[6]) },
          { label: 'Tail', render: r => r[2] || '–' }], a.flights)) : null,
      triagePanel(a),
    ];
  },
};
