"""Export the compact JSON files the app reads (app/data/).

The app never sees the 336,776 flight rows. It gets the ontology objects that
are small enough to ship (airlines, airports, routes, aircraft, origin days,
alerts), daily series per route, the metric tables, and the lineage itself.
Geometry is pre-projected here so the page needs no map library.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

from .dag import ROOT

APP_DATA = ROOT / "app" / "data"
GEO = ROOT / "reference" / "geo"

# Azimuthal equidistant projection centred between the three New York airports.
# Distance and bearing from the centre are exact, so great circles through the
# centre are straight lines and range rings are true circles.
EARTH_MI = 3958.7613


def projector(lat0: float, lon0: float):
    p0, l0 = math.radians(lat0), math.radians(lon0)

    def project(lon: float, lat: float) -> tuple[float, float, float]:
        p, dl = math.radians(lat), math.radians(lon) - l0
        cosc = math.sin(p0) * math.sin(p) + math.cos(p0) * math.cos(p) * math.cos(dl)
        c = math.acos(max(-1.0, min(1.0, cosc)))
        k = 1.0 if c < 1e-9 else c / math.sin(c)
        x = EARTH_MI * k * math.cos(p) * math.sin(dl)
        y = EARTH_MI * k * (math.cos(p0) * math.sin(p) - math.sin(p0) * math.cos(p) * math.cos(dl))
        return x, y, EARTH_MI * c
    return project


def _rows(con, sql: str) -> list[dict]:
    cur = con.execute(sql)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def _clean(v, nd=2):
    if v is None or isinstance(v, (bool, str, int, list, dict)):
        return v
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else round(v, nd)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    try:                       # Decimal and friends
        f = float(v)
        return int(f) if f == int(f) else round(f, nd)
    except (TypeError, ValueError):
        return str(v)


def _clean_row(r: dict, nd=2, keep4=()) -> dict:
    return {k: _clean(v, 4 if k in keep4 else nd) for k, v in r.items()}


SHARES = ("cancel_rate", "on_time", "on_time_share", "late_share", "observed", "expected", "stat", "p", "ref",
          "base_center", "b_route", "b_month", "b_origin", "b_all")


def _write_lines(path: Path, records: list) -> None:
    """One array, one record per line: easy to diff and to read in part."""
    body = ",\n".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in records)
    path.write_text("[\n" + body + "\n]\n", encoding="utf-8")


def _topo_rings(topo: dict, obj: str):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(ids):
        pts = []
        for i in ids:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts.extend(a if not pts else a[1:])
        return pts

    for g in topo["objects"][obj]["geometries"]:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        yield g, [ring(r) for poly in polys for r in poly[:1]]   # outer rings only


def _geometry(project) -> dict:
    def flat(ring, step):
        out, last = [], None
        for lon, lat in ring:
            x, y, _ = project(lon, lat)
            if last is None or math.hypot(x - last[0], y - last[1]) >= step:
                out += [round(x), round(-y)]
                last = (x, y)
        return out if len(out) >= 8 else None

    states = []
    for g, rings in _topo_rings(json.loads((GEO / "states-10m.json").read_text()), "states"):
        rs = [f for f in (flat(r, 6) for r in rings) if f]
        if rs:
            states.append({"name": g["properties"]["name"], "rings": rs})
    land = []
    for g, rings in _topo_rings(json.loads((GEO / "countries-110m.json").read_text()), "countries"):
        if g.get("id") == "840":           # the United States is drawn from the state file
            continue
        for r in rings:
            dist = [project(lon, lat)[2] for lon, lat in r]
            if min(dist) < 5600 and max(dist) < 9500:
                f = flat(r, 12)
                if f:
                    land.append(f)
    return {"states": states, "land": land}


def export(con, lineage: dict, ontology: dict) -> None:
    APP_DATA.mkdir(parents=True, exist_ok=True)
    q = lambda sql: _rows(con, sql)

    # ---- airports (with projected position) -------------------------------
    airports = q("""select airport_id as id, airport_name as name, lat, lon, time_zone as tz, is_origin as origin,
                           flights, carriers, connected_airports as connected, mean_delay, on_time_share as on_time,
                           cancel_rate, record_source as source
                    from ontology__airport order by flights desc, airport_id""")
    nyc = [a for a in airports if a["origin"]]
    lat0 = sum(a["lat"] for a in nyc) / len(nyc)
    lon0 = sum(a["lon"] for a in nyc) / len(nyc)
    project = projector(lat0, lon0)
    for a in airports:
        x, y, d = project(a["lon"], a["lat"])
        a.update(x=round(x, 1), y=round(-y, 1), miles=round(d))
    _write_lines(APP_DATA / "airports.json", [_clean_row(a, 3, ("lat", "lon")) for a in airports])
    (APP_DATA / "geo.json").write_text(json.dumps(_geometry(project), separators=(",", ":")))

    # ---- airlines ---------------------------------------------------------
    airlines = q("""select airline_id as id, airline_name as name, legal_name as legal, carrier_type as type,
                           flights, routes, cancelled, cancel_rate, on_time_share as on_time, mean_dep_delay as mean_dep,
                           mean_arr_delay as mean_arr, median_arr_delay as median_arr, tails_flown as tails,
                           registry_aircraft, models
                    from ontology__airline order by flights desc, airline_id""")
    monthly = q("""select carrier, month, flights, on_time_share as on_time, mean_arr_delay as mean_arr, cancel_rate
                   from metrics__carrier_monthly order by carrier, month""")
    for a in airlines:
        a["monthly"] = [_clean_row({k: v for k, v in m.items() if k != "carrier"}, 3)
                        for m in monthly if m["carrier"] == a["id"]]
    airlines = [_clean_row(a, 3) for a in airlines]

    # ---- routes -----------------------------------------------------------
    alert_counts = {r["route_id"]: r["n"] for r in q(
        "select route_id, count(*) as n from ontology__route_alert group by 1")}
    by_carrier = q("""select route_id, airline_id as id, flights, on_time_share as on_time, mean_arr_delay as mean_arr,
                             cancel_rate from ontology__airline_route order by route_id, flights desc, airline_id""")
    routes = q("""select route_id as id, origin_airport_id as o, dest_airport_id as d, dest_name, flights, cancelled,
                         departed, arrived, cancel_rate, on_time_share as on_time, mean_dep_delay as mean_dep,
                         mean_arr_delay as mean_arr, median_arr_delay as median_arr, p90_arr_delay as p90_arr,
                         days_operated as days, distance_mi as dist, great_circle_mi as gc,
                         median_air_time as air_time, mean_air_recovery as recovery
                  from ontology__route order by flights desc, route_id""")
    for r in routes:
        r["carriers"] = [_clean_row({k: v for k, v in c.items() if k != "route_id"}, 3)
                         for c in by_carrier if c["route_id"] == r["id"]]
        r["alerts"] = alert_counts.get(r["id"], 0)
    _write_lines(APP_DATA / "routes.json", [_clean_row(r, 3) for r in routes])

    # ---- daily series per route (365 values each) -------------------------
    start = date(2013, 1, 1)
    series = {r["id"]: {"id": r["id"], "n": [0] * 365, "c": [0] * 365, "dep": [None] * 365,
                        "arr": [0] * 365, "late": [0] * 365} for r in routes}
    for row in q("""select route_id, flight_date, flights, cancelled, mean_dep_delay, arrived, arr_late
                    from metrics__route_daily"""):
        s, i = series[row["route_id"]], (row["flight_date"] - start).days
        s["n"][i], s["c"][i] = row["flights"], row["cancelled"]
        s["dep"][i] = None if row["mean_dep_delay"] is None else round(row["mean_dep_delay"])
        s["arr"][i], s["late"][i] = row["arrived"], row["arr_late"]
    _write_lines(APP_DATA / "route_daily.json", [series[r["id"]] for r in routes])

    # ---- origin days ------------------------------------------------------
    odays = q("""select origin_day_id as id, airport_id as a, flight_date as date, flights, cancelled, cancel_rate,
                        mean_dep_delay as mean_dep, dep_late_share as late_share, temp_min_f as tmin, temp_max_f as tmax,
                        precip_total_in as precip, visibility_min_mi as vis, wind_max_mph as wind, gust_max_mph as gust,
                        adverse_hours, disruption_z as z, disrupted
                 from ontology__origin_day order by flight_date, airport_id""")
    _write_lines(APP_DATA / "origin_days.json", [_clean_row(o, 3) for o in odays])

    # ---- alerts, each with the flights behind it --------------------------
    alerts = q("""select alert_id as id, alert_type as type, severity as sev, route_id as route, origin as o, dest as d,
                         alert_date as date, period_end as "end", origin_day_id as origin_day, title, summary,
                         flights as n, observed, expected, statistic as stat, statistic_name as stat_name,
                         p_value as p, baseline_center as base_center, baseline_scale as base_scale,
                         baseline_n as base_n, reference_value as ref, streak_weeks as streak,
                         origin_disrupted, wx_visibility_min_mi as wx_vis, wx_gust_max_mph as wx_gust,
                         wx_precip_total_in as wx_precip, base_route as b_route, base_route_month as b_month,
                         base_origin as b_origin, base_all as b_all, eligible_route as elig_r,
                         fired_route as fired_r, eligible_all as elig, fired_all as fired
                  from ontology__route_alert order by alert_date, alert_id""")
    evidence = {}
    for f in q("""select a.alert_id, f.flight_name, f.airline_id, f.tail_number, f.sched_dep_hhmm, f.status,
                         f.dep_delay_min, f.arr_delay_min
                  from ontology__route_alert a join ontology__flight f
                    on f.route_id = a.route_id and f.flight_date = a.alert_date
                  where a.alert_type <> 'chronic_lateness'
                  order by a.alert_id, f.sched_dep_hhmm"""):
        evidence.setdefault(f["alert_id"], []).append(
            [f["flight_name"], f["airline_id"], f["tail_number"], f["sched_dep_hhmm"], f["status"],
             f["dep_delay_min"], f["arr_delay_min"]])
    out = []
    for a in alerts:
        row = {}
        for k, v in a.items():
            if k in ("p", "stat") and isinstance(v, float) and 0 < abs(v) < 1e-3:
                row[k] = float(f"{v:.3g}")
            else:
                row[k] = _clean(v, 4 if k in SHARES else 2)
        row["flights"] = evidence.get(a["id"], [])
        out.append(row)
    _write_lines(APP_DATA / "alerts.json", out)

    # ---- aircraft ---------------------------------------------------------
    aircraft = q("""select aircraft_id as id, airline_id as airline, manufacturer as maker, model, year_built as year,
                           seats, engines, flights, routes, mean_arr_delay as mean_arr, miles_flown as miles
                    from ontology__aircraft order by flights desc, aircraft_id""")
    # 3,322 rows: ship as arrays, with the column names as the first record.
    cols = list(aircraft[0].keys())
    _write_lines(APP_DATA / "aircraft.json", [cols] + [[_clean(a[c], 1) for c in cols] for a in aircraft])

    # ---- baselines for live mode ------------------------------------------
    def table(sql):
        rows = q(sql)
        cols = list(rows[0].keys())
        return {"cols": cols, "rows": [[_clean(r[c], 4) for c in cols] for r in rows]}
    baselines = {
        "origin_month_hour": table("""select origin, month, sched_dep_hour as hour, flights, mean_dep_delay as mean_dep,
                                             dep_late / nullif(departed, 0) as late_share, cancel_rate
                                      from metrics__origin_month_hour order by 1, 2, 3"""),
        "route_month": table("""select route_id as route, month, flights, on_time_share as on_time,
                                       mean_arr_delay as mean_arr, cancel_rate
                                from metrics__route_monthly order by 1, 2"""),
    }
    (APP_DATA / "baselines.json").write_text(json.dumps(baselines, separators=(",", ":")))

    # ---- core: everything small ------------------------------------------
    k = q("""select count(*) as flights, count(*) filter (status = 'cancelled') as cancelled,
                    count(*) filter (status = 'no_arrival') as no_arrival,
                    count(*) filter (status = 'completed') as completed,
                    count(*) filter (status = 'cancelled') / count(*) as cancel_rate,
                    1 - count(*) filter (arr_delay_min >= 15) / count(*) filter (status = 'completed') as on_time,
                    avg(dep_delay_min) as mean_dep, avg(arr_delay_min) as mean_arr,
                    median(arr_delay_min) as median_arr, min(flight_date) as start, max(flight_date) as "end"
             from ontology__flight""")[0]
    checks = [c for d in lineage["datasets"] for c in d["checks"]]
    stats = {
        "hourly": q("""select origin, sched_dep_hour as hour, flights, mean_dep_delay as mean_dep,
                              dep_late / nullif(departed, 0) as late_share, cancel_rate
                       from metrics__hourly_profile order by 1, 2"""),
        "weather": q("""select dimension, bin_order, bin, flights, mean_dep_delay as mean_dep,
                               dep_late / nullif(departed, 0) as late_share, cancel_rate
                        from metrics__weather_delay order by 1, 2"""),
        "week_hour": q("""select day_of_week as dow, sched_dep_hour as hour, flights, mean_dep_delay as mean_dep
                          from metrics__calendar_heat order by 1, 2"""),
        "distance": q("""select distance_group as g, distance_band as band, flights, mean_dep_delay as mean_dep,
                                mean_arr_delay as mean_arr, on_time_share as on_time, mean_air_recovery as recovery
                         from metrics__distance_bands order by 1"""),
        "delay_bands": q("""select dep_delay_group as g, dep_delay_band as band, count(*) as flights
                            from delays__flights where dep_delay_group is not null group by all order by 1"""),
        "delay_severity": q("""select severity, phase, count(*) as delays,
                                      avg(case when adverse_weather_at_origin then 1.0 else 0 end) as adverse_share
                               from ontology__delay group by all order by 1, 2"""),
        "monthly": q("""select month, sum(flights) as flights, sum(cancelled) as cancelled,
                               sum(arr_late) as arr_late, sum(arrived) as arrived
                        from metrics__carrier_monthly group by 1 order by 1"""),
        "worst_flights": q("""select flight_name as flight, airline_id as airline, route_id as route,
                                     flight_date as date, dep_delay_min as dep, arr_delay_min as arr, tail_number as tail
                              from ontology__flight where arr_delay_min is not null
                              order by arr_delay_min desc limit 40"""),
    }
    stats = {name: [_clean_row(r, 3) for r in rows] for name, rows in stats.items()}
    fleet = [_clean_row(r, 1) for r in q(
        """select carrier as airline, manufacturer as maker, model, aircraft, flights, seats,
                  mean_year_built as year from metrics__airline_fleet order by carrier, flights desc""")]
    core = {
        "meta": {
            "name": "Crosswind",
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "US Bureau of Transportation Statistics on-time data for 2013 departures from EWR, JFK "
                      "and LGA, with FAA registry, airport list and NOAA hourly weather, via the nycflights13 package.",
            "kpis": _clean_row(k, 4),
            "counts": {ot["id"]: ot["objects"] for ot in ontology["objectTypes"]},
            "checks": {s: sum(1 for c in checks if c["status"] == s) for s in ("pass", "warn", "fail")},
            "projection": {"lat0": round(lat0, 4), "lon0": round(lon0, 4)},
            "pipeline_seconds": lineage["seconds"],
        },
        "ontology": ontology,
        "lineage": lineage["datasets"],
        "airlines": airlines,
        "fleet": fleet,
        "stats": stats,
    }
    (APP_DATA / "core.json").write_text(json.dumps(core, separators=(",", ":"), ensure_ascii=False))

    sizes = {p.name: p.stat().st_size for p in sorted(APP_DATA.glob("*.json")) if not p.name.startswith("live")}
    print("\napp/data:", ", ".join(f"{n} {s / 1024:.0f} KB" for n, s in sizes.items()),
          f"(total {sum(sizes.values()) / 1e6:.2f} MB)")
