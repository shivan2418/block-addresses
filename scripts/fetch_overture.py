"""Fetch the US rows of Overture's addresses theme into overture/us.parquet (~1 GB).

Overture (https://overturemaps.org) publishes addresses as GeoParquet on a public S3
bucket. In the US they come mostly from the National Address Database (public domain),
with OpenAddresses filling states NAD lacks. Only the columns compact.py uses are kept;
the point's coordinates are read from its bbox, which avoids the spatial extension.

Run: uv run --with duckdb python scripts/fetch_overture.py [release]
"""

import os
import sys

import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE = sys.argv[1] if len(sys.argv) > 1 else "2026-08-19.0"
OUT = os.path.join(ROOT, "overture", "us.parquet")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
con = duckdb.connect()
con.execute("install httpfs; load httpfs; set s3_region = 'us-west-2'")
con.execute(f"""
    copy (
      select number, street, unit, postcode, postal_city, address_levels,
        bbox.xmin as lon, bbox.ymin as lat, sources[1].dataset as dataset
      from read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=addresses/type=address/*',
        hive_partitioning = 1)
      where country = 'US'
    ) to '{OUT}.tmp' (format parquet, compression zstd)
""")
os.replace(f"{OUT}.tmp", OUT)
print(con.execute(f"select count(*) from '{OUT}'").fetchone()[0], "addresses →", OUT)
