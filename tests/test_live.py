"""Checks for the live job on recorded-shape sample feeds. Run: python tests/test_live.py"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live import feeds                                   # noqa: E402
from live.build import Baselines, build, history_point    # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def test_durations():
    assert feeds.minutes("1 hour and 12 minutes") == 72
    assert feeds.minutes("3 hours and 5 minutes") == 185
    assert feeds.minutes("45 minutes") == 45
    assert feeds.minutes("2 hours") == 120
    assert feeds.minutes(None) is None and feeds.minutes("unknown") is None


def test_flight_category():
    assert feeds.flight_category(10, None) == "VFR"
    assert feeds.flight_category(4, 5000) == "MVFR"
    assert feeds.flight_category(10, 800) == "IFR"
    assert feeds.flight_category(0.5, 2000) == "LIFR"
    assert feeds.flight_category(None, None) is None


def test_parse_faa():
    faa = feeds.parse_faa((FIX / "faa_status.xml").read_bytes())
    assert faa["updated"] == "2026-11-17T15:02:11+00:00"
    by = {(p["airport"], p["kind"]): p for p in faa["programs"]}
    assert len(faa["programs"]) == 6
    assert by[("EWR", "ground_delay")]["avg"] == 72 and by[("EWR", "ground_delay")]["max"] == 185
    assert by[("EWR", "ground_delay")]["cause"] == "weather"
    assert by[("ORD", "ground_stop")]["until"] == "10:45 am CST"
    assert by[("LGA", "departure_delay")]["min"] == 16 and by[("LGA", "departure_delay")]["trend"] == "Increasing"
    assert by[("BOS", "arrival_delay")]["max"] == 45 and by[("BOS", "arrival_delay")]["cause"] == "volume"
    assert ("ZZZ", "closure") in by


def test_parse_metar():
    wx = feeds.parse_metar((FIX / "metar.json").read_bytes())
    assert set(wx) == {"EWR", "JFK", "LGA"}
    assert wx["EWR"]["ceiling_ft"] == 800 and wx["EWR"]["category"] == "IFR" and wx["EWR"]["temp_f"] == 48.0
    assert wx["JFK"]["visibility_mi"] == 10 and wx["JFK"]["category"] == "VFR" and wx["JFK"]["wind_dir"] == "VRB"
    lga = wx["LGA"]                                  # no structured fields: everything comes from the raw text
    assert lga["visibility_mi"] == 1.5 and lga["ceiling_ft"] == 400 and lga["category"] == "LIFR"
    assert round(lga["wind_mph"]) == 21 and round(lga["gust_mph"]) == 33 and lga["temp_f"] == 28.4


def test_build():
    base = Baselines()
    faa = feeds.parse_faa((FIX / "faa_status.xml").read_bytes())
    wx = feeds.parse_metar((FIX / "metar.json").read_bytes())
    now = datetime(2026, 11, 17, 15, 7, tzinfo=timezone.utc)          # 10:07 in New York
    live = build(faa, wx, {}, None, now, base)
    ids = [a["id"] for a in live["alerts"]]
    # ATL's own departure delays and the closure at an airport New York does not serve raise nothing
    assert ids == ["LIVE-ground_delay-EWR", "LIVE-ground_stop-ORD", "LIVE-departure_delay-LGA", "LIVE-arrival_delay-BOS"]
    assert live["local"]["hour"] == 10 and live["local"]["month"] == 11
    ord_alert = live["alerts"][1]
    assert ord_alert["routes"] == ["EWR-ORD", "JFK-ORD", "LGA-ORD"] and ord_alert["sev"] == "high"
    b = ord_alert["baseline"]
    assert 0.5 < b["on_time_year"] < 1 and b["flights_per_day_month"] > 20 and len(b["routes"]) == 3
    assert live["airports"]["EWR"]["status"] == 1 and live["airports"]["JFK"]["status"] == 0
    assert live["airports"]["EWR"]["baseline"]["scope"].startswith("10:00 to 10:59 in Nov")
    assert {w["bin"] for w in live["airports"]["EWR"]["weather_baseline"]} == {"1-3 mi", "10-15 mph", "32-50 F"}
    assert live["status"]["ORD"] == 2 and live["status"]["ZZZ"] == 3
    # first_seen is carried from the previous run
    again = build(faa, wx, {}, live, datetime(2026, 11, 17, 15, 22, tzinfo=timezone.utc), base)
    assert again["alerts"][0]["first_seen"] == live["alerts"][0]["first_seen"] != again["generated"]
    assert history_point(live)["nyc"]["EWR"] == [1, 72]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok ", name)
