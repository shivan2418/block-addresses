#!/usr/bin/env bash
# Download the Census cartographic boundary files compact.py fills ZIP codes and cities from
# (~130 MB): ZIP code tabulation areas, places (cities, towns, CDPs) and county subdivisions.
set -euo pipefail
dir="$(dirname "$0")/../census"
mkdir -p "$dir" && cd "$dir"
base=https://www2.census.gov/geo/tiger
for f in GENZ2020/shp/cb_2020_us_zcta520_500k.zip GENZ2023/shp/cb_2023_us_place_500k.zip \
         GENZ2023/shp/cb_2023_us_cousub_500k.zip; do
  [ -f "$(basename "$f")" ] || curl -sSfLO "$base/$f"
done
ls -l *.zip
