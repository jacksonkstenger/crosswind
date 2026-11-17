"""Route alert detectors.

Three detectors run over the daily route metrics. Each is a stated statistical
rule, so every alert can show the numbers that triggered it.

1. Delay spike (daily, robust z).
   For route r on day d, let x be the mean departure delay of r's flights minus
   the mean departure delay of all *other* flights from the same origin that day.
   Subtracting the rest of the airport removes airport-wide bad days (storms,
   ground stops), leaving the part specific to the route. The baseline is the
   same quantity for r over the previous 28 days:
       z = (x - median) / max(1.4826 * MAD, 5 min)
   1.4826 * MAD estimates the standard deviation consistently for Gaussian data
   and is unaffected by the heavy right tail of delays. Alert when z >= 4, the
   excess over baseline is >= 30 min, the route's own mean delay is >= 30 min
   and at least 60% of its departures left 15+ minutes late. The last condition
   demands breadth: one six-hour delay among five flights is not a route problem.

2. Cancellation cluster (daily, exact binomial test with FDR control).
   With c of n scheduled flights cancelled, test H0: each flight is cancelled
   independently with probability p0, where p0 is the larger of the route's
   own 56-day rate (smoothed as (C + 1/2) / (N + 1)) and the cancellation rate
   of the rest of the origin that day. The p-value is P[Bin(n, p0) >= c].
   All route-days with n >= 3 form one family; Benjamini-Hochberg at q = 0.05
   bounds the expected share of false alerts at 5%. Alert when rejected and c >= 2.

3. Chronic lateness (weekly, Wilson interval).
   With k of n arrivals in a calendar week at least 15 minutes late, alert when
   the lower end of the 95% Wilson score interval for k/n exceeds 1/2: more
   than half the route's flights were late, beyond what sampling noise explains.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import timedelta
from statistics import median

import pyarrow as pa

from .dag import dataset, scalar

ALERTING = "Alerting"
DETECTOR_VERSION = "1.0"

SPIKE_MIN_DEPARTED = 5
SPIKE_BASELINE_DAYS = 28
SPIKE_MIN_BASELINE = 10
SPIKE_SCALE_FLOOR = 5.0
SPIKE_Z = 4.0
SPIKE_MIN_EXCESS = 30.0
SPIKE_MIN_LATE_SHARE = 0.6

CANCEL_MIN_SCHEDULED = 3
CANCEL_BASELINE_DAYS = 56
CANCEL_FDR_Q = 0.05
CANCEL_MIN_COUNT = 2

CHRONIC_MIN_ARRIVALS = 15
CHRONIC_Z = 1.959963984540054       # two-sided 95%
CHRONIC_THRESHOLD = 0.5


def binom_sf(c: int, n: int, p: float) -> float:
    """P[Bin(n, p) >= c], summed exactly."""
    if c <= 0:
        return 1.0
    if p >= 1.0:
        return 1.0
    return min(1.0, sum(math.comb(n, k) * p**k * (1 - p)**(n - k) for k in range(c, n + 1)))


def wilson_lower(k: int, n: int, z: float) -> float:
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def benjamini_hochberg(pvals: list[float], q: float) -> tuple[list[bool], list[float]]:
    """Returns (rejected, adjusted p) in the input order."""
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [1.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, pvals[i] * m / rank)
        adj[i] = running
    return [a <= q for a in adj], adj


_SUP = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


def _p(v: float) -> str:
    """0.026, or 9.3 × 10⁻⁶ for small values."""
    if v >= 0.001:
        return f"{v:.3f}"
    mant, exp = f"{v:.1e}".split("e")
    return f"{mant} × 10{str(int(exp)).translate(_SUP)}"


def _signed(v: float) -> str:
    r = round(v)
    return "0" if r == 0 else f"{r:+d}"


def _day(d) -> str:
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}"


@dataset("alerts/route_alerts", group=ALERTING, layer="alerts",
         inputs=["metrics/route_daily", "metrics/origin_daily"], pk=["alert_id"],
         checks=[scalar("alert volume is reviewable", "select count(*) from {t}",
                        lambda v: 100 <= v <= 2500, "between 100 and 2,500 alerts for the year", warn_only=True),
                 scalar("severity is set", "select count(*) from {t} where severity not in ('medium','high','critical')",
                        lambda v: v == 0, "0 rows")],
         description="Alerts raised by three detectors: route-specific delay spikes, cancellation clusters and chronically late weeks.")
def route_alerts(ctx):
    cols = ["route_id", "origin", "dest", "flight_date", "week_start", "flights", "cancelled",
            "departed", "arrived", "arr_late", "dep_late", "sum_dep_delay"]
    rd = [dict(zip(cols, r)) for r in ctx.q(
        f"select {', '.join(cols)} from metrics__route_daily order by route_id, flight_date")]
    ocols = ["origin", "flight_date", "flights", "cancelled", "departed", "sum_dep_delay", "disrupted",
             "visibility_min_mi", "gust_max_mph", "precip_total_in"]
    od = {(r[0], r[1]): dict(zip(ocols, r)) for r in ctx.q(
        f"select {', '.join(ocols)} from metrics__origin_daily")}

    by_route = defaultdict(dict)
    for r in rd:
        by_route[r["route_id"]][r["flight_date"]] = r

    alerts = []

    # Baseline rates: the alerted metric for the route (year and month), its origin and all flights.
    def acc():
        return {"flights": 0, "cancelled": 0, "departed": 0, "arrived": 0, "arr_late": 0, "sum_dep": 0}
    totals = defaultdict(acc)
    for r in rd:
        for key in (("route", r["route_id"]), ("month", r["route_id"], r["flight_date"].month), ("origin", r["origin"]), ("all",)):
            t = totals[key]
            for f in ("flights", "cancelled", "departed", "arrived", "arr_late"):
                t[f] += r[f]
            t["sum_dep"] += r["sum_dep_delay"] or 0
    rate = {
        "delay_spike": lambda t: t["sum_dep"] / t["departed"] if t["departed"] else None,
        "cancellation_cluster": lambda t: t["cancelled"] / t["flights"] if t["flights"] else None,
        "chronic_lateness": lambda t: t["arr_late"] / t["arrived"] if t["arrived"] else None,
    }
    eligible = defaultdict(int)      # how many route-days (or route-weeks) each detector examined

    def base(kind, code, r, date, period_end, daily=True):
        o = od.get((r["origin"], date), {}) if daily else {}
        return {
            "base_route": rate[kind](totals[("route", r["route_id"])]),
            "base_route_month": rate[kind](totals[("month", r["route_id"], date.month)]),
            "base_origin": rate[kind](totals[("origin", r["origin"])]),
            "base_all": rate[kind](totals[("all",)]),
            "alert_id": f"RA-{code}-{r['route_id']}-{date.strftime('%Y%m%d')}",
            "alert_type": kind, "route_id": r["route_id"], "origin": r["origin"], "dest": r["dest"],
            "alert_date": date, "period_end": period_end,
            "origin_day_id": f"{r['origin']}_{date.isoformat()}" if daily else None,
            "origin_disrupted": bool(o.get("disrupted")) if daily else None,
            "wx_visibility_min_mi": o.get("visibility_min_mi"), "wx_gust_max_mph": o.get("gust_max_mph"),
            "wx_precip_total_in": o.get("precip_total_in"),
            "p_value": None, "streak_weeks": None, "detector_version": DETECTOR_VERSION,
        }

    # -- 1. delay spikes ---------------------------------------------------
    for route, days in by_route.items():
        excess = {}
        for date, r in days.items():
            if r["departed"] < SPIKE_MIN_DEPARTED or r["sum_dep_delay"] is None:
                continue
            o = od[(r["origin"], date)]
            rest_n = o["departed"] - r["departed"]
            if rest_n <= 0:
                continue
            route_mean = r["sum_dep_delay"] / r["departed"]
            rest_mean = (o["sum_dep_delay"] - r["sum_dep_delay"]) / rest_n
            excess[date] = (route_mean - rest_mean, route_mean, rest_mean)
        for date, (x, route_mean, rest_mean) in excess.items():
            hist = [excess[date - timedelta(days=k)][0] for k in range(1, SPIKE_BASELINE_DAYS + 1)
                    if date - timedelta(days=k) in excess]
            if len(hist) < SPIKE_MIN_BASELINE:
                continue
            eligible[("delay_spike", route)] += 1
            eligible[("delay_spike",)] += 1
            med = median(hist)
            mad = median(abs(h - med) for h in hist)
            scale = max(1.4826 * mad, SPIKE_SCALE_FLOOR)
            z = (x - med) / scale
            r = days[date]
            late_share = r["dep_late"] / r["departed"]
            if (z >= SPIKE_Z and x - med >= SPIKE_MIN_EXCESS and route_mean >= SPIKE_MIN_EXCESS
                    and late_share >= SPIKE_MIN_LATE_SHARE):
                sev = "critical" if x - med >= 120 else "high" if x - med >= 75 else "medium"
                a = base("delay_spike", "DS", r, date, date)
                a.update({
                    "severity": sev, "flights": r["departed"],
                    "title": f"{r['origin']} → {r['dest']} delay spike",
                    "summary": (f"{r['departed']} departures averaged {route_mean:.0f} min late on {_day(date)} "
                                f"({r['dep_late']} left 15+ min late), "
                                f"{x:.0f} min worse than the rest of {r['origin']} that day. "
                                f"The route's usual gap is {_signed(med)} min (robust z = {z:.1f})."),
                    "observed": route_mean, "expected": rest_mean + med, "statistic": z,
                    "statistic_name": "robust z",
                    "baseline_center": med, "baseline_scale": scale, "baseline_n": len(hist),
                    "reference_value": rest_mean,
                })
                alerts.append(a)

    # -- 2. cancellation clusters -----------------------------------------
    tests = []
    for route, days in by_route.items():
        for date, r in days.items():
            n, c = r["flights"], r["cancelled"]
            if n < CANCEL_MIN_SCHEDULED:
                continue
            C = N = 0
            for k in range(1, CANCEL_BASELINE_DAYS + 1):
                h = days.get(date - timedelta(days=k))
                if h:
                    C += h["cancelled"]
                    N += h["flights"]
            p_route = (C + 0.5) / (N + 1)
            o = od[(r["origin"], date)]
            rest_n = o["flights"] - n
            p_origin = (o["cancelled"] - c) / rest_n if rest_n > 0 else 0.0
            p0 = max(p_route, p_origin)
            eligible[("cancellation_cluster", route)] += 1
            eligible[("cancellation_cluster",)] += 1
            tests.append((binom_sf(c, n, p0), r, date, p0, p_route, p_origin, N))
    rejected, adjusted = benjamini_hochberg([t[0] for t in tests], CANCEL_FDR_Q)
    for (pval, r, date, p0, p_route, p_origin, N), rej, adj in zip(tests, rejected, adjusted):
        n, c = r["flights"], r["cancelled"]
        if not rej or c < CANCEL_MIN_COUNT:
            continue
        share = c / n
        sev = "critical" if c >= 6 and share >= 0.6 else "high" if c >= 4 or share >= 0.5 else "medium"
        which = "the route's 56-day rate" if p_route >= p_origin else f"the rest of {r['origin']} that day"
        a = base("cancellation_cluster", "CC", r, date, date)
        a.update({
            "severity": sev, "flights": n,
            "title": f"{r['origin']} → {r['dest']} cancellation cluster",
            "summary": (f"{c} of {n} scheduled flights were cancelled on {_day(date)} ({share:.0%}). "
                        f"Expected rate {p0:.1%}, from {which}. "
                        f"Binomial tail p = {_p(pval)} ({_p(adj)} after FDR adjustment)."),
            "observed": share, "expected": p0, "statistic": adj, "statistic_name": "BH-adjusted p",
            "p_value": pval, "baseline_center": p_route, "baseline_scale": None, "baseline_n": N,
            "reference_value": p_origin,
        })
        alerts.append(a)

    # -- 3. chronic lateness ----------------------------------------------
    weeks = defaultdict(lambda: {"n": 0, "k": 0, "row": None})
    for r in rd:
        w = weeks[(r["route_id"], r["week_start"])]
        w["n"] += r["arrived"]
        w["k"] += r["arr_late"]
        w["row"] = r
    flagged = {}
    for (route, ws), w in weeks.items():
        if w["n"] >= CHRONIC_MIN_ARRIVALS:
            eligible[("chronic_lateness", route)] += 1
            eligible[("chronic_lateness",)] += 1
            lb = wilson_lower(w["k"], w["n"], CHRONIC_Z)
            if lb > CHRONIC_THRESHOLD:
                flagged[(route, ws)] = (lb, w)
    for (route, ws), (lb, w) in sorted(flagged.items()):
        streak = 1
        while (route, ws - timedelta(days=7 * streak)) in flagged:
            streak += 1
        r, n, k = w["row"], w["n"], w["k"]
        sev = "critical" if lb >= 0.7 else "high" if lb >= 0.6 or streak >= 3 else "medium"
        end = ws + timedelta(days=6)
        run = "" if streak == 1 else f" Week {streak} in a row."
        a = base("chronic_lateness", "CL", r, ws, end, daily=False)
        a.update({
            "severity": sev, "flights": n,
            "title": f"{r['origin']} → {r['dest']} chronically late week",
            "summary": (f"{k} of {n} arrivals ({k / n:.0%}) were at least 15 min late in the week of {_day(ws)}. "
                        f"The 95% Wilson lower bound is {lb:.0%}, above one half.{run}"),
            "observed": k / n, "expected": CHRONIC_THRESHOLD, "statistic": lb,
            "statistic_name": "Wilson 95% lower bound", "streak_weeks": streak,
            "baseline_center": None, "baseline_scale": None, "baseline_n": n, "reference_value": None,
        })
        alerts.append(a)

    fired = defaultdict(int)
    for a in alerts:
        fired[(a["alert_type"], a["route_id"])] += 1
        fired[(a["alert_type"],)] += 1
    for a in alerts:
        k = a["alert_type"]
        a.update(eligible_route=eligible[(k, a["route_id"])], fired_route=fired[(k, a["route_id"])],
                 eligible_all=eligible[(k,)], fired_all=fired[(k,)])
    alerts.sort(key=lambda a: (a["alert_date"], a["alert_id"]))
    schema = pa.schema([
        ("alert_id", pa.string()), ("alert_type", pa.string()), ("severity", pa.string()),
        ("route_id", pa.string()), ("origin", pa.string()), ("dest", pa.string()),
        ("alert_date", pa.date32()), ("period_end", pa.date32()), ("origin_day_id", pa.string()),
        ("title", pa.string()), ("summary", pa.string()), ("flights", pa.int32()),
        ("observed", pa.float64()), ("expected", pa.float64()), ("statistic", pa.float64()),
        ("statistic_name", pa.string()), ("p_value", pa.float64()),
        ("baseline_center", pa.float64()), ("baseline_scale", pa.float64()), ("baseline_n", pa.int32()),
        ("reference_value", pa.float64()), ("streak_weeks", pa.int32()),
        ("origin_disrupted", pa.bool_()), ("wx_visibility_min_mi", pa.float64()),
        ("wx_gust_max_mph", pa.float64()), ("wx_precip_total_in", pa.float64()),
        ("base_route", pa.float64()), ("base_route_month", pa.float64()), ("base_origin", pa.float64()),
        ("base_all", pa.float64()), ("eligible_route", pa.int32()), ("fired_route", pa.int32()),
        ("eligible_all", pa.int32()), ("fired_all", pa.int32()),
        ("detector_version", pa.string()),
    ])
    table = pa.Table.from_pylist(alerts, schema=schema)
    ctx.register("tmp_route_alerts", table)
    return "select * from tmp_route_alerts"
