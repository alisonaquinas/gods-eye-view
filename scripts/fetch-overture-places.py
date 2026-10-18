#!/usr/bin/env python3
"""Export the fixed metro envelope, with a completion manifest and no database access."""
import hashlib
import json
import os
import re
import socket
import sys
from pathlib import Path

import pyarrow as pa
import shapely
from overturemaps import record_batch_reader

BOUNDS = [-85.1, 33.2, -83.5, 34.5]
FIELDS = ["names", "addresses", "sources", "confidence", "operating_status",
          "taxonomy", "basic_category", "categories", "version"]


def export(destination, release):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", release):
        raise ValueError("Invalid release")
    socket.setdefaulttimeout(60)
    pa.set_cpu_count(2)
    pa.set_io_thread_count(4)
    reader = record_batch_reader("place", bbox=BOUNDS, release=release,
                               connect_timeout=15, request_timeout=90, stac=True)
    if reader is None or not {"id", "geometry", "names", "addresses", "sources", "confidence"}.issubset(reader.schema.names):
        raise ValueError("Missing place data or incompatible source schema")
    target = Path(destination)
    partial = target.with_suffix(target.suffix + ".part")
    count = 0
    digest = hashlib.sha256()
    try:
        with partial.open("w", encoding="utf-8") as out:
            out.write(json.dumps({"type": "manifest", "release": release, "bounds": BOUNDS}) + "\n")
            for batch in reader:
                # Arrow batches may contain 131k rows; do not materialize all their
                # nested Python objects on the small production host at once.
                selected = batch.select([k for k in ["id", "geometry", *FIELDS] if k in batch.schema.names])
                for record in (r for start in range(0, selected.num_rows, 512)
                               for r in selected.slice(start, 512).to_pylist()):
                    count += 1
                    if count > 500000:
                        raise ValueError("Metro export exceeded record limit")
                    geometry = json.loads(shapely.to_geojson(shapely.from_wkb(record["geometry"])))
                    feature = {"type": "Feature", "id": record["id"], "geometry": geometry,
                               "properties": {k: record.get(k) for k in FIELDS if k in record}}
                    line = json.dumps(feature, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
                    digest.update(line.encode("utf-8"))
                    out.write(line)
                if out.tell() > 512 * 1024 * 1024:
                    raise ValueError("Metro export exceeded size limit")
            if not count:
                raise ValueError("Empty place export")
            out.write(json.dumps({"type": "complete", "count": count, "sha256": digest.hexdigest()}) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(partial, target)
        print(json.dumps({"release": release, "records": count, "bytes": target.stat().st_size}))
    finally:
        partial.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: fetch-overture-places.py OUTPUT RELEASE")
    export(sys.argv[1], sys.argv[2])
