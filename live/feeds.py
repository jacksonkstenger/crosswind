"""Fetch and parse the two live feeds. Standard library only, so the scheduled job needs no installs.

FAA NAS status: the official feed behind nasstatus.faa.gov. XML, no key, lists every airport
with an active traffic-management programme (ground stop, ground delay programme, arrival or
departure delays, closure).

Aviation Weather Center: current METAR observations as JSON, no key.

Both parsers are deliberately tolerant: tag and field names are matched case-insensitively and
missing fields become None, because a schema change should degrade one field, not the whole page.
"""
from __future__ import annotations

import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

FAA_URL = "https://nasstatus.faa.gov/api/airport-status-information"
METAR_URL = "https://aviationweather.gov/api/data/metar?ids={ids}&format=json"
USER_AGENT = "crosswind-live/1.0 (https://github.com/jacksonkstenger/crosswind)"

KNOT_TO_MPH = 1.150779


def http_get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# ------------------------------------------------------------------ FAA ----

_DURATION = re.compile(r"(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b", re.I)


def minutes(text: str | None) -> int | None:
    """'1 hour and 12 minutes' -> 72, '45 minutes' -> 45, None when there is no duration."""
    if not text:
        return None
    parts = _DURATION.findall(text)
    if not parts:
        return int(text) if text.strip().isdigit() else None
    return sum(int(n) * (60 if unit.lower().startswith("h") else 1) for n, unit in parts)


def cause(reason: str) -> str:
    r = reason.lower()
    if re.search(r"\bwx\b|weather|thunder|wind|snow|ice|icing|fog|ceiling|visib|rain|storm", r):
        return "weather"
    if re.search(r"\bvol\b|volume|compacted demand|demand", r):
        return "volume"
    if re.search(r"\brwy\b|runway|construction|taxiway", r):
        return "runway"
    if re.search(r"staff", r):
        return "staffing"
    if re.search(r"equip|outage|radar|frequency", r):
        return "equipment"
    return "other"


def _kind(type_name: str) -> str | None:
    n = type_name.lower()
    if "ground stop" in n:
        return "ground_stop"
    if "ground delay" in n:
        return "ground_delay"
    if "closure" in n:
        return "closure"
    if "deic" in n:
        return "deicing"
    if "arrival" in n or "departure" in n or "general" in n:
        return "arrival_departure"
    return None


def parse_faa(xml_bytes: bytes) -> dict:
    """Returns {'updated': ISO time or None, 'programs': [...], 'types': {type name: entries}}."""
    root = ET.fromstring(xml_bytes)
    low = lambda e: e.tag.rsplit("}", 1)[-1].lower()
    parent = {child: p for p in root.iter() for child in p}

    def text(e, name):
        for c in e:
            if low(c) == name:
                return (c.text or "").strip() or None
        return None

    updated = None
    for e in root.iter():
        if low(e) == "update_time" and e.text:
            raw = e.text.strip()
            for fmt in ("%a %b %d %H:%M:%S %Y GMT", "%a %b %d %H:%M:%S %Y %Z"):
                try:
                    updated = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
                    break
                except ValueError:
                    updated = raw
            break

    programs, types = [], {}
    for entry in root.iter():
        airport = text(entry, "arpt")
        if not airport:
            continue
        node, type_name = entry, ""
        while node in parent:                       # climb to the enclosing <Delay_type> and read its <Name>
            node = parent[node]
            if low(node) == "delay_type":
                type_name = text(node, "name") or ""
                break
        kind = _kind(type_name) or _kind(low(entry).replace("_", " ")) or "other"
        types[type_name or kind] = types.get(type_name or kind, 0) + 1
        reason = re.sub(r"\s+", " ", text(entry, "reason") or "").strip()
        common = {"airport": airport.upper()[-3:], "reason": reason, "cause": cause(reason), "type_name": type_name}
        if kind == "arrival_departure":
            subs = [c for c in entry if low(c) == "arrival_departure"] or [entry]
            for sub in subs:
                which = (sub.get("Type") or sub.get("type") or "departure").lower()
                programs.append({**common, "kind": "arrival_delay" if which.startswith("arr") else "departure_delay",
                                 "min": minutes(text(sub, "min")), "max": minutes(text(sub, "max")), "avg": None,
                                 "trend": text(sub, "trend"), "until": None, "start": None})
        else:
            programs.append({**common, "kind": kind, "min": minutes(text(entry, "min")), "max": minutes(text(entry, "max")),
                             "avg": minutes(text(entry, "avg")), "trend": text(entry, "trend"),
                             "until": text(entry, "end_time") or text(entry, "reopen"), "start": text(entry, "start")})
    return {"updated": updated, "programs": programs, "types": types}


# ---------------------------------------------------------------- METAR ----

_RAW_WIND = re.compile(r"\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b")
_RAW_VIS = re.compile(r"\b(?:(\d+) )?(\d+)(?:/(\d+))?SM\b")
_RAW_TEMP = re.compile(r"\b(M?\d{2})/(M?\d{2})?\b")
_RAW_CLOUD = re.compile(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b")


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().rstrip("+")
    try:
        if " " in s and "/" in s:                    # "1 1/2"
            whole, frac = s.split(" ", 1)
            a, b = frac.split("/")
            return float(whole) + float(a) / float(b)
        if "/" in s:
            a, b = s.split("/")
            return float(a) / float(b)
        return float(s)
    except (ValueError, ZeroDivisionError):
        return None


def flight_category(vis_mi: float | None, ceiling_ft: float | None) -> str | None:
    """FAA flight categories from visibility and ceiling (lowest broken or overcast layer)."""
    if vis_mi is None and ceiling_ft is None:
        return None
    v = 99 if vis_mi is None else vis_mi
    c = 99999 if ceiling_ft is None else ceiling_ft
    if v < 1 or c < 500:
        return "LIFR"
    if v < 3 or c < 1000:
        return "IFR"
    if v <= 5 or c <= 3000:
        return "MVFR"
    return "VFR"


def parse_metar(json_bytes: bytes) -> dict:
    """Returns {airport code: observation}. Structured fields first, the raw text as a fallback."""
    data = json.loads(json_bytes)
    if isinstance(data, dict):
        data = data.get("data") or data.get("features") or [data]
    out = {}
    for rec in data:
        if not isinstance(rec, dict):
            continue
        rec = {**rec.get("properties", {}), **rec} if "properties" in rec else rec
        get = lambda *names: next((rec[n] for n in names if rec.get(n) not in (None, "")), None)
        icao = str(get("icaoId", "station_id", "id") or "").upper()
        if not icao:
            continue
        raw = get("rawOb", "raw_text", "rawText") or ""
        temp_c, wdir, wspd, wgst = _num(get("temp", "temp_c")), get("wdir", "wind_dir_degrees"), _num(get("wspd", "wind_speed_kt")), _num(get("wgst", "wind_gust_kt"))
        vis = _num(get("visib", "visibility_statute_mi"))
        clouds = [(str(c.get("cover", "")).upper(), _num(c.get("base"))) for c in (rec.get("clouds") or []) if isinstance(c, dict)]
        if raw:
            if wspd is None and (m := _RAW_WIND.search(raw)):
                wdir, wspd, wgst = m.group(1), float(m.group(2)), float(m.group(3)) if m.group(3) else None
            if vis is None and (m := _RAW_VIS.search(raw)):
                vis = (float(m.group(1)) if m.group(1) else 0.0) + float(m.group(2)) / float(m.group(3) or 1)
            if temp_c is None and (m := _RAW_TEMP.search(raw)):
                temp_c = float(m.group(1).replace("M", "-"))
            if not clouds:
                clouds = [(c, float(h) * 100) for c, h in _RAW_CLOUD.findall(raw)]
        ceilings = [b for cover, b in clouds if cover in ("BKN", "OVC", "OVX", "VV") and b is not None]
        ceiling = min(ceilings) if ceilings else None
        obs = get("obsTime", "observation_time", "reportTime")
        if isinstance(obs, (int, float)):
            obs = datetime.fromtimestamp(obs, timezone.utc).isoformat(timespec="minutes")
        out[icao[-3:]] = {
            "observed": obs, "raw": raw or None,
            "temp_f": None if temp_c is None else round(temp_c * 9 / 5 + 32, 1),
            "wind_dir": None if wdir in (None, "") else str(wdir),
            "wind_mph": None if wspd is None else round(wspd * KNOT_TO_MPH, 1),
            "gust_mph": None if wgst is None else round(wgst * KNOT_TO_MPH, 1),
            "visibility_mi": vis, "ceiling_ft": ceiling,
            "weather": get("wxString", "wx_string"),
            "category": flight_category(vis, ceiling),
        }
    return out
