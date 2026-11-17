// ---------- live mode: current FAA status and weather, beside 2013 baselines ----------
const LIVE_SITE = 'https://jacksonkstenger.github.io/crosswind/';
const LIVE_STATUS = [['Normal', '--good', 'M12 3a9 9 0 100 18 9 9 0 000-18z'], ['Delays', '--warning', SEV_SHAPE.medium],
  ['Ground stop', '--serious', SEV_SHAPE.high], ['Closed', '--critical', SEV_SHAPE.critical]];
const liveMark = r => h('span', { class: 'lstat', 'data-r': r },
  s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: LIVE_STATUS[r][2], fill: 'currentColor' })), LIVE_STATUS[r][0]);
const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`);
const spanText = a => (a.min != null && a.max != null && a.min !== a.max ? `${a.min} to ${a.max} min` : (a.max ?? a.min) != null ? fmtMin(a.max ?? a.min) : null);
const clock = iso => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

const Live = {
  data: null, history: [], state: 'loading',
  async load() {
    try {
      const res = await fetch('data/live.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json(); this.state = 'ok';
      const hist = await fetch('data/live_history.json', { cache: 'no-store' }).catch(() => null);
      if (hist && hist.ok) this.history = await hist.json();
    } catch (err) { if (!this.data) this.state = 'unavailable'; }
    return this.state === 'ok';
  },
  rank(code) { return this.data?.status?.[code] ?? 0; },
  age() {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(this.data.generated)) / 60000));
    return m < 1 ? 'updated just now' : m < 90 ? `updated ${m} min ago` : m < 2880 ? `updated ${Math.round(m / 60)} h ago` : `last updated ${clock(this.data.generated)}`;
  },
};
function liveUnavailable() {
  const onSite = location.hostname.endsWith('github.io');
  return [viewHead('Live', 'Live mode shows current FAA airport status and weather for New York departures, beside what was normal in 2013.'),
    h('div', { class: 'banner' }, onSite ? 'The live data file has not been published yet. The scheduled job writes it every 15 minutes; check back shortly.'
      : ['This copy of the page cannot reach outside data, so live mode runs on the public site, which refreshes every 15 minutes: ', h('a', { href: LIVE_SITE, text: LIVE_SITE })]),
    h('p', { class: 'note', text: 'The 2013 archive works here in full. Switch with the control at the top.' })];
}
function liveStrip(a) {
  const stat = a.kind === 'ground_stop' || a.kind === 'closure' ? [a.until ? `until ${a.until}` : 'in effect', a.label.toLowerCase()]
    : a.avg != null ? [`avg ${fmtMin(a.avg)}`, 'assigned delay'] : [spanText(a) || 'in effect', a.label.toLowerCase()];
  const from = a.routes.length === 1 ? a.routes[0].split('-')[0] : 'NYC';
  return h('button', { class: 'strip', type: 'button', 'data-v': a.sev, 'data-id': a.id, onclick: () => openObj('live', a.id, true) },
    h('span', { class: 'holder' }),
    h('span', { class: 'cells' },
      h('span', { class: 'route' }, a.scope === 'origin' ? a.airport : [from, h('span', { class: 'arr', text: '→' }), a.airport]),
      h('span', { class: 'what' }, sevMark(a.sev), h('span', { text: a.label }), a.reason && h('span', { class: 'muted', text: a.reason }))),
    h('span', { class: 'stat' }, h('b', { style: { fontSize: stat[0].length > 9 ? '14px' : null }, text: stat[0] }), h('span', { text: stat[1] })));
}
function airportCard(code, a) {
  const w = a.weather, b = a.baseline;
  const program = p => `${p.label}${p.avg != null ? `, averaging ${fmtMin(p.avg)}` : p.span ? `, ${p.span}` : ''}${p.trend ? `, ${p.trend.toLowerCase()}` : ''}${p.until ? `, until ${p.until}` : ''}${p.reason ? ` (${p.reason})` : ''}.`;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, link('airport', code, h('span', { class: 'code', text: code })), liveMark(a.status)),
    h('p', { class: 'muted', text: a.name }),
    a.programs.length ? a.programs.map(p => h('p', { text: program(p) })) : h('p', { text: 'No FAA programme in effect.' }),
    h('p', { text: w ? `${w.category || 'Weather'}: visibility ${w.visibility_mi ?? '–'} mi, ${w.ceiling_ft != null ? `ceiling ${F.int(w.ceiling_ft)} ft` : 'no ceiling'}, wind ${w.wind_mph != null ? `${Math.round(w.wind_mph)} mph` : '–'}${w.gust_mph ? ` gusting ${Math.round(w.gust_mph)}` : ''}${w.temp_f != null ? `, ${Math.round(w.temp_f)} °F` : ''}${w.weather ? `, ${w.weather}` : ''}.` : 'Current weather is unavailable.' }),
    b && h('p', { class: 'note', text: `Normal for ${b.scope}: ${Math.round(b.mean_dep)} min mean departure delay, ${F.pct(b.late_share)} left 15+ min late, ${F.pct(b.cancel_rate, 1)} cancelled.` }),
    a.weather_baseline.length ? [h('h3', { text: '2013 departures in similar weather' }),
      kv(a.weather_baseline.map(x => [`${x.dimension}: ${x.bin}`, `${Math.round(x.mean_dep)} min, ${F.pct(x.cancel_rate, 1)} cancelled`]))] : null);
}
function historyFigure() {
  const pts = Live.history.filter(p => Date.now() - Date.parse(p.t) < 48 * 36e5);
  if (pts.length < 3) return h('section', { class: 'sect' }, h('h2', { text: 'Last 48 hours' }), h('p', { class: 'note', text: 'History builds up as the site refreshes. Check back after a few updates.' }));
  const t0 = Date.parse(pts[0].t), x = p => (Date.parse(p.t) - t0) / 6e4, span = x(pts.at(-1));
  const label = v => new Date(t0 + v * 6e4).toLocaleString('en-US', span > 1440 ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' });
  return h('section', { class: 'sect' }, figure({ title: 'Last 48 hours', sub: 'Counts at each refresh, on one axis',
    legend: [['Alerts for New York departures', PAL.series[0]], ['FAA programmes nationwide', PAL.series[1]]],
    chart: w => lineChart({ width: w, xTicks: [0, span / 3, 2 * span / 3, span], xFmt: label, tipTitle: label, yFmt: v => String(Math.round(v)),
      series: [{ name: 'NYC', color: PAL.series[0], pts: pts.map(p => [x(p), p.alerts]) }, { name: 'US', color: PAL.series[1], pts: pts.map(p => [x(p), p.programs]) }] }),
    table: { cols: [{ key: 't', label: 'Time', fmt: clock }, { key: 'alerts', label: 'Alerts for New York', num: true }, { key: 'programs', label: 'Programmes nationwide', num: true }], rows: [...pts].reverse().slice(0, 60) } }));
}

VIEW.now = {
  render(root) {
    if (Live.state !== 'ok') { put(root, liveUnavailable()); return; }
    const L = Live.data, feeds = L.feeds || {};
    const refresh = h('button', { class: 'btn', type: 'button', onclick: async () => { refresh.disabled = true; await Live.load(); renderAll(); } }, 'Refresh');
    put(root, viewHead('Live', 'FAA airport status and weather for departures from Newark, Kennedy and LaGuardia, beside what was normal in 2013.'),
      h('div', { class: 'row' }, refresh, h('span', { class: 'note', text: `${L.local.label}, ${Live.age()}.` })),
      L.stale_since && h('div', { class: 'banner', text: `The FAA feed could not be read on the last check, so this is the picture from ${clock(L.stale_since)}.` }),
      feeds.faa && !feeds.faa.ok && !L.stale_since && h('div', { class: 'banner', text: `The FAA feed could not be read (${feeds.faa.error}), so no programmes are shown.` }),
      feeds.metar && !feeds.metar.ok && h('div', { class: 'banner', text: `Weather could not be read (${feeds.metar.error}).` }),
      h('div', { class: 'cards' }, Object.entries(L.airports).map(([code, a]) => airportCard(code, a))),
      h('section', { class: 'sect' }, h('h2', { text: `Live alerts (${L.alerts.length})` }),
        h('p', { class: 'note', text: `${L.programs_total} FAA programmes are active nationwide. Shown here: those at the three New York airports, and those at any of the ${L.watched_destinations} destinations they served in 2013.` }),
        L.alerts.length ? h('div', { class: 'bay' }, L.alerts.map(liveStrip)) : h('p', { text: 'No FAA programme affects New York departures or their destinations right now.' })),
      historyFigure(),
      h('section', { class: 'sect' }, h('h2', { text: 'Sources' }),
        simpleTable([{ label: 'Feed', render: r => r[0] }, { label: 'Last read', wrap: true, render: r => (r[1] ? (r[1].ok ? `Read, ${F.int(r[1].items)} items, ${F.int(r[1].bytes)} bytes` : `Failed: ${r[1].error}`) : '–') }],
          [['FAA airport status (nasstatus.faa.gov)', feeds.faa], ['Aviation Weather Center METAR', feeds.metar]]),
        h('p', { class: 'note', text: 'The FAA feed lists traffic programmes by airport, not individual flights. A ground stop can exempt some origins, and the feed does not say which, so a destination alert means New York flights may be held. Baselines are 2013 figures from the archive mode.' })));
  },
};

DETAIL.live = {
  kind: 'Live alert', get: id => Live.data?.alerts.find(a => a.id === id),
  render(a) {
    const b = a.baseline || {}, all = Live.data.all_flights;
    return [h('div', { class: 'fig' }, h('h1', { text: `${a.label} at ${a.airport}` }),
      h('div', { class: 'row' }, sevMark(a.sev), link('airport', a.airport, a.airport_name))),
      h('p', { text: a.summary }),
      kv([['Reason given by the FAA', a.reason || 'none'], a.avg != null && ['Average assigned delay', fmtMin(a.avg)], spanText(a) && [a.min == null || a.min === a.max ? 'Longest delay' : 'Delay range', spanText(a)],
        a.trend && ['Trend', a.trend], a.until && ['Until', a.until], ['First seen', clock(a.first_seen)]]),
      a.scope === 'destination' ? h('section', { class: 'sect' }, h('h2', { text: 'Baseline for these routes' }),
        h('p', { text: `In ${b.month} 2013 these routes ran about ${b.flights_per_day_month} flights a day, and ${F.pct(b.on_time_month)} arrived on time. Over the year it was ${F.pct(b.on_time_year)}, against ${F.pct(b.all_flights_on_time)} for all New York departures.` }),
        simpleTable([{ label: 'Route', render: r => link('route', r.route, r.route.replace('-', ' → ')) }, { key: 'flights_month', label: `Flights, ${b.month}`, num: true, fmt: F.int },
          { key: 'on_time_month', label: `On time, ${b.month}`, num: true, fmt: v => F.pct(v) }, { key: 'on_time_year', label: 'On time, 2013', num: true, fmt: v => F.pct(v) },
          { key: 'mean_arr_month', label: `Mean arr. delay, ${b.month}`, num: true, fmt: F.smin }, { key: 'alerts_2013', label: '2013 alerts', num: true }], b.routes))
        : h('section', { class: 'sect' }, h('h2', { text: 'Baseline for this hour' }),
          b.now ? kv([[`Mean departure delay, ${b.now.scope}`, F.min(b.now.mean_dep)], ['Left 15+ min late', F.pct(b.now.late_share)], ['Cancelled', F.pct(b.now.cancel_rate, 1)],
            ['All New York departures, 2013', `${F.min(all.mean_dep)}, ${F.pct(all.cancel_rate, 1)} cancelled`]]) : h('p', { class: 'note', text: 'No 2013 flights were scheduled at this hour.' })),
      h('p', { class: 'note', text: 'Route and airport links open the 2013 archive.' })];
  },
};
