import { describe, expect, it } from "vitest";
import { parse } from "./search";

const street = (input: string) => parse(input)[0]?.street;

const RIDGE = { number: "2", street: "RIDGE ST" };

// The same address typed the ways people type it. The first reading is the one whose results
// are shown first, so it is the one that has to be right.
describe("parse: the order people type things in", () => {
  it.each([
    ["number street", "2 ridge st", {}],
    ["number street state", "2 ridge st ny", { state: "NY" }],
    ["number street state name", "2 ridge st new york", { state: "NY" }],
    ["number street zip", "2 ridge st 10709", { postcode: "10709" }],
    ["number street zip+4", "2 ridge st 10709-1234", { postcode: "10709" }],
    ["number street city", "2 ridge st eastchester", { city: "EASTCHESTER" }],
    ["number street city state", "2 ridge st eastchester ny", { city: "EASTCHESTER", state: "NY" }],
    ["number street city state name", "2 ridge st eastchester new york", { city: "EASTCHESTER", state: "NY" }],
    ["number street city state zip", "2 ridge st eastchester ny 10709", { city: "EASTCHESTER", state: "NY", postcode: "10709" }],
    ["number street zip city", "2 ridge st 10709 eastchester", { city: "EASTCHESTER", postcode: "10709" }],
    ["with commas", "2 Ridge St, Eastchester, NY 10709", { city: "EASTCHESTER", state: "NY", postcode: "10709" }],
    ["long street type", "2 ridge street eastchester", { city: "EASTCHESTER" }],
    ["city first", "eastchester 2 ridge st", { city: "EASTCHESTER" }],
    ["city state first", "eastchester ny 2 ridge st", { city: "EASTCHESTER", state: "NY" }],
    ["city first, with a comma", "eastchester, 2 ridge st", { city: "EASTCHESTER" }],
    ["zip first", "10709 2 ridge st", { postcode: "10709" }],
    ["state first", "ny 2 ridge st", { state: "NY" }],
    ["zip first, city after", "10709 2 ridge st eastchester", { city: "EASTCHESTER", postcode: "10709" }],
  ])("%s: %s", (_, input, place) => {
    expect(parse(input)[0]).toEqual({ ...RIDGE, ...place });
  });

  it.each([
    ["half-typed city", "2 ridge st eastch", { city: "EASTCH" }],
    ["half-typed state", "2 ridge st eastchester n", { city: "EASTCHESTER" }],
    ["half-typed zip", "2 ridge st 107", { postcode: "107" }],
    ["half-typed street type", "2 ridge stre", {}],
  ])("while typing, %s: %s", (_, input, place) => {
    expect(parse(input)[0]).toEqual({ ...RIDGE, ...place });
  });

  it("waits for a street", () => {
    expect(parse("2")).toEqual([]);
    expect(parse("10709")).toEqual([]);
    expect(parse("eastchester 2")).toEqual([]);
  });

  it("tries a lone state name as a city too", () => {
    expect(parse("1600 pennsylvania ave washington")).toEqual([
      { number: "1600", street: "PENNSYLVANIA AVE", state: "WA" },
      { number: "1600", street: "PENNSYLVANIA AVE", city: "WASHINGTON" },
      { number: "1600", street: "PENNSYLVANIA AVE WASHINGTON" },
    ]);
  });

  it("finds a street without a house number", () => {
    expect(parse("ridge st 10709")[0]).toEqual({ street: "RIDGE ST", postcode: "10709" });
  });
});

describe("parse", () => {
  it("splits number, street and place at a comma", () => {
    expect(parse("300 e capitol ave, springfield il 62701")).toEqual([
      { number: "300", street: "E CAPITOL AVE", city: "SPRINGFIELD", state: "IL", postcode: "62701" },
    ]);
  });

  it("finds city, state and ZIP without commas", () => {
    expect(parse("2 ridge st eastchester ny 10709")[0]).toEqual({
      number: "2", street: "RIDGE ST", city: "EASTCHESTER", state: "NY", postcode: "10709",
    });
    expect(parse("2 ridge st 10709")[0]).toEqual({ number: "2", street: "RIDGE ST", postcode: "10709" });
    expect(parse("2 ridge street eastchester")[0]).toEqual({ number: "2", street: "RIDGE ST", city: "EASTCHESTER" });
  });

  it("reads a half-typed place loosely", () => {
    expect(parse("2 ridge st 107")[0]).toEqual({ number: "2", street: "RIDGE ST", postcode: "107" });
    expect(parse("2 ridge st eastchester n")[0]).toEqual({ number: "2", street: "RIDGE ST", city: "EASTCHESTER" });
  });

  it("keeps a direction after the street type, but also tries it as a state", () => {
    const readings = parse("100 12th st ne washington dc");
    expect(readings[0]).toEqual({ number: "100", street: "12TH ST NE", city: "WASHINGTON", state: "DC" });
    expect(readings[1]).toEqual({ number: "100", street: "12TH ST", city: "NE WASHINGTON", state: "DC" });
  });

  it("always tries the whole text as a street too", () => {
    expect(parse("1 st james pl").map((q) => q.street)).toEqual(["ST JAMES PL"]);
    expect(parse("1 main st ext").map((q) => q.street)).toEqual(["MAIN ST", "MAIN ST EXT"]);
  });

  it("does not take an ordinal street for a house number", () => {
    expect(parse("5th ave")).toEqual([{ street: "5TH AVE" }]);
  });

  it("normalizes ordinals the way compact.py stores them", () => {
    expect(street("350 fifth avenue")).toBe("5TH AVE");
    expect(street("1 twenty-first st")).toBe("21ST ST");
    expect(street("1 twenty first st")).toBe("21ST ST");
    expect(street("1 n 05th st")).toBe("N 5TH ST");
    expect(street("1 12nd ave")).toBe("12TH AVE");
    expect(street("1 e 4 st")).toBe("E 4TH ST");
    expect(street("1 ninetieth st")).toBe("90TH ST");
  });

  it("leaves numbers that are not ordinals alone", () => {
    expect(street("1 highway 5")).toBe("HWY 5");
    expect(street("1 10 mile rd")).toBe("10 MILE RD");
  });

  it("loosens a half-typed last token", () => {
    expect(street("123 main stre")).toBe("MAIN ST");
    expect(street("350 5")).toBe("5");
    expect(street("350 5 av")).toBe("5TH AVE");
    expect(street("350 5 a")).toBe("5TH A");
    expect(street("350 e fift")).toBe("E");
    expect(parse("350 fift")).toEqual([]);
  });
});
