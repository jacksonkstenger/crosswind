// ---------- delay analytics ----------
const DL = { origin: 'all' };
const ORIGINS = ['EWR', 'JFK', 'LGA'];

VIEW.delays = {
  render(root) {
    const k = D.core.meta.kpis, st = D.core.stats, scoped = h('div', { class: 'fig', style: { gap: '22px' } });
    const drawScoped = () => {
      const origins = DL.origin === 'all' ? ORIGINS : [DL.origin];
      const cal = h('div', { class: 'fig' }, origins.map(o => {
        const days = D.origin_days.filter(d => d.a === o);
        return h('div', { class: 'fig' }, h('h3', null, link('airport', o, `${o}  ${D.byId.airport.get(o).name}`)),
          h('div', { class: 'scroll-x' }, calendarHeat({ width: chartWidth(root), color: v => PAL.seq(v / 60),
            days: days.map(d => ({ date: d.date, value: Math.max(0, d.mean_dep), flag: d.disrupted, pick: () => openObj('day', d.id, true),
              tip: [`${o}, ${F.date(d.date)}`, [['mean departure delay', F.min(d.mean_dep)], ['cancelled', F.pct(d.cancel_rate, 1)],
                ['min. visibility', d.vis == null ? '–' : `${d.vis} mi`], ['precipitation', d.precip == null ? '–' : `${F.num(d.precip, 2)} in`]]] })) })));
      }));
      const disrupted = D.origin_days.filter(d => d.disrupted && origins.includes(d.a));
      scoped.replaceChildren(
        h('figure', { class: 'fig' }, h('div', { class: 'fig-head' }, h('div', null, h('h2', { text: 'The year, day by day' }),
          h('p', { text: 'Mean departure delay per day. Outlined days are airport-wide disruptions. Select a day to open it.' }))),
        h('div', { class: 'legend' }, h('span', null, 'On time'),
          h('span', { style: { width: '110px', height: '10px', borderRadius: '2px', background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map(PAL.seq).join(',')})` } }),
          h('span', null, '60 min or more'), h('span', null, h('i', { class: 'box', style: { background: 'none', outline: '1.5px solid var(--accent)' } }), `Disruption (${disrupted.length} days)`)),
        cal),
        figure({ title: 'Delay builds through the day', sub: 'Mean departure delay by scheduled departure hour',
          legend: origins.length > 1 ? origins.map(o => [o, PAL.series[ORIGINS.indexOf(o)]]) : null,
          chart: w => lineChart({ width: w, yFmt: v => `${Math.round(v)}`, xTicks: [6, 9, 12, 15, 18, 21], xFmt: v => `${v}:00`, tipTitle: v => `${v}:00 to ${v}:59`,
            series: origins.map(o => ({ name: o, color: PAL.series[ORIGINS.indexOf(o)],
              pts: st.hourly.filter(r => r.origin === o && r.flights >= 200 && r.mean_dep != null).map(r => [r.hour, r.mean_dep]) })) }),
          table: { cols: [{ key: 'origin', label: 'Origin' }, { key: 'hour', label: 'Hour', num: true, fmt: v => `${v}:00` }, { key: 'flights', label: 'Flights', num: true, fmt: F.int },
            { key: 'mean_dep', label: 'Mean dep. delay (min)', num: true, fmt: v => F.num(v) }, { key: 'late_share', label: 'Left 15+ min late', num: true, fmt: v => F.pct(v) }],
            rows: st.hourly.filter(r => origins.includes(r.origin)) },
          caption: 'Minutes, on one axis. Hours with fewer than 200 flights in the year are left out. Early flights leave near schedule; delay accumulates until the evening.' }));
    };
    const weather = ['Visibility', 'Wind speed', 'Precipitation', 'Temperature'].map(dim => {
      const rows = st.weather.filter(r => r.dimension === dim);
      return h('figure', { class: 'fig' }, h('h3', { text: dim }),
        hbars(rows.map(r => ({ label: r.bin, value: Math.max(0, r.mean_dep), text: `${Math.round(r.mean_dep)} min` }))),
        h('figcaption', { text: `Cancelled: ${rows.map(r => F.pct(r.cancel_rate, 1)).join(', ')} in the same order.` }));
    });
    const byOnTime = [...D.airlines].sort((a, b) => b.on_time - a.on_time);
    const bands = st.delay_bands, total = bands.reduce((n, b) => n + b.flights, 0);
    const bandShort = g => (g === -2 ? '<−15' : g === 12 ? '180+' : String(g * 15));
    put(root, viewHead('Delays', 'Where and when New York departures ran late in 2013, and how much of it the weather explains.'),
      tiles([[F.int(k.flights), 'scheduled departures'], [F.pct(k.on_time, 1), 'arrived on time', 'under 15 min late'], [F.pct(k.cancel_rate, 1), 'cancelled', `${F.int(k.cancelled)} flights`],
        [F.min(k.mean_dep), 'mean departure delay', `median arrival ${F.smin(k.median_arr)}`]]),
      h('div', { class: 'row' }, seg([['all', 'All origins'], ...ORIGINS.map(o => [o, o])], DL.origin, v => { DL.origin = v; renderAll(); }, 'Origin')),
      scoped,
      h('section', { class: 'sect' }, h('h2', { text: 'Weather at the origin' }),
        h('p', { class: 'lede', text: 'Mean departure delay by conditions at the airport in the scheduled hour, all three origins together. An association, since storms also arrive in the busy late afternoon.' }),
        h('div', { class: 'grid2' }, weather)),
      h('section', { class: 'sect' }, h('div', { class: 'grid2' },
        h('figure', { class: 'fig' }, h('h2', { text: 'On-time arrivals by airline' }),
          hbars(byOnTime.map(a => ({ link: link('airline', a.id, a.name), value: a.on_time, text: F.pct(a.on_time) })), { max: 1 }),
          h('figcaption', { text: 'Share of completed flights arriving under 15 min late. Bars start at zero.' })),
        h('figure', { class: 'fig' }, h('h2', { text: 'Minutes made up in the air' }),
          hbars(st.distance.filter(d => d.flights >= 500).map(d => ({ label: d.band, value: Math.max(0, d.recovery), text: `${F.num(d.recovery)} min` }))),
          h('figcaption', { text: 'Mean departure delay minus arrival delay, by route distance. Longer flights have more schedule padding and more sky to recover in. Bands with under 500 flights are left out.' })))),
      h('section', { class: 'sect' }, figure({ title: 'How late flights leave', sub: `Departed flights by 15-minute band; ${F.pct(bands.filter(b => b.g <= 0).reduce((n, b) => n + b.flights, 0) / total)} leave under 15 min late`,
        chart: w => colChart({ width: w, height: 170, yFmt: v => (v >= 1000 ? `${v / 1000}K` : `${v}`), xEvery: w < 480 ? 2 : 1,
          items: bands.map(b => ({ label: bandShort(b.g), value: b.flights, tip: [b.band, [['flights', F.int(b.flights)], ['of departures', F.pct(b.flights / total, 1)]]] })) }),
        table: { cols: [{ key: 'band', label: 'Band' }, { key: 'flights', label: 'Flights', num: true, fmt: F.int }, { key: 'share', label: 'Share', num: true, fmt: v => F.pct(v, 1) }],
          rows: bands.map(b => ({ ...b, share: b.flights / total })) },
        caption: 'Axis labels are the lower edge of each band in minutes.' })));
    drawScoped();
  },
};
