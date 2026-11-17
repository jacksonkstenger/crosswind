# Crosswind

An end-to-end data product in one small repo: raw public flight records go in, a layered
pipeline cleans and models them into linked business objects, statistical detectors raise
route alerts, and a single-page operations app sits on top.

It follows the same shape as an enterprise "raw → clean → enriched → ontology → app"
stack, built independently with open tools (Python, DuckDB, plain JavaScript) on real data.

## Run it

```bash
pip install -r requirements.txt
python -m pipeline.run                    # ~7 s: builds data/*.parquet and app/data/*.json
python tools/build_app.py                 # inlines app/src into app/index.html
python -m http.server 8000 --directory app   # then open http://localhost:8000
python tests/test_stats.py                # checks the alert statistics
```

## Data

All 336,776 scheduled departures from Newark (EWR), Kennedy (JFK) and LaGuardia (LGA) in
2013, from the US Bureau of Transportation Statistics on-time data, with the FAA aircraft
registry, an airport list and hourly NOAA weather at the three airports. The files ship
inside the `nycflights13` Python package, so nothing is downloaded at run time.

`reference/` holds the small tables written for this project: two band lookups that follow
the BTS distance-group and delay-group schemes, a carrier classification (an editorial
call: network, low-cost or regional) and four Caribbean airports missing from the airport
list. `reference/geo/` holds map outlines from us-atlas (US Census) and world-atlas
(Natural Earth), both public domain.

Not in this data: cancellation reason codes and delay-cause minutes. Cancelled means no
departure was recorded; "no arrival recorded" flights departed and most likely diverted.

## Pipeline

`pipeline/dag.py` is a 200-line dataset DAG. A dataset declares its inputs, returns one SQL
query and lists its health checks. The runner materialises each dataset as Parquet, then:

- refuses to continue if the SQL reads a table that was not declared as an input, so the
  lineage graph in the app cannot drift from the code;
- runs the checks (primary key unique and not null, row counts conserved between layers,
  foreign keys resolving, value ranges) and records pass, warn or fail with the observed value.

| Layer | Datasets | What happens |
|---|---|---|
| raw | 9 | Source files as delivered, every column text |
| clean | 8 | Typing, `NA` to NULL, readable flight key, maker names normalised, one impossible wind reading nulled |
| processed | 4 | Status, route, 15-minute delay flags and bands, distance band, weather flags |
| enriched | 2 | The fan-in: one wide row per flight with airline, airports, aircraft and weather in the scheduled hour |
| transform | 2 | Flight fact table and one row per delay of 15+ minutes |
| metrics | 10 | Per route-day, origin-day, airline, hour, weather bin, distance band |
| alerts | 1 | Three detectors (below) |
| ontology | 9 | One backing table per object type, plus the airline-route join table |

45 datasets and 165 checks. Two checks warn by design: 15% of flights carry a tail number
that is not in the registry (some carriers report fleet numbers), and the 17-mile EWR to
LGA hop misses a 2% distance tolerance through rounding.

The checks earned their keep during the build: a duplicate key in `processed/airports`
(LaGuardia is both an origin and a destination) fanned 336,776 flights out to 441,439 in
the join, and three row-count checks failed until it was fixed.

## Alert detectors

All in `pipeline/stage_alerts.py`; each alert stores the numbers that triggered it.

1. **Delay spike** (daily). x = the route's mean departure delay minus the mean for the
   rest of its origin that day. z = (x − median) / max(1.4826 · MAD, 5 min) against the
   route's previous 28 days. Fires at z ≥ 4 with x at least 30 min above baseline, a route
   mean of 30+ min and 60% of departures leaving 15+ min late.
2. **Cancellation cluster** (daily). Exact test of c cancellations in n flights against
   Bin(n, p₀), where p₀ is the larger of the route's smoothed 56-day rate and the rest of
   the origin that day. Benjamini–Hochberg at q = 0.05 over all 38,503 route-days.
3. **Chronically late week**. The 95% Wilson lower bound on the share of arrivals 15+ min
   late exceeds one half, with at least 15 arrivals.

They raise 296 alerts over the year: 247 delay spikes, 19 cancellation clusters and 30
chronic weeks. z is not a calibrated p-value (delays are skewed), so its threshold is a
conservative convention; the binomial test assumes independent cancellations given p₀,
which is why p₀ absorbs airport-wide bad days.

## Ontology

Eight object types: Airline, Aircraft, Airport, Route, Flight, Delay, Origin Day and Route
Alert, joined by 14 link types. `pipeline/stage_ontology.py` holds the definition,
including the state machine for triaging an alert (open → acknowledged → investigating →
resolved or dismissed, with reopen).

## App

`app/index.html` is one self-contained page (no framework, no map library) that reads
`app/data/*.json`.

- **Alerts**: the inbox, with filters, the statistic behind each alert, the flights
  involved, the weather, and triage with notes and a history.
- **Map**: azimuthal equidistant projection centred on New York, so routes are straight
  great-circle lines and range rings are circles.
- **Objects**: sortable tables for each object type; every object links to its neighbours.
- **Delays**: the year as a calendar, delay by hour, weather effects, airlines, distance.
- **Pipeline**: the lineage graph exported by the run, schema and checks per dataset.
- **Ask**: when the page is hosted as a Claude artifact, questions are answered by Claude
  calling a query function the page runs over its own tables.

The app carries aggregates and the small object types. The flight and delay rows stay in
Parquet under `data/`.
