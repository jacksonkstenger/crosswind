// ---------- boot ----------
async function boot() {
  try {
    const [core, airports, routes, alerts, odays] = await Promise.all(['core', 'airports', 'routes', 'alerts', 'origin_days'].map(getJSON));
    Object.assign(D, { core, airports, routes, alerts, origin_days: odays, airlines: core.airlines });
    Object.assign(D.byId, { airline: index(D.airlines), airport: index(airports), route: index(routes), alert: index(alerts), oday: index(odays) });
  } catch (err) {
    $('#main').replaceChildren(h('p', { class: 'boot', text: `The flight data could not load (${err.message}). Reload the page to try again.` }));
    return;
  }
  Triage.init(); initAsk();
  applyHash(true);
  window.addEventListener('hashchange', () => {
    if (S.selfHash === location.hash.slice(1)) { S.selfHash = null; return; }
    S.selfHash = null; applyHash(false);
  });
  window.addEventListener('resize', debounce(() => { if (Math.abs(innerWidth - S.width) > 8) { S.width = innerWidth; renderAll(); } }, 200));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && S.stack.length) closeDrawer(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAll);
  new MutationObserver(renderAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
boot();
