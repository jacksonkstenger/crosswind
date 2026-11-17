"""Run the whole pipeline:  python -m pipeline.run

Builds every dataset into data/ as Parquet, writes lineage and the ontology
definition to data/_meta/, then exports the compact JSON files the app reads.
"""
from __future__ import annotations

import json
import sys

from . import dag
from . import stage_source, stage_model, stage_alerts, stage_ontology  # noqa: F401  (registers datasets)
from .stage_ontology import ONTOLOGY


def main() -> int:
    lineage = dag.run()
    con = lineage.pop("con")

    ontology = json.loads(json.dumps(ONTOLOGY))
    rows = {d["name"]: d["rows"] for d in lineage["datasets"]}
    for ot in ontology["objectTypes"]:
        ot["objects"] = rows[ot["backing"]]
    (dag.META / "ontology.json").write_text(json.dumps(ontology, indent=1))

    from . import export_app
    export_app.export(con, lineage, ontology)

    fails = [d["name"] for d in lineage["datasets"] if d["health"] == "fail"]
    warns = [d["name"] for d in lineage["datasets"] if d["health"] == "warn"]
    print(f"\n{len(lineage['datasets'])} datasets in {lineage['seconds']}s. "
          f"{len(fails)} failing, {len(warns)} with warnings.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
