"""Build app/data/live.json:  python -m live.build [--site-url URL]

Reads the FAA airport-status feed and current weather, keeps what matters for departures from
Newark, Kennedy and LaGuardia, and sets every live alert beside its 2013 baseline (from the
JSON the archive pipeline already exported). Run every 15 minutes by .github/workflows/live.yml.
"""
from __future__ import annotations

import argparse
import calendar
import json
import sys
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import feeds

APP_DATA = Path(__file__).resolve().parents[1] / "app" / "data"
NYC = ["EWR", "JFK", "LGA"]
EASTERN = ZoneInfo("America/New_York")
HISTORY_DAYS = 7
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
KIND_LABEL = {"closure": "Airport closed", "ground_stop": "Ground stop", "ground_delay": "Ground delay programme",
              "departure_delay": "Departure delays", "arrival_delay": "Arrival delays", "deicing": "De-icing",
              "other": "Traffic programme"}
STATUS_RANK = {"closure": 3, "ground_stop": 2, "ground_delay": 1, "departure_delay": 1, "arrival_delay": 1,
               "deicing": 1, "other": 1}

# The same bins the archive pipeline uses in metrics/weather_delay.
VIS_BINS = [(1, "Under 1 mi"), (3, "1-3 mi"), (6, "3-6 mi"), (10, "6-10 mi"), (1e9, "10 mi (clear)")]
WIND_BINS = [(5, "Under 5 mph"), (10, "5-10 mph"), (15, "10-15 mph"), (20, "15-20 mph"), (25, "20-25 mph"), (1e9, "25 mph and over")]
TEMP_BINS = [(32, "Below freezing"), (50, "32-50 F"), (70, "50-70 F"), (85, "70-85 F"), (1e9, "85 F and over")]


def _load(name):
    return json.loads((APP_DATA / name).read_text())


def _table(t):
    return [dict(zip(t["cols"], row)) for row in t["rows"]]


def _span(lo, hi):
    def fmt(m):
        return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"
    if lo is not None and hi is not None and lo != hi:
        return f"{lo} to {hi} min" if hi < 60 else f"{fmt(lo)} to {fmt(hi)}"
    v = hi if hi is not None else lo
    return fmt(v) if v is not None else None


class Baselines:
    """2013 reference rates, read from the archive pipeline's exports."""

    def __init__(self):
        core, base = _load("core.json"), _load("baselines.json")
        self.routes = {r["id"]: r for r in _load("routes.json")}
        self.airports = {a["id"]: a for a in _load("airports.json")}
        self.kpis = core["meta"]["kpis"]
        self.hourly = {(r["origin"], r["hour"]): r for r in core["stats"]["hourly"]}
        self.weather = {(r["dimension"], r["bin"]): r for r in core["stats"]["weather"]}
        self.omh = {(r["origin"], r["month"], r["hour"]): r for r in _table(base["origin_month_hour"])}
        self.route_month = {(r["route"], r["month"]): r for r in _table(base["route_month"])}
        self.by_dest = {}
        for r in self.routes.values():
            self.by_dest.setdefault(r["d"], []).append(r)

    def origin_now(self, origin, month, hour):
        row = self.omh.get((origin, month, hour))
        if row and row["flights"] >= 60:
            return {**row, "scope": f"{hour}:00 to {hour}:59 in {MONTHS[month - 1]} 2013"}
        row = self.hourly.get((origin, hour))
        if row:
            return {**row, "scope": f"{hour}:00 to {hour}:59 across 2013"}
        return None

    def for_weather(self, obs):
        out = []
        for dim, bins, value in (("Visibility", VIS_BINS, obs.get("visibility_mi")),
                                 ("Wind speed", WIND_BINS, obs.get("wind_mph")),
                                 ("Temperature", TEMP_BINS, obs.get("temp_f"))):
            if value is None:
                continue
            label = next(lab for edge, lab in bins if value < edge)
            row = self.weather.get((dim, label))
            if row:
                out.append({"dimension": dim, "bin": label, "mean_dep": row["mean_dep"], "late_share": row["late_share"],
                            "cancel_rate": row["cancel_rate"], "flights": row["flights"]})
        return out

    def for_routes(self, route_ids, month, year_days):
        rows, tot = [], {"flights": 0, "arrived": 0, "late": 0, "m_flights": 0, "m_late_w": 0.0, "m_w": 0}
        for rid in route_ids:
            r, m = self.routes[rid], self.route_month.get((rid, month))
            rows.append({"route": rid, "flights_year": r["flights"], "on_time_year": r["on_time"], "mean_arr_year": r["mean_arr"],
                         "cancel_rate_year": r["cancel_rate"], "alerts_2013": r["alerts"],
                         "flights_month": m["flights"] if m else 0, "on_time_month": m["on_time"] if m else None,
                         "mean_arr_month": m["mean_arr"] if m else None})
            tot["flights"] += r["flights"]; tot["arrived"] += r["arrived"]; tot["late"] += r["arrived"] * (1 - r["on_time"])
            if m and m["on_time"] is not None:
                tot["m_flights"] += m["flights"]; tot["m_late_w"] += m["flights"] * m["on_time"]; tot["m_w"] += m["flights"]
        return {"routes": rows,
                "on_time_year": 1 - tot["late"] / tot["arrived"] if tot["arrived"] else None,
                "on_time_month": tot["m_late_w"] / tot["m_w"] if tot["m_w"] else None,
                "flights_per_day_month": round(tot["m_flights"] / year_days, 1) if tot["m_flights"] else 0,
                "all_flights_on_time": self.kpis["on_time"]}


def _severity(p, scope):
    k = p["kind"]
    worst = next((v for v in ((p["avg"], p["max"], p["min"]) if k == "ground_delay" else (p["max"], p["min"], p["avg"])) if v is not None), 0)
    if k == "closure":
        return "critical"
    if k == "ground_stop":
        return "critical" if scope == "origin" else "high"
    if k in ("ground_delay", "departure_delay"):
        return "critical" if worst >= 120 else "high" if worst >= 45 else "medium"
    return "high" if worst >= 60 else "medium"


def _summary(p, scope, routes):
    a, reason = p["airport"], f" Reason given: {p['reason']}." if p["reason"] else ""
    span, until = _span(p["min"], p["max"]), f" until {p['until']}" if p["until"] else ""
    trend = f", {p['trend'].lower()}" if p.get("trend") else ""
    to = f"Flights from {', '.join(r.split('-')[0] for r in routes)} to {a}"
    if p["kind"] == "closure":
        return (f"{a} is closed{until}.{reason}" if scope == "origin" else f"{a} is closed{until}. {to} cannot land there.{reason}")
    if p["kind"] == "ground_stop":
        return (f"Flights bound for {a} are being held at their origins{until}, so inbound aircraft and the departures that depend on them will run late.{reason}"
                if scope == "origin" else f"{to} are being held at the gate{until}.{reason}")
    if p["kind"] == "ground_delay":
        avg = f"averaging {_span(None, p['avg'])}" if p["avg"] is not None else "of unstated length"
        mx = f" (up to {_span(None, p['max'])})" if p["max"] is not None else ""
        return (f"Arrivals into {a} are being metered with delays {avg}{mx}; late inbound aircraft push departures back.{reason}"
                if scope == "origin" else f"{to} are being assigned departure delays {avg}{mx}.{reason}")
    if p["kind"] == "departure_delay":
        return f"Departures from {a} are running {span or 'late'} behind{trend}.{reason}"
    if p["kind"] == "arrival_delay":
        return (f"Arrivals into {a} are delayed {span or 'by an unstated amount'}{trend}.{reason}" if scope == "origin"
                else f"{to} face arrival delays of {span or 'unstated length'} at {a}{trend}.{reason}")
    return f"{KIND_LABEL.get(p['kind'], 'A traffic programme')} is in effect at {a}.{reason}"


def build(faa: dict, metar: dict, feed_state: dict, prev: dict | None, now: datetime, base: Baselines) -> dict:
    local = now.astimezone(EASTERN)
    month, hour = local.month, local.hour
    days = calendar.monthrange(2013, month)[1]
    first_seen = {a["id"]: a["first_seen"] for a in (prev or {}).get("alerts", [])}
    stamp = now.astimezone(timezone.utc).isoformat(timespec="seconds")

    programs, alerts, status = faa["programs"], [], {}
    for p in programs:
        status[p["airport"]] = max(status.get(p["airport"], 0), STATUS_RANK.get(p["kind"], 1))
        a = p["airport"]
        if a in NYC:
            scope, routes = "origin", []
        elif a in base.by_dest and p["kind"] != "departure_delay":      # a destination's own departure delays do not hold New York flights
            scope, routes = "destination", sorted(r["id"] for r in base.by_dest[a])
        else:
            continue
        aid = f"LIVE-{p['kind']}-{a}"
        alert = {
            "id": aid, "kind": p["kind"], "label": KIND_LABEL.get(p["kind"], "Traffic programme"), "scope": scope, "airport": a,
            "airport_name": base.airports.get(a, {}).get("name", a), "sev": _severity(p, scope), "routes": routes,
            "reason": p["reason"], "cause": p["cause"], "min": p["min"], "max": p["max"], "avg": p["avg"], "trend": p["trend"],
            "until": p["until"], "first_seen": first_seen.get(aid, stamp), "summary": _summary(p, scope, routes),
        }
        if scope == "destination":
            alert["baseline"] = base.for_routes(routes, month, days)
            alert["baseline"]["month"] = MONTHS[month - 1]
        else:
            alert["baseline"] = {"now": base.origin_now(a, month, hour)}
        alerts.append(alert)
    order = {"critical": 0, "high": 1, "medium": 2}
    alerts.sort(key=lambda x: (order[x["sev"]], x["scope"] != "origin", x["airport"]))

    airports = {}
    for o in NYC:
        obs = metar.get(o)
        airports[o] = {
            "name": base.airports[o]["name"], "status": status.get(o, 0),
            "programs": [{"kind": p["kind"], "label": KIND_LABEL.get(p["kind"], "Traffic programme"), "reason": p["reason"],
                          "span": _span(p["min"], p["max"]), "avg": p["avg"], "trend": p["trend"], "until": p["until"]}
                         for p in programs if p["airport"] == o],
            "weather": obs, "baseline": base.origin_now(o, month, hour),
            "weather_baseline": base.for_weather(obs) if obs else [],
        }
    return {
        "generated": stamp,
        "local": {"label": local.strftime("%a %-d %b, %H:%M") + " ET", "month": month, "hour": hour},
        "feeds": feed_state, "faa_updated": faa.get("updated"),
        "programs_total": len(programs), "program_types": faa.get("types", {}),
        "watched_destinations": len(base.by_dest), "status": status, "airports": airports, "alerts": alerts,
        "all_flights": {"on_time": base.kpis["on_time"], "mean_dep": base.kpis["mean_dep"], "cancel_rate": base.kpis["cancel_rate"]},
    }


def history_point(live: dict) -> dict:
    nyc = {}
    for o, a in live["airports"].items():
        worst = max([p["avg"] or 0 for p in a["programs"]] + [0])
        nyc[o] = [a["status"], worst]
    return {"t": live["generated"], "programs": live["programs_total"], "alerts": len(live["alerts"]),
            "origin_alerts": sum(1 for a in live["alerts"] if a["scope"] == "origin"), "nyc": nyc}


def _previous(site_url: str | None, name: str):
    """The last published copy of a data file: from the live site if given, else from disk."""
    if site_url:
        try:
            return json.loads(feeds.http_get(f"{site_url.rstrip('/')}/data/{name}", timeout=15))
        except (urllib.error.URLError, ValueError, TimeoutError, OSError):
            return None
    path = APP_DATA / name
    return json.loads(path.read_text()) if path.exists() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--site-url", help="published site, used to carry history across runs")
    ap.add_argument("--faa-file", help="read the FAA feed from a file instead of the network")
    ap.add_argument("--metar-file", help="read the METAR feed from a file instead of the network")
    ap.add_argument("--now", help="ISO time to treat as now (for tests)")
    args = ap.parse_args(argv)
    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    prev = _previous(args.site_url, "live.json")
    history = _previous(args.site_url, "live_history.json") or []
    APP_DATA.mkdir(parents=True, exist_ok=True)

    state = {}
    def read(name, url, file, parse, raw_name):
        try:
            raw = Path(file).read_bytes() if file else feeds.http_get(url)
            (APP_DATA / raw_name).write_bytes(raw)          # keep the raw payload beside the page for debugging
            parsed = parse(raw)
            state[name] = {"ok": True, "bytes": len(raw), "url": url, "error": None}
            return parsed
        except Exception as err:                             # noqa: BLE001  (a bad feed must not stop the deploy)
            state[name] = {"ok": False, "bytes": 0, "url": url, "error": f"{type(err).__name__}: {err}"[:300]}
            return None

    faa = read("faa", feeds.FAA_URL, args.faa_file, feeds.parse_faa, "live_faa.xml")
    metar = read("metar", feeds.METAR_URL.format(ids=",".join("K" + o for o in NYC)), args.metar_file, feeds.parse_metar, "live_metar.json")
    state["faa"]["items"] = len(faa["programs"]) if faa else 0
    state["metar"]["items"] = len(metar) if metar else 0

    if faa is None and prev and prev.get("alerts") is not None:
        # Keep the last good picture on screen, clearly marked as stale, rather than showing an empty board.
        live = {**prev, "feeds": {**prev.get("feeds", {}), "faa": state["faa"], "metar": state["metar"]},
                "stale_since": prev.get("stale_since") or prev["generated"], "checked": now.isoformat(timespec="seconds")}
    else:
        live = build(faa or {"programs": [], "updated": None, "types": {}}, metar or {}, state, prev, now, Baselines())
        cutoff = (now - timedelta(days=HISTORY_DAYS)).astimezone(timezone.utc).isoformat(timespec="seconds")
        if faa is not None:
            history = [h for h in history if h.get("t", "") >= cutoff] + [history_point(live)]
    (APP_DATA / "live.json").write_text(json.dumps(live, separators=(",", ":")))
    (APP_DATA / "live_history.json").write_text(json.dumps(history, separators=(",", ":")))
    print(f"live.json: {len(live.get('alerts', []))} alerts from {live.get('programs_total', 0)} FAA programmes; "
          f"feeds: " + ", ".join(f"{k} {'ok' if v['ok'] else 'FAILED ' + str(v['error'])}" for k, v in state.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
