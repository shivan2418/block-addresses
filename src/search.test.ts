import { describe, expect, it } from "vitest";
import { parse } from "./search";

const street = (input: string) => parse(input).street;

describe("parse", () => {
  it("splits number, street and place", () => {
    expect(parse("300 e capitol ave, springfield il 62701")).toEqual({
      number: "300", street: "E CAPITOL AVE", city: "SPRINGFIELD", state: "IL", postcode: "62701",
    });
  });

  it("does not take an ordinal street for a house number", () => {
    expect(parse("5th ave")).toEqual({ street: "5TH AVE" });
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
    expect(street("350 fift")).toBeUndefined();
  });
});
