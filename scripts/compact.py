"""Compact OpenAddresses GeoJSON into deduplicated per-state NDJSON for blockdb.

Reads addresses/us/<state>/*-addresses-*.geojson (extracted from the OpenAddresses
collection zips) and writes data/addresses/<state>.ndjson: one flat record per unique
address, coordinates and GeoJSON wrapping dropped, empty fields omitted.

Run: uv run --with duckdb python scripts/compact.py [state ...]
"""

import json
import os
import sys
import time

import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "addresses", "us")
OUT = os.path.join(ROOT, "data", "addresses")

# Sources spell the same street differently ("8th Avenue" vs "8TH AVE"), so every token is
# mapped to its USPS abbreviation before comparing. Applied to all tokens, not just the
# last: over-abbreviating "NORTH ST" to "N ST" is harmless next to missing a duplicate.
ABBREVIATIONS = {
    "STREET": "ST", "AVENUE": "AVE", "AV": "AVE", "ROAD": "RD", "DRIVE": "DR", "LANE": "LN",
    "COURT": "CT", "BOULEVARD": "BLVD", "PLACE": "PL", "CIRCLE": "CIR", "TRAIL": "TRL",
    "PARKWAY": "PKWY", "HIGHWAY": "HWY", "TERRACE": "TER", "SQUARE": "SQ", "EXPRESSWAY": "EXPY",
    "FREEWAY": "FWY", "CROSSING": "XING", "POINT": "PT", "COVE": "CV", "HOLLOW": "HOLW",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "NORTHEAST": "NE", "NORTHWEST": "NW", "SOUTHEAST": "SE", "SOUTHWEST": "SW",
}
ABBREVIATE = "CASE t " + " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in ABBREVIATIONS.items()) + " ELSE t END"


def cleaned(col: str) -> str:
    return f"regexp_replace(regexp_replace(upper(trim({col})), '[.,#]', '', 'g'), '\\s+', ' ', 'g')"


def normalized(col: str) -> str:
    return f"array_to_string(list_transform(string_split({cleaned(col)}, ' '), t -> {ABBREVIATE}), ' ')"


def compact_state(con: duckdb.DuckDBPyConnection, state: str) -> tuple[int, int]:
    pattern = os.path.join(SRC, state, "*-addresses-*.geojson")
    con.execute(f"""
        create or replace temp table raw as
        select
          upper(trim(properties.number)) as number,
          {normalized('properties.street')} as street,
          {normalized('properties.unit')} as unit,
          {cleaned('properties.city')} as city,
          case when regexp_matches(trim(properties.postcode), '^[0-9]{{5}}')
               then left(trim(properties.postcode), 5) else '' end as postcode,
          geometry.coordinates[1] as lon,
          geometry.coordinates[2] as lat
        from read_json('{pattern}', format = 'newline_delimited',
          columns = {{
            'properties': 'STRUCT(number VARCHAR, street VARCHAR, unit VARCHAR, city VARCHAR, postcode VARCHAR)',
            'geometry': 'STRUCT(coordinates DOUBLE[])'
          }})
        where trim(properties.number) not in ('', '0')
          and regexp_matches(properties.street, '[A-Za-z0-9]')
          and geometry.coordinates[1] is not null
    """)
    read = con.execute("select count(*) from raw").fetchone()[0]

    # A duplicate is the same number + street + unit within a ~0.1° (~11 km) cell: the
    # cell keeps "100 MAIN ST" in two different towns apart, while tolerating the metres
    # of disagreement between sources. Coordinates are used only for this, never written.
    # Of each duplicate group, keep the row with the most of city/postcode filled in.
    rows = con.execute("""
        select number, street, unit, city, postcode
        from raw
        qualify row_number() over (
          partition by number, street, unit, round(lat, 1), round(lon, 1)
          order by (city <> '')::int + (postcode <> '')::int desc, city, postcode
        ) = 1
        order by postcode, city, street,
          try_cast(regexp_extract(number, '^[0-9]+') as bigint), number, unit
    """)

    region = state.upper()
    written = 0
    tmp = os.path.join(OUT, f"{state}.ndjson.tmp")
    with open(tmp, "w") as f:
        while batch := rows.fetchmany(100_000):
            for number, street, unit, city, postcode in batch:
                record = {"number": number, "street": street}
                if unit:
                    record["unit"] = unit
                if city:
                    record["city"] = city
                if postcode:
                    record["postcode"] = postcode
                record["state"] = region
                f.write(json.dumps(record, separators=(",", ":")))
                f.write("\n")
            written += len(batch)
    os.replace(tmp, os.path.join(OUT, f"{state}.ndjson"))
    return read, written


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    states = sys.argv[1:] or sorted(os.listdir(SRC))
    con = duckdb.connect()
    total_read = total_written = 0
    for state in states:
        start = time.time()
        read, written = compact_state(con, state)
        total_read += read
        total_written += written
        print(f"{state}: {read:>11,} read → {written:>11,} unique  ({time.time() - start:.0f}s)", flush=True)
    print(f"total: {total_read:,} read → {total_written:,} unique")


if __name__ == "__main__":
    main()
