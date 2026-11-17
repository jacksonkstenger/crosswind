"""A very small dataset DAG.

Each dataset declares its inputs, a builder that returns one SQL query, and
optional health checks. The runner executes datasets in declaration order,
materialises every one as a Parquet file, verifies that the SQL touches
exactly the declared inputs (so the lineage graph cannot drift from the
code), runs the checks and writes the lineage to data/_meta/lineage.json.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
META = DATA / "_meta"


def view(name: str) -> str:
    """Dataset 'clean/flights' is queried as the view clean__flights."""
    return name.replace("/", "__")


@dataclass
class Dataset:
    name: str
    group: str            # the "project" a dataset belongs to
    layer: str            # raw | clean | processed | enriched | transform | metrics | alerts | ontology
    inputs: tuple[str, ...]
    build: Callable[["Context"], str]
    description: str = ""
    pk: tuple[str, ...] = ()
    checks: tuple = ()
    source: str = ""      # provenance note, raw datasets only


REGISTRY: dict[str, Dataset] = {}


def dataset(name, *, group, layer, inputs=(), pk=(), checks=(), description="", source=""):
    def deco(fn):
        if name in REGISTRY:
            raise ValueError(f"duplicate dataset {name}")
        REGISTRY[name] = Dataset(name, group, layer, tuple(inputs), fn, description,
                                 tuple(pk), tuple(checks), source)
        return fn
    return deco


class Context:
    """Handed to a builder. Records every upstream view the builder reads."""

    _REF = re.compile(r"\b((?:raw|clean|processed|enriched|delays|metrics|alerts|ontology)__[a-z0-9_]+)\b")

    def __init__(self, con: duckdb.DuckDBPyConnection):
        self.con = con
        self.refs: set[str] = set()

    def note(self, sql: str) -> str:
        self.refs |= set(self._REF.findall(sql))
        return sql

    def q(self, sql: str) -> list[tuple]:
        return self.con.execute(self.note(sql)).fetchall()

    def register(self, name: str, table) -> None:
        self.con.register(name, table)


# ---------------------------------------------------------------- checks ----
# A check is a callable (con, dataset) -> dict(name, status, observed, expected).

def _result(name, ok, observed, expected, warn_only=False):
    status = "pass" if ok else ("warn" if warn_only else "fail")
    return {"name": name, "status": status, "observed": observed, "expected": expected}


def unique(*cols):
    def run(con, ds):
        key = ", ".join(cols)
        dup = con.execute(
            f"select count(*) from (select {key} from {view(ds.name)} group by {key} having count(*) > 1)"
        ).fetchone()[0]
        return _result(f"unique({key})", dup == 0, f"{dup} duplicated keys", "0 duplicated keys")
    return run


def not_null(*cols):
    def run(con, ds):
        cond = " or ".join(f"{c} is null" for c in cols)
        n = con.execute(f"select count(*) from {view(ds.name)} where {cond}").fetchone()[0]
        return _result(f"not_null({', '.join(cols)})", n == 0, f"{n} null rows", "0 null rows")
    return run


def rows_equal(other):
    def run(con, ds):
        a = con.execute(f"select count(*) from {view(ds.name)}").fetchone()[0]
        b = con.execute(f"select count(*) from {view(other)}").fetchone()[0]
        return _result(f"row count = {other}", a == b, f"{a:,}", f"{b:,}")
    return run


def min_rows(n):
    def run(con, ds):
        a = con.execute(f"select count(*) from {view(ds.name)}").fetchone()[0]
        return _result(f"at least {n:,} rows", a >= n, f"{a:,}", f">= {n:,}")
    return run


def fk(col, other, other_col, warn_below=1.0, fail_below=0.0):
    """Share of non-null `col` values that resolve in `other`."""
    def run(con, ds):
        tot, hit = con.execute(
            f"""select count(*), count(o.{other_col})
                from {view(ds.name)} t left join (select distinct {other_col} from {view(other)}) o
                  on t.{col} = o.{other_col}
                where t.{col} is not null"""
        ).fetchone()
        share = hit / tot if tot else 1.0
        ok = share >= warn_below
        res = _result(f"{col} resolves in {other}", ok, f"{share:.2%} ({tot - hit:,} unresolved)",
                      f">= {warn_below:.0%}", warn_only=share >= fail_below)
        return res
    return run


def in_range(col, lo, hi):
    def run(con, ds):
        n, mn, mx = con.execute(
            f"select count(*) filter ({col} < {lo} or {col} > {hi}), min({col}), max({col}) from {view(ds.name)}"
        ).fetchone()
        return _result(f"{col} within [{lo}, {hi}]", n == 0, f"min {mn}, max {mx}, {n} outside", "0 outside")
    return run


def scalar(name, sql, ok: Callable[[object], bool], expected, warn_only=False, fmt=str):
    """Free-form check: `sql` (with {t} for this dataset's view) returns one value."""
    def run(con, ds):
        val = con.execute(sql.format(t=view(ds.name))).fetchone()[0]
        return _result(name, bool(ok(val)), fmt(val), expected, warn_only=warn_only)
    return run


# ---------------------------------------------------------------- runner ----

def run(verbose=True) -> dict:
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    out = []
    t_all = time.time()
    for name, ds in REGISTRY.items():
        for i in ds.inputs:
            if i not in REGISTRY or not (DATA / f"{i}.parquet").exists():
                raise RuntimeError(f"{name}: input {i} has not been built")
        ctx = Context(con)
        t0 = time.time()
        sql = ctx.note(ds.build(ctx))
        declared = {view(i) for i in ds.inputs}
        if ctx.refs != declared:
            raise RuntimeError(
                f"{name}: lineage mismatch. undeclared={sorted(ctx.refs - declared)} "
                f"unused={sorted(declared - ctx.refs)}")
        path = DATA / f"{name}.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"COPY ({sql}) TO '{path}' (FORMAT parquet, COMPRESSION zstd)")
        con.execute(f"CREATE OR REPLACE VIEW {view(name)} AS SELECT * FROM read_parquet('{path}')")
        rows = con.execute(f"select count(*) from {view(name)}").fetchone()[0]
        cols = [{"name": c[0], "type": c[1]} for c in con.execute(f"describe {view(name)}").fetchall()]
        checks = []
        auto = ([unique(*ds.pk), not_null(*ds.pk)] if ds.pk else []) + [min_rows(1)]
        for chk in auto + list(ds.checks):
            checks.append(chk(con, ds))
        secs = time.time() - t0
        worst = "fail" if any(c["status"] == "fail" for c in checks) else (
            "warn" if any(c["status"] == "warn" for c in checks) else "pass")
        out.append({
            "name": name, "group": ds.group, "layer": ds.layer, "description": ds.description,
            "source": ds.source, "inputs": list(ds.inputs), "pk": list(ds.pk), "rows": rows,
            "columns": cols, "bytes": path.stat().st_size, "seconds": round(secs, 3),
            "checks": checks, "health": worst,
        })
        if verbose:
            flag = {"pass": "ok  ", "warn": "WARN", "fail": "FAIL"}[worst]
            print(f"[{flag}] {name:<34} {rows:>9,} rows  {secs:5.2f}s")
            for c in checks:
                if c["status"] != "pass":
                    print(f"         {c['status']}: {c['name']} -> {c['observed']} (expected {c['expected']})")
    lineage = {"datasets": out, "seconds": round(time.time() - t_all, 2)}
    META.mkdir(parents=True, exist_ok=True)
    (META / "lineage.json").write_text(json.dumps(lineage, indent=1))
    lineage["con"] = con
    return lineage
