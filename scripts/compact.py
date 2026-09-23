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

# The word lists are shared with the site's search (src/search.ts), which has to normalize
# typed text exactly the way stored streets are normalized here.
with open(os.path.join(ROOT, "scripts", "normalize.json")) as f:
    RULES = json.load(f)

# Sources spell the same street differently ("8th Avenue" vs "8TH AVE"), so every token is
# mapped to its USPS abbreviation before comparing. Applied to all tokens, not just the
# last: over-abbreviating "NORTH ST" to "N ST" is harmless next to missing a duplicate.
ABBREVIATIONS: dict[str, str] = RULES["abbreviations"]

# Ordinal street names come as "5TH", "FIFTH", "05TH", "12ND" and, mostly in New York, a bare
# "5 AVE". All become "5TH". Spelled ordinals are mapped as tokens; "TWENTY FIRST" is then
# joined into "21ST"; digits get their suffix recomputed. A bare number only counts as an
# ordinal when a street type follows it, so "HWY 5" and "10 MILE RD" are left alone.
UNIT_ORDINALS: list[str] = RULES["unitOrdinals"]
TEENS: list[str] = RULES["teens"]
TENS: list[str] = RULES["tens"]
BARE_ORDINAL_TYPES: list[str] = RULES["bareOrdinalTypes"]


def ordinal(n: int) -> str:
    suffix = "TH" if n % 100 in (11, 12, 13) else {1: "ST", 2: "ND", 3: "RD"}.get(n % 10, "TH")
    return f"{n}{suffix}"


ORDINAL_WORDS = {w: ordinal(i + 1) for i, w in enumerate(UNIT_ORDINALS)}
ORDINAL_WORDS |= {w: ordinal(i + 10) for i, w in enumerate(TEENS)}
ORDINAL_WORDS |= {t[:-1] + "IETH": ordinal(20 + 10 * i) for i, t in enumerate(TENS)}

ABBREVIATE = "CASE t " + " ".join(
    f"WHEN '{k}' THEN '{v}'" for k, v in (ABBREVIATIONS | ORDINAL_WORDS).items()
) + " ELSE t END"


def cleaned(col: str) -> str:
    return f"regexp_replace(regexp_replace(upper(trim({col})), '[.,#]', '', 'g'), '\\s+', ' ', 'g')"


def normalized(col: str) -> str:
    return f"array_to_string(list_transform(string_split({cleaned(col)}, ' '), t -> {ABBREVIATE}), ' ')"


def street_tokens(col: str) -> str:
    """The street as abbreviated tokens with ordinals spelled as digits; see ORDINAL_WORDS."""
    units = "|".join(UNIT_ORDINALS)
    s = f"regexp_replace({cleaned(col)}, '({'|'.join(TENS)})-({units})', '\\1 \\2', 'g')"
    s = f"array_to_string(list_transform(string_split({s}, ' '), t -> {ABBREVIATE}), ' ')"
    for i, tens in enumerate(TENS):
        s = f"regexp_replace({s}, '(^| ){tens} ([1-9](ST|ND|RD|TH))( |$)', '\\1{i + 2}\\2\\4', 'g')"
    return f"string_split({s}, ' ')"


def ordinalized(toks: str) -> str:
    """Rejoin street_tokens(), recomputing the suffix of every numeric ordinal."""
    n = "try_cast(regexp_extract(t, '^0*([1-9][0-9]*)', 1) as bigint)"
    suffixed = (f"{n}::varchar || case when {n} % 100 between 11 and 13 then 'TH' "
                f"when {n} % 10 = 1 then 'ST' when {n} % 10 = 2 then 'ND' "
                f"when {n} % 10 = 3 then 'RD' else 'TH' end")
    types = ", ".join(f"'{t}'" for t in BARE_ORDINAL_TYPES)
    return f"""array_to_string(list_transform({toks}, (t, i) -> coalesce(case
        when regexp_matches(t, '^0*[1-9][0-9]*(ST|ND|RD|TH)$') then {suffixed}
        when regexp_matches(t, '^0*[1-9][0-9]*$') and {toks}[i + 1] in ({types}) then {suffixed}
        end, t)), ' ')"""


def compact_state(con: duckdb.DuckDBPyConnection, state: str) -> tuple[int, int]:
    pattern = os.path.join(SRC, state, "*-addresses-*.geojson")
    con.execute(f"""
        create or replace temp table raw as
        with parsed as (
        select
          upper(trim(properties.number)) as number,
          {street_tokens('properties.street')} as street_toks,
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
        )
        select number, {ordinalized('street_toks')} as street, unit, city, postcode, lon, lat
        from parsed
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
