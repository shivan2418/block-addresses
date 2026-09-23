import { connect, type Db } from "./blockdb/client";
import type { Addresses } from "./blockdb/schema";
import rules from "../scripts/normalize.json";

type Where = NonNullable<NonNullable<Parameters<Db["addresses"]["findMany"]>[0]>["where"]>;

const db = connect({ basePath: `${import.meta.env.BASE_URL}blockdb` });

// Shared with scripts/compact.py: stored streets are already normalized with these lists, so
// typed text has to be normalized the same way before it can prefix-match. "FIFTH", "05TH" and
// "5 AVE" are all stored as "5TH".
const ABBREVIATIONS: Record<string, string> = rules.abbreviations;
const { unitOrdinals: UNIT_ORDINALS, teens: TEENS, tens: TENS, bareOrdinalTypes: BARE_ORDINAL_TYPES } = rules;

function ordinal(n: number): string {
  const suffix = [11, 12, 13].includes(n % 100) ? "TH" : ({ 1: "ST", 2: "ND", 3: "RD" }[n % 10] ?? "TH");
  return `${n}${suffix}`;
}

const ORDINAL_WORDS: Record<string, string> = Object.fromEntries([
  ...UNIT_ORDINALS.map((w, i) => [w, ordinal(i + 1)]),
  ...TEENS.map((w, i) => [w, ordinal(i + 10)]),
  ...TENS.map((t, i) => [t.slice(0, -1) + "IETH", ordinal(20 + 10 * i)]),
]);
const WORDS: Record<string, string> = { ...ABBREVIATIONS, ...ORDINAL_WORDS };

const STATES = new Set(
  ("AL AK AZ AR CA CO CT DC DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ " +
    "NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split(" "),
);

// The same cleanup compact.py applies: uppercase, drop . , #, collapse whitespace.
function clean(s: string): string {
  return s.toUpperCase().replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

// Could a half-typed token still become one of the street types a bare ordinal needs?
function mayBeType(t: string): boolean {
  return Object.entries(ABBREVIATIONS).some(([long, short]) => BARE_ORDINAL_TYPES.includes(short) && long.startsWith(t))
    || BARE_ORDINAL_TYPES.some((type) => type.startsWith(t));
}

// The typed street, normalized the way compact.py normalizes stored streets, as a prefix to
// match against them. The last token may still be half-typed, so it is only ever loosened:
// "MAIN STRE" is on its way to STREET, stored as ST, so it is cut back to what it shares with
// the abbreviation ("ST"); a half-typed ordinal word ("FIFT": FIFTH? FIFTEENTH?) is dropped.
// A looser prefix only means more candidates, never missing ones. Returns null while there is
// nothing left to match on.
function streetPrefix(text: string): string | null {
  const tens = TENS.join("|");
  const units = UNIT_ORDINALS.join("|");
  const joined = clean(text).replace(new RegExp(`\\b(${tens})-(${units})\\b`, "g"), "$1 $2");
  let tokens = joined.split(" ").filter(Boolean);
  const typedLast = tokens.at(-1);
  const lastIsWord = typedLast !== undefined && typedLast in WORDS;
  tokens = tokens.map((t) => WORDS[t] ?? t);

  // "TWENTY 1ST" → "21ST"
  for (let i = 0; i < tokens.length - 1; i++) {
    const tensIndex = TENS.indexOf(tokens[i]);
    if (tensIndex >= 0 && /^[1-9](ST|ND|RD|TH)$/.test(tokens[i + 1])) {
      tokens.splice(i, 2, `${tensIndex + 2}${tokens[i + 1]}`);
    }
  }

  const last = tokens.length - 1;
  if (last >= 0 && !lastIsWord) {
    const t = tokens[last];
    const partial = Object.entries(ABBREVIATIONS).find(([long, short]) => long.startsWith(t) && !short.startsWith(t));
    if (partial) tokens[last] = commonPrefix(t, partial[1]) || t;
    else if (t.length >= 2 && Object.keys(ORDINAL_WORDS).some((w) => w.startsWith(t))) tokens.pop();
  }

  tokens = tokens.map((t, i) => {
    const m = t.match(/^0*([1-9]\d*)(ST|ND|RD|TH)?$/);
    if (!m) return t;
    const n = Number(m[1]);
    if (m[2]) return ordinal(n);
    const next = tokens[i + 1];
    if (next === undefined) return m[1];
    const nextIsTyped = i + 1 === tokens.length - 1 && !lastIsWord;
    return BARE_ORDINAL_TYPES.includes(next) || (nextIsTyped && mayBeType(next)) ? ordinal(n) : t;
  });

  return tokens.length ? tokens.join(" ") : null;
}

export interface Query {
  number?: string;
  street?: string;
  city?: string;
  state?: string;
  postcode?: string;
}

// "123 main st, springfield il 62701" → number 123, street MAIN ST, city SPRINGFIELD, state IL,
// postcode 62701. Everything before the first comma is number + street; after it, place.
export function parse(input: string): Query {
  const [addressPart, ...rest] = input.split(",");
  const q: Query = {};

  const address = clean(addressPart ?? "");
  // An ordinal ("5TH AVE") starts the street, not a house number.
  const m = address.match(/^(?!\d+(?:ST|ND|RD|TH)\b)(\d[\w-]*)(?:\s+(.*))?$/);
  const streetText = m ? (m[2] ?? "") : address;
  if (m) q.number = m[1];
  const street = streetText && streetPrefix(streetText);
  if (street) q.street = street;

  const place = clean(rest.join(" ")).split(" ").filter(Boolean);
  if (place.length && /^\d{5}$/.test(place.at(-1)!)) q.postcode = place.pop();
  if (place.length && STATES.has(place.at(-1)!)) q.state = place.pop();
  if (place.length) q.city = place.join(" ");
  return q;
}

// Resolves to null when the input can't be searched yet: a bare number would match millions of
// records, so wait for at least the start of the street.
export async function search(input: string, limit = 5): Promise<Addresses[] | null> {
  const q = parse(input);
  if (!q.street) return null;

  const where: Where = {
    street: { startsWith: q.street },
    ...(q.number && { number: { equals: q.number } }),
    ...(q.city && { city: { startsWith: q.city } }),
    ...(q.state && { state: { equals: q.state } }),
    ...(q.postcode && { postcode: { equals: q.postcode } }),
  };

  const { records } = await db.addresses.findMany({ where, limit });
  return records;
}

const KEEP_UPPER = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (KEEP_UPPER.has(w) ? w : /\d/.test(w) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
}

export function format(a: Addresses): string {
  const line1 = [a.number, titleCase(a.street), a.unit && `#${a.unit}`].filter(Boolean).join(" ");
  const line2 = [a.state, a.postcode].filter(Boolean).join(" ");
  return [line1, a.city && titleCase(a.city), line2].filter(Boolean).join(", ");
}
