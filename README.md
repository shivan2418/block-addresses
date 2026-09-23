# block-addresses

Start typing a US street address and pick the right one from five suggestions. The whole
dataset, about 160 million addresses, sits in static files on GitHub Pages. The browser queries it
directly, with no server, no database and no search API.

It's a proof of concept for [blockdb](https://github.com/shivan2418/blockdb), and a stress test:
the same engine as the [Scryfall demo](https://github.com/shivan2418/blockdb-demo-scryfall),
pointed at more than a thousand times as many records.

**Live:** https://shivan2418.github.io/block-addresses/

## The numbers

| Stage | Size |
|---|---|
| OpenAddresses US collections (4 zips, address layers only) | 1,801 sources, 194M rows, 56 GB |
| Overture addresses, US rows (mostly the National Address Database) | 126M rows, 970 MB |
| Merged, cleaned and deduplicated (`data/addresses/*.ndjson`) | 159.8M addresses, 15 GB |
| Built with `blockdb build`, gzipped (`public/blockdb/`) | 6,614 blocks, 794 MB |
| Downloaded by one search | from about 50 KB to a few MB |

GitHub Pages allows 1 GB per site, so the goal from the start was to fit the country under that.

## Where the data comes from

There's no single open list of every US address. The complete one is the USPS address
database, which FedEx, UPS and address-validation services use. It's licensed, and its terms
don't allow republishing it. So this project combines three open sources:

| Source | What it adds | License |
|---|---|---|
| [OpenAddresses](https://openaddresses.io) | ~1,800 county, city and state address files | per source, many need attribution |
| [National Address Database](https://www.transportation.gov/gis/national-address-database) (NAD), via [Overture Maps](https://overturemaps.org) | address points from state and local governments, usually with the mailing city and ZIP code. The only source here for Texas, Tennessee, Virginia, West Virginia and South Carolina, which the OpenAddresses collections don't include | public domain |
| [Census cartographic boundaries](https://www.census.gov/geographies/mapping-files.html) | ZIP code areas, places, and towns/townships. No addresses: they fill in a ZIP code or city where both sources leave it blank | public domain |

Both address sources collect what local governments publish, mostly county 911 and GIS address
points. Those files exist to put a dot on a map for emergency dispatch, so many counties
publish only the house number, street and location. Before the Census backfill, 12.9% of
addresses had no city and 13.5% had no ZIP code.

## How a search works

Blocks are sorted by street name. Typing `1600 pennsylvania ave nw, washington dc` becomes:

```ts
db.addresses.findMany({
  where: {
    street: { startsWith: "PENNSYLVANIA AVE NW" },
    number: { equals: "1600" },
    city: { startsWith: "WASHINGTON" },
    state: { equals: "DC" },
  },
  limit: 5,
});
```

The manifest (about 250 KB, fetched once) tells the browser which blocks hold streets starting
with `PENNSYLVANIA AVE NW`. The small indexes for `city`, `state` and ZIP code narrow that down
further. The browser fetches those few blocks, filters them (including by house number), and
stops at five matches.

The order of what you type doesn't matter much, and commas are optional:
`2 ridge st eastchester ny 10709`, `2 Ridge St, Eastchester, NY 10709`, `eastchester 2 ridge st`
and `10709 2 ridge st` all find the same address. State names work as well as codes, and a
half-typed ZIP code already narrows the results. When the input could be read more than one way
(`washington` as a city or a state, `NE` as a direction or Nebraska), every reading is searched
at once and the results are merged.

## Cleaning up the data

Every source spells things its own way, and they overlap a lot: OpenAddresses and NAD often
carry the same county's file. `scripts/compact.py` uses DuckDB to turn them into one consistent
set, one state at a time:

- **Dropped:** coordinates (after they're used below), source IDs and the file formats'
  wrapping. Only number, street, unit, city, ZIP and state are kept, and empty fields are left
  out.
- **Street names:** uppercased, punctuation stripped, and every word mapped to its USPS
  abbreviation (`North Main Street` → `N MAIN ST`).
- **Ordinals:** one spelling for every numbered street:

  | Source | Stored |
  |---|---|
  | `Fifth Avenue`, `5 Ave`, `05th Ave` | `5TH AVE` |
  | `Twenty-First St`, `twenty first street` | `21ST ST` |
  | `12nd Ave` | `12TH AVE` |
  | `Highway 5`, `10 Mile Rd` | unchanged, since these numbers aren't ordinals |

- **Duplicates:** two rows are the same address when number, street and unit match within about
  11 km of each other. That keeps "100 Main St" in two different towns apart while merging the
  same house reported by a county, a city and NAD. Of each group, the row with the most complete
  city and ZIP code wins. This removes about half of the 318M rows.
- **City names:** legal prefixes are stripped (`CITY OF EL PASO` → `EL PASO`).
- **Missing ZIP codes and cities** are filled in from the Census boundary the address's
  coordinates fall in. The ZIP comes from the ZIP code tabulation area, which matches the real
  ZIP for about 99% of addresses that have one. The city comes from the Census place, or
  outside places, the town or township. In New York City, whose sources call every address
  "New York", the borough is used instead (Brooklyn, Queens, Bronx, Staten Island), as mail
  there is addressed.

The word lists live in `scripts/normalize.json`. The page reads the same file, so what you type
is normalized exactly the way the stored streets were: `350 fifth avenue` finds `350 5TH AVE`.

## Limits

- **This isn't address validation.** FedEx, UPS and services like Smarty check an address
  against the USPS database, so they know that it receives mail. Here, an address exists
  because a local government published it. Some places are covered better than others, and a
  county that publishes nothing has no addresses here.
- **Some cities and ZIP codes are inferred.** Where no source gave one, it comes from Census
  boundaries (see above). The inferred ZIP is right about 99% of the time. The inferred city is
  the municipality, which isn't always the name on the mail: a house in a township may get its
  mail addressed to a neighbouring town. After the backfill, 1.7% of addresses still have no
  city (most in rural Mississippi, Wyoming and Louisiana, outside any town) and 0.02% no ZIP.
- **Source errors come through.** A few rows are wrong at the source, such as a handful of
  Buffalo streets tagged with Brooklyn's ZIP code 11201. They're rare, and there's no way to
  tell them apart from real addresses.
- **Matching is by prefix, not fuzzy.** `main st` finds `MAIN ST` and `MAIN ST EXT`, but a
  typo such as `mian st` finds nothing.
- **Common street names are expensive.** Blocks are split by street name, and `MAIN ST` alone
  spans dozens of them. A search for `123 main st` without a city can download a few megabytes.
  Sorting by street *and* city would fix this. It's the next thing to try.
- **A street is needed.** A bare house number, city or ZIP code doesn't search on its own, since
  each would match thousands or millions of addresses.

## Running it locally

You need Node 24 and pnpm. blockdb isn't on npm yet, so it installs from the
[v0.3.0 GitHub Release](https://github.com/shivan2418/blockdb/releases/tag/v0.3.0) tarballs.

```sh
pnpm install
pnpm dev        # http://localhost:5173
```

The built dataset isn't in git. You need to rebuild it first (below) or copy an existing
`public/blockdb/` in.

| Command | What it does |
|---|---|
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Build the site into `dist/` |
| `pnpm check` | Typecheck with svelte-check |
| `pnpm test` | Run the unit tests (query parsing and normalization) |
| `pnpm fetch-overture` | Download Overture's US addresses into `overture/` |
| `pnpm fetch-census` | Download the Census boundary files into `census/` |
| `pnpm compact` | Merge, clean, deduplicate and backfill into `data/addresses/` |
| `pnpm build-data` | Build `public/blockdb/` and `src/blockdb/` from `data/addresses/` |
| `pnpm deploy-pages` | Build the site and publish it to GitHub Pages |

## Rebuilding the data

Everything here runs locally, once. Rerun it only to pick up newer source data or changed
cleanup rules. You need [uv](https://docs.astral.sh/uv/) for the Python scripts and about 100 GB of
free disk. All downloads are gitignored.

1. Download the four US collections (`collection-us-northeast.zip`, `-south`, `-midwest`,
   `-west`) from [OpenAddresses batch downloads](https://batch.openaddresses.io/data) into the
   project root, then extract only the address layers into `addresses/`:
   ```sh
   for z in collection-us-*.zip; do unzip -o "$z" 'us/*-addresses-*' -d addresses; done
   ```
2. `pnpm fetch-overture` downloads Overture's US addresses into `overture/` (about 1 GB and a
   couple of minutes). Pass a release such as `2026-08-19.0` to pin one.
3. `pnpm fetch-census` downloads the Census boundary files into `census/` (about 130 MB).
4. `pnpm compact` merges, cleans, deduplicates and backfills into `data/addresses/`. This takes
   about 16 minutes.
5. `pnpm build-data` builds `public/blockdb/` and `src/blockdb/`. This takes about 12 minutes
   and peaks around 1.5 GB of memory.

## Deploying

`pnpm deploy-pages` builds the site around the data already in `public/blockdb/` and publishes
it to the `gh-pages` branch, which GitHub Pages serves. It runs locally too: the data can't be
rebuilt in GitHub Actions, since its inputs aren't in git. The only thing that runs on GitHub
is Pages' own job that publishes the branch. `master` holds only the source.

A deploy uploads only what changed. `.gh-pages.git/` (gitignored) keeps the last deploy, and a
deploy with unchanged data goes on top of it, so a page-only change sends kilobytes. After a
data rebuild nearly every block changes, so `gh-pages` restarts as a single commit. That keeps
the repository from growing by the full dataset on every refresh.

The blocks are gzipped rather than brotli-compressed. GitHub Pages serves them as raw bytes, so
the browser decompresses them itself, and every browser can do that for gzip.

## Project layout

```
scripts/fetch_overture.py  Overture's US addresses → overture/us.parquet
scripts/fetch_census.sh    Census boundary files → census/
scripts/compact.py         merge, clean, dedupe and backfill → data/addresses/*.ndjson
scripts/normalize.json     abbreviations and ordinal words, shared with the page
scripts/deploy.sh          build the site and publish it to gh-pages
blockdb.config.json        dataset schema: sort field and indexed fields
src/search.ts              turns typed text into blockdb queries
src/App.svelte             the page (Svelte 5)
src/blockdb/               typed client generated by `blockdb build`
```

## Credits

- Addresses from [OpenAddresses](https://openaddresses.io). Each source carries its own
  license, recorded in the `.meta` file next to it in the download, and many require
  attribution.
- Addresses from the U.S. Department of Transportation's
  [National Address Database](https://www.transportation.gov/gis/national-address-database),
  public domain, distributed through the [Overture Maps Foundation](https://overturemaps.org)
  addresses theme.
- ZIP code, place and county subdivision boundaries from the U.S. Census Bureau, public domain.

This project isn't affiliated with any of these organizations or their sources.
