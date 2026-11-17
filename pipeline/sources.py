"""Locate the source files.

Flight, airline, airport, aircraft and weather data come from the
`nycflights13` package: the US Bureau of Transportation Statistics on-time
records for every 2013 departure from Newark (EWR), Kennedy (JFK) and
LaGuardia (LGA), with the FAA aircraft registry, openflights.org airports and
hourly NOAA weather at the three airports. The files are read straight from
the installed package without importing it.
"""
from __future__ import annotations

import importlib.util
import shutil
import zipfile
from pathlib import Path

from .dag import DATA, ROOT

REFERENCE = ROOT / "reference"
SOURCE = DATA / "_source"


def prepare() -> Path:
    spec = importlib.util.find_spec("nycflights13")
    if spec is None or not spec.origin:
        raise SystemExit("nycflights13 is not installed: pip install -r requirements.txt")
    pkg = Path(spec.origin).parent / "data"
    SOURCE.mkdir(parents=True, exist_ok=True)
    if not (SOURCE / "flights.csv").exists():
        with zipfile.ZipFile(pkg / "flights.csv.zip") as z:
            z.extract("flights.csv", SOURCE)
    for name in ("airlines", "airports", "planes", "weather"):
        if not (SOURCE / f"{name}.csv").exists():
            shutil.copy(pkg / f"{name}.csv", SOURCE / f"{name}.csv")
    return SOURCE


def csv(path: Path) -> str:
    """Raw datasets keep every column as text; typing happens in the clean layer."""
    return f"read_csv('{path}', all_varchar=true, header=true)"
