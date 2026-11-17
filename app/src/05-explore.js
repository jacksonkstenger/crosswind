// ---------- object explorer: one table per object type, every row opens the object ----------
const EX = { type: 'route', q: '' };
const airlineName = id => D.byId.airline.get(id)?.name || id;
const pct0 = v => F.pct(v), pct1 = v => F.pct(v, 1);
const OBJ = {
  route: { label: 'Routes', count: 'route', rows: () => D.routes, sort: 'flights', text: r => `${r.id} ${r.dest_name}`,
    cols: [{ key: 'id', label: 'Route', render: r => h('span', { class: 'code', text: `${r.o} → ${r.d}` }) }, { key: 'dest_name', label: 'Destination' },
      { key: 'flights', label: 'Flights', num: true, fmt: F.int }, { key: 'on_time', label: 'On time', num: true, fmt: pct0 },
      { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin }, { key: 'p90_arr', label: '90th pct.', num: true, fmt: F.smin },
      { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: pct1 }, { key: 'dist', label: 'Miles', num: true, fmt: F.int },
      { key: 'ncar', label: 'Airlines', num: true, sortVal: r => r.carriers.length, render: r => r.carriers.length }, { key: 'alerts', label: 'Alerts', num: true }] },
  airline: { label: 'Airlines', count: 'airline', rows: () => D.airlines, sort: 'flights', text: r => `${r.id} ${r.name} ${r.type}`,
    cols: [{ key: 'name', label: 'Airline' }, { key: 'id', label: 'Code' }, { key: 'type', label: 'Type' }, { key: 'flights', label: 'Flights', num: true, fmt: F.int },
      { key: 'routes', label: 'Routes', num: true }, { key: 'on_time', label: 'On time', num: true, fmt: pct0 }, { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin },
      { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: pct1 }, { key: 'registry_aircraft', label: 'Aircraft', num: true, fmt: F.int }] },
  airport: { label: 'Airports', count: 'airport', rows: () => D.airports, sort: 'flights', text: r => `${r.id} ${r.name}`,
    cols: [{ key: 'id', label: 'Code', render: r => h('span', { class: 'code', text: r.id }) }, { key: 'name', label: 'Airport' },
      { key: 'origin', label: 'Role', sortVal: r => (r.origin ? 'a' : 'b'), render: r => (r.origin ? 'New York origin' : 'Destination') },
      { key: 'flights', label: 'Flights', num: true, fmt: F.int }, { key: 'carriers', label: 'Airlines', num: true }, { key: 'on_time', label: 'On time', num: true, fmt: pct0 },
      { key: 'mean_delay', label: 'Mean delay', num: true, fmt: F.smin }, { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: pct1 }, { key: 'miles', label: 'Miles from NYC', num: true, fmt: F.int }] },
  aircraft: { label: 'Aircraft', count: 'aircraft', lazy: 'aircraft', rows: () => D.aircraft, sort: 'flights', text: r => `${r.id} ${r.airline} ${r.maker} ${r.model}`,
    cols: [{ key: 'id', label: 'Tail', render: r => h('span', { class: 'code', text: r.id }) }, { key: 'airline', label: 'Operator', render: r => airlineName(r.airline) },
      { key: 'maker', label: 'Maker' }, { key: 'model', label: 'Model' }, { key: 'year', label: 'Built', num: true }, { key: 'seats', label: 'Seats', num: true },
      { key: 'flights', label: 'Flights', num: true, fmt: F.int }, { key: 'routes', label: 'Routes', num: true }, { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin }] },
  day: { label: 'Origin days', count: 'origin_day', rows: () => D.origin_days, sort: 'mean_dep', text: r => `${r.a} ${r.date} ${F.date(r.date)} ${r.disrupted ? 'disrupted' : ''}`,
    cols: [{ key: 'date', label: 'Day', render: r => F.date(r.date) }, { key: 'a', label: 'Airport' }, { key: 'flights', label: 'Flights', num: true },
      { key: 'mean_dep', label: 'Mean dep. delay', num: true, fmt: F.smin }, { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: pct1 },
      { key: 'vis', label: 'Min. visibility (mi)', num: true }, { key: 'precip', label: 'Precip. (in)', num: true, fmt: v => F.num(v, 2) }, { key: 'gust', label: 'Peak gust (mph)', num: true, fmt: v => (v == null ? '–' : F.int(v)) },
      { key: 'disrupted', label: 'Disrupted', sortVal: r => (r.disrupted ? 1 : 0), render: r => (r.disrupted ? 'Yes' : '') }] },
};

VIEW.explore = {
  render(root) {
    const counts = D.core.meta.counts, body = h('div', { class: 'fig' });
    const search = h('input', { class: 'field', id: 'object-search', type: 'search', placeholder: 'Filter this table', value: EX.q, 'aria-label': 'Filter objects',
      style: { maxWidth: '280px' }, oninput: e => { EX.q = e.target.value.trim().toLowerCase(); drawTable(); } });
    const chipRow = h('div', { class: 'row' });
    const chip = (key, label, n, on, pick) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(on), onclick: pick }, label, h('span', { class: 'n', text: F.int(n) }));
    const drawTable = () => {
      if (EX.type === 'flight') {
        body.replaceChildren(h('p', { class: 'lede', text: `All ${F.int(counts.flight)} flights and ${F.int(counts.delay)} delays stay in the pipeline's Parquet tables; the page carries their aggregates. These are the 40 longest arrival delays of the year.` }),
          simpleTable([{ label: 'Flight', render: r => r.flight }, { label: 'Airline', render: r => link('airline', r.airline, airlineName(r.airline)) },
            { label: 'Route', render: r => link('route', r.route, r.route.replace('-', ' → ')) }, { label: 'Day', render: r => F.date(r.date) },
            { label: 'Dep. delay', num: true, render: r => F.smin(r.dep) }, { label: 'Arr. delay', num: true, render: r => F.smin(r.arr) }, { label: 'Tail', render: r => r.tail || '–' }], D.core.stats.worst_flights),
          h('h2', { text: 'Delays by severity and phase' }),
          simpleTable([{ key: 'severity', label: 'Severity' }, { key: 'phase', label: 'Phase' }, { key: 'delays', label: 'Delays', num: true, fmt: F.int },
            { key: 'adverse_share', label: 'With adverse weather at origin', num: true, fmt: pct0 }], D.core.stats.delay_severity),
          h('p', { class: 'note', text: 'A delay is a flight that left or arrived 15+ min late. Minor is under 45 min, major under 2 hours, severe beyond. Adverse weather means low visibility, precipitation or strong wind at the origin in the scheduled hour.' }));
        return;
      }
      const def = OBJ[EX.type];
      const show = () => {
        const rows = def.rows().filter(r => !EX.q || def.text(r).toLowerCase().includes(EX.q));
        body.replaceChildren(h('p', { class: 'note', text: `${F.int(rows.length)} ${def.label.toLowerCase()}. Select a column to sort, a row to open it.` }),
          dataTable({ cols: def.cols, rows, sort: { key: def.sort, dir: 'desc' }, onRow: r => openObj(EX.type, r.id, true) }));
      };
      if (def.lazy && !D[def.lazy]) { body.replaceChildren(h('p', { class: 'muted', text: 'Loading…' })); need(def.lazy).then(() => { if (body.isConnected && OBJ[EX.type] === def) show(); }); }
      else show();
    };
    const draw = () => {
      chipRow.replaceChildren(...Object.entries(OBJ).map(([key, def]) => chip(key, def.label, counts[def.count], EX.type === key, () => { EX.type = key; EX.q = ''; search.value = ''; draw(); })),
        chip('flight', 'Flights and delays', counts.flight, EX.type === 'flight', () => { EX.type = 'flight'; draw(); }),
        chip('alert', 'Route alerts', counts.route_alert, false, () => setView('inbox')));
      search.hidden = EX.type === 'flight';
      drawTable();
    };
    put(root, viewHead('Objects', 'The pipeline ends in eight linked object types. Every code and name in this app opens its object, and each object links onward to its neighbours.'),
      chipRow, search, body);
    draw();
  },
};

// ---------- object details ----------
const routeLinkRows = rows => simpleTable([{ label: 'Route', render: r => link('route', r.id, `${r.o} → ${r.d}`) }, { key: 'flights', label: 'Flights', num: true, fmt: F.int },
  { key: 'on_time', label: 'On time', num: true, fmt: pct0 }, { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin }, { key: 'alerts', label: 'Alerts', num: true }], rows);
const alertLinks = list => (list.length ? h('div', { class: 'bay' }, list.map(a => h('div', { class: 'row', style: { fontSize: '13px' } },
  sevMark(a.sev), link('alert', a.id, `${TYPE_LABEL[a.type]}, ${a.o} → ${a.d}`), h('span', { class: 'muted', text: alertWhen(a) }), statusPill(Triage.get(a.id).status))))
  : h('p', { class: 'note', text: 'No alerts.' }));

DETAIL.airline = {
  kind: 'Airline', get: id => D.byId.airline.get(id),
  render(a) {
    const mine = D.routes.map(r => ({ r, c: r.carriers.find(c => c.id === a.id) })).filter(x => x.c).sort((x, y) => y.c.flights - x.c.flights);
    const fleet = D.core.fleet.filter(f => f.airline === a.id);
    return [h('div', { class: 'fig' }, h('h1', { text: a.name }), h('p', { class: 'muted', text: `${a.id}, ${a.type.toLowerCase()} carrier. Registered as ${a.legal}` })),
      tiles([[F.int(a.flights), 'flights from New York'], [F.pct(a.on_time), 'arrived on time'], [F.smin(a.mean_arr), 'mean arrival delay'], [F.pct(a.cancel_rate, 1), 'cancelled']]),
      h('section', { class: 'sect' }, figure({ title: 'On-time arrivals by month', sub: 'Share of completed flights arriving under 15 min late',
        chart: w => colChart({ width: w, height: 140, yFmt: pct0, yMax: 1, items: a.monthly.map(m => ({ label: MONTHS[m.month - 1][0], value: m.on_time,
          tip: [MONTHS[m.month - 1], [['on time', F.pct(m.on_time)], ['flights', F.int(m.flights)]]] })) }),
        table: { cols: [{ key: 'month', label: 'Month', fmt: m => MONTHS[m - 1] }, { key: 'flights', label: 'Flights', num: true, fmt: F.int }, { key: 'on_time', label: 'On time', num: true, fmt: pct0 },
          { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin }], rows: a.monthly } })),
      h('section', { class: 'sect' }, h('h2', { text: `Routes served (${mine.length})` }),
        simpleTable([{ label: 'Route', render: x => link('route', x.r.id, `${x.r.o} → ${x.r.d}`) }, { label: 'Flights', num: true, render: x => F.int(x.c.flights) },
          { label: 'On time', num: true, render: x => F.pct(x.c.on_time) }, { label: 'Mean arr. delay', num: true, render: x => F.smin(x.c.mean_arr) }], mine.slice(0, 15)),
        mine.length > 15 && h('p', { class: 'note', text: `The 15 busiest of ${mine.length}.` })),
      h('section', { class: 'sect' }, h('h2', { text: `Fleet flown (${F.int(a.registry_aircraft)} registry-matched aircraft)` }),
        fleet.length ? simpleTable([{ key: 'maker', label: 'Maker' }, { key: 'model', label: 'Model' }, { key: 'aircraft', label: 'Aircraft', num: true },
          { key: 'flights', label: 'Flights', num: true, fmt: F.int }, { key: 'seats', label: 'Seats', num: true }, { key: 'year', label: 'Mean year built', num: true, fmt: v => F.num(v, 0) }], fleet.slice(0, 14))
          : h('p', { class: 'note', text: 'This airline reports fleet numbers rather than registered tail numbers, so its aircraft do not match the FAA registry.' }))];
  },
};
DETAIL.airport = {
  kind: 'Airport', get: id => D.byId.airport.get(id),
  render(a) {
    const routes = D.routes.filter(r => r.o === a.id || r.d === a.id), alerts = D.alerts.filter(x => x.o === a.id || x.d === a.id);
    return [h('div', { class: 'fig' }, h('h1', { text: a.name }), h('p', { class: 'muted', text: `${a.id}, ${a.origin ? 'New York origin' : `${F.int(a.miles)} miles from New York`}` })),
      tiles([[F.int(a.flights), a.origin ? 'departures' : 'flights from New York'], [F.pct(a.on_time), a.origin ? 'left on time' : 'arrived on time'],
        [F.smin(a.mean_delay), a.origin ? 'mean departure delay' : 'mean arrival delay'], [F.pct(a.cancel_rate, 1), 'cancelled']]),
      kv([['Airlines', a.carriers], [a.origin ? 'Destinations' : 'New York origins', a.connected], ['Time zone', a.tz || '–'],
        ['Position', `${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}`], a.source !== 'airport list' && ['Record source', 'Supplement file (missing from the airport list)']]),
      h('section', { class: 'sect' }, h('h2', { text: `Routes (${routes.length})` }), routeLinkRows(routes.slice(0, 20)), routes.length > 20 && h('p', { class: 'note', text: `The 20 busiest of ${routes.length}.` })),
      h('section', { class: 'sect' }, h('h2', { text: `Alerts (${alerts.length})` }), alertLinks(alerts.slice(-12).reverse()), alerts.length > 12 && h('p', { class: 'note', text: 'The 12 most recent.' }))];
  },
};
DETAIL.route = {
  kind: 'Route', get: id => need('route_daily').catch(() => null).then(() => D.byId.route.get(id)),
  render(r) {
    const daily = D.byId.daily?.get(r.id), alerts = D.alerts.filter(a => a.route === r.id);
    return [h('div', { class: 'fig' }, h('h1', { class: 'code', text: `${r.o} → ${r.d}` }),
      h('p', null, link('airport', r.o, D.byId.airport.get(r.o).name), ' to ', link('airport', r.d, r.dest_name))),
      tiles([[F.int(r.flights), 'flights'], [F.pct(r.on_time), 'arrived on time'], [F.smin(r.mean_arr), 'mean arrival delay'], [F.pct(r.cancel_rate, 1), 'cancelled']]),
      kv([['90th percentile arrival delay', F.smin(r.p90_arr)], ['Median arrival delay', F.smin(r.median_arr)], ['Mean departure delay', F.smin(r.mean_dep)],
        ['Minutes made up in the air, mean', F.num(r.recovery)], ['Median air time', F.min(r.air_time)],
        ['Distance, reported and great-circle', `${F.int(r.dist)} and ${F.int(r.gc)} mi`], ['Days operated', r.days]]),
      daily && h('section', { class: 'sect' }, figure({ title: 'Mean departure delay by day', sub: 'Each square is a day; columns are weeks. Empty squares had no flights.',
        chart: w => calendarHeat({ width: w, color: v => PAL.seq(v / 60), days: daily.dep.map((v, i) => ({ date: idxDate(i), value: daily.n[i] ? Math.max(0, v ?? 0) : null,
          tip: [F.date(idxDate(i)), [['mean departure delay', v == null ? '–' : F.min(v)], ['scheduled', daily.n[i]], ['cancelled', daily.c[i]]]] })) }),
        caption: 'Light is on time, dark is 60 min or more.' })),
      h('section', { class: 'sect' }, h('h2', { text: `Airlines on this route (${r.carriers.length})` }),
        simpleTable([{ label: 'Airline', render: c => link('airline', c.id, airlineName(c.id)) }, { key: 'flights', label: 'Flights', num: true, fmt: F.int },
          { key: 'on_time', label: 'On time', num: true, fmt: pct0 }, { key: 'mean_arr', label: 'Mean arr. delay', num: true, fmt: F.smin }, { key: 'cancel_rate', label: 'Cancelled', num: true, fmt: pct1 }], r.carriers)),
      h('section', { class: 'sect' }, h('h2', { text: `Alerts (${alerts.length})` }), alertLinks(alerts))];
  },
};
DETAIL.aircraft = {
  kind: 'Aircraft', get: id => need('aircraft').then(() => D.byId.aircraft.get(id)),
  render: a => [h('div', { class: 'fig' }, h('h1', { class: 'code', text: a.id }), h('p', { class: 'muted', text: `${a.maker} ${a.model}` })),
    kv([['Main operator', link('airline', a.airline, airlineName(a.airline))], ['Built', a.year ?? '–'], ['Seats', a.seats], ['Engines', a.engines],
      ['Flights from New York in 2013', F.int(a.flights)], ['Routes flown', a.routes], ['Mean arrival delay', F.smin(a.mean_arr)], ['Miles flown', F.int(a.miles)]])],
};
DETAIL.day = {
  kind: 'Origin day', get: id => D.byId.oday.get(id),
  render(o) {
    const alerts = D.alerts.filter(a => a.origin_day === o.id), i = dayIdx(o.date);
    const near = k => (i + k >= 0 && i + k <= 364 ? link('day', `${o.a}_${idxDate(i + k)}`, F.date(idxDate(i + k))) : null);
    return [h('div', { class: 'fig' }, h('h1', { text: `${o.a}, ${F.date(o.date)}` }),
      h('p', null, link('airport', o.a, D.byId.airport.get(o.a).name), o.disrupted ? '. Flagged as an airport-wide disruption.' : '.')),
      tiles([[F.int(o.flights), 'scheduled departures'], [F.pct(o.cancel_rate, 1), 'cancelled'], [F.smin(o.mean_dep), 'mean departure delay'], [F.pct(o.late_share), 'left 15+ min late']]),
      h('section', { class: 'sect' }, h('h2', { text: 'Weather at the airport' }), kv([['Temperature', o.tmin == null ? '–' : `${Math.round(o.tmin)} to ${Math.round(o.tmax)} °F`],
        ['Precipitation', o.precip == null ? '–' : `${F.num(o.precip, 2)} in`], ['Lowest visibility', o.vis == null ? '–' : `${o.vis} mi`],
        ['Peak sustained wind', o.wind == null ? '–' : `${Math.round(o.wind)} mph`], ['Peak gust', o.gust == null ? 'none recorded' : `${Math.round(o.gust)} mph`],
        ['Hours with adverse weather', o.adverse_hours ?? '–'], ['Disruption score against the prior 28 days', o.z == null ? '–' : F.num(o.z)]]),
        h('p', { class: 'note', text: 'The score is (mean delay − median) / max(1.4826 × MAD, 2 min). A day is flagged at 3.5 or more with a mean delay of at least 30 min, or when 10% of flights are cancelled.' })),
      h('section', { class: 'sect' }, h('h2', { text: `Route alerts that day (${alerts.length})` }), alertLinks(alerts)),
      h('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '13px' } }, h('span', null, near(-1)), h('span', null, near(1)))];
  },
};
