# block-addresses

Start typing a US street address and pick the right one from five suggestions. The whole
dataset, about 129 million addresses, sits in static files on GitHub Pages. The browser queries it
directly, with no server, no database and no search API.

It's a stress test for [blockdb](https://github.com/shivan2418/blockdb): the same engine as the
[Scryfall demo](https://github.com/shivan2418/blockdb-demo-scryfall), pointed at a thousand
times as many records.

**Live:** https://shivan2418.github.io/block-addresses/

## The numbers

| Stage | Size |
|---|---|
| OpenAddresses US collections (4 zips, address layers only) | 1,801 sources, 194M rows, 56 GB |
| After cleanup and deduplication (`data/addresses/*.ndjson`) | 128.8M addresses, 11 GB |
| Built with `blockdb build`, gzipped (`public/blockdb/`) | 5,122 blocks, 657 MB |
| Downloaded by one search | from about 50 KB to a few MB |

GitHub Pages allows 1 GB per site, so the goal from the start was to fit the country under that.

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
with `PENNSYLVANIA AVE NW`. The small indexes for `number`, `city` and `state` narrow that down
further. The browser fetches those few blocks, filters them, and stops at five matches.

Everything before the first comma is the house number and street. After it come the city, the
state and the ZIP code, all optional.

## Cleaning up the data

OpenAddresses gathers addresses from about 1,800 county, city and state sources. Each one
spells things its own way, and neighbouring sources overlap. `scripts/compact.py` uses DuckDB to
turn them into one consistent set:

- **Dropped:** coordinates, source hashes and the GeoJSON wrapping. Only number, street, unit,
  city, ZIP and state are kept, and empty fields are left out.
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
  same house reported by a county and a city. Of each group, the row with the most complete city
  and ZIP code wins. This removes about a third of the rows.

The word lists live in `scripts/normalize.json`. The page reads the same file, so what you type
is normalized exactly the way the stored streets were: `350 fifth avenue` finds `350 5TH AVE`.

## Limits

- **Not every address is complete, and that comes from the source data.** This isn't an
  address-validation service like the ones FedEx, UPS or Smarty offer. Those check against the
  USPS national address database, which is licensed and not public. OpenAddresses is the best
  open alternative, and it republishes what local governments release, mostly county 911 and
  GIS address points. Those files exist to put a dot on a map for emergency dispatch, so many
  counties publish only the house number, street and location, with no ZIP code or city:

  | Missing | Share of addresses | Worst states |
  |---|---|---|
  | City | 12.9% | Nevada 74%, Alabama 53% |
  | ZIP code | 13.5% | Montana 92%, Nebraska 64%, Oklahoma 53% |
  | Both | 6.0% | |

  The gaps are whole sources, not scattered records: in Minnesota, Anoka County's file has a
  city and ZIP on every row and Cass County's has neither. The biggest case is New York City,
  whose file has ZIP codes but no city: `350 5th ave, new york` finds nothing, while
  `350 5th ave, ny 10118` finds the Empire State Building. Coverage also has holes wherever a
  county publishes nothing at all. The raw files do carry coordinates, so ZIP and city could
  be filled in from Census boundaries at build time, but that isn't done yet.
- **Matching is by prefix, not fuzzy.** `main st` finds `MAIN ST` and `MAIN ST EXT`, but a
  typo such as `mian st` finds nothing.
- **Common street names are expensive.** Blocks are split by street name, and `MAIN ST` alone
  spans dozens of them. A search for `123 main st` without a city can download a few megabytes.
  Sorting by street *and* city would fix this. It's the next thing to try.
- **The street must come first.** A bare house number or a city on its own doesn't search, since
  either would match millions of addresses.

## Running it locally

You need Node 24 and pnpm. blockdb isn't on npm yet, so `package.json` links to a checkout of it
at `../blockdb`.

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
| `pnpm compact` | Clean and deduplicate `addresses/` into `data/addresses/` |
| `pnpm build-data` | Build `public/blockdb/` and `src/blockdb/` from `data/addresses/` |
| `pnpm deploy-pages` | Build the site and publish it to GitHub Pages |

## Rebuilding the data

1. Download the four US collections (`collection-us-northeast.zip`, `-south`, `-midwest`,
   `-west`) from [OpenAddresses batch downloads](https://batch.openaddresses.io/data) into the
   project root. They're gitignored.
2. Extract only the address layers into `addresses/`:
   ```sh
   for z in collection-us-*.zip; do unzip -o "$z" 'us/*-addresses-*' -d addresses; done
   ```
3. `pnpm compact`. This takes about 10 minutes and needs [uv](https://docs.astral.sh/uv/).
4. `pnpm build-data`. This takes about 8 minutes and peaks around 3 GB of memory.

## Deploying

`pnpm deploy-pages` runs locally, because GitHub Actions can't rebuild the 11 GB input. It builds
the site around the data already in `public/blockdb/` (run `pnpm build-data` first if the data
changed), then force-pushes `dist/` as a single commit to the `gh-pages` branch, which GitHub
Pages serves. `master` holds only the source. Replacing `gh-pages` each time keeps the
repository from growing by 660 MB on every deploy.

The blocks are gzipped rather than brotli-compressed. GitHub Pages serves them as raw bytes, so
the browser decompresses them itself, and every browser can do that for gzip.

## Project layout

```
scripts/compact.py      OpenAddresses GeoJSON → clean, deduplicated NDJSON per state
scripts/normalize.json  abbreviations and ordinal words, shared with the page
scripts/deploy.sh       build and publish to gh-pages
blockdb.config.json     dataset schema: sort field and indexed fields
src/search.ts           turns typed text into a blockdb query
src/App.svelte          the page (Svelte 5)
src/blockdb/            typed client generated by `blockdb build`
```

## Credits

Address data comes from [OpenAddresses](https://openaddresses.io). Each source carries its own
license, recorded in the `.meta` file next to it in the download, and many require
attribution. This project isn't affiliated with OpenAddresses or any of its sources.
