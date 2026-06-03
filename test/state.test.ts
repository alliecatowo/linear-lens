import { describe, it, expect } from "vitest";
import {
  STATE_TYPES,
  normalizeStateType,
  stateColor,
  stateEmoji,
  stateLabel,
} from "../src/format/state";

describe("normalizeStateType", () => {
  it("accepts each known type", () => {
    for (const t of STATE_TYPES) {
      expect(normalizeStateType(t)).toBe(t);
    }
  });

  it("is case-insensitive and trims", () => {
    expect(normalizeStateType("  Started ")).toBe("started");
    expect(normalizeStateType("COMPLETED")).toBe("completed");
  });

  it("returns undefined for unknown / missing values", () => {
    expect(normalizeStateType("nope")).toBeUndefined();
    expect(normalizeStateType("")).toBeUndefined();
    expect(normalizeStateType(undefined)).toBeUndefined();
  });
});

describe("stateEmoji", () => {
  it("maps each type to a reliable circle glyph", () => {
    expect(stateEmoji("backlog")).toBe("⚪");
    expect(stateEmoji("unstarted")).toBe("⚪");
    expect(stateEmoji("started")).toBe("🔵");
    expect(stateEmoji("completed")).toBe("🟢");
    expect(stateEmoji("canceled")).toBe("⚫");
    expect(stateEmoji("triage")).toBe("🟠");
  });

  it("falls back to a neutral circle for unknown types", () => {
    expect(stateEmoji("mystery")).toBe("⚪");
    expect(stateEmoji(undefined)).toBe("⚪");
  });

  it("never returns an empty string", () => {
    for (const t of [...STATE_TYPES, "x", undefined]) {
      expect(stateEmoji(t as string | undefined).length).toBeGreaterThan(0);
    }
  });
});

describe("stateColor", () => {
  it("returns a lowercase #rrggbb for every known type", () => {
    for (const t of STATE_TYPES) {
      expect(stateColor(t)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("falls back to a neutral gray for unknown / missing types", () => {
    expect(stateColor("nope")).toMatch(/^#[0-9a-f]{6}$/);
    expect(stateColor(undefined)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("stateLabel", () => {
  it("prefers the live state name", () => {
    expect(stateLabel({ state: "In Review", stateType: "started" })).toBe("In Review");
  });

  it("falls back to a human label derived from the type", () => {
    expect(stateLabel({ stateType: "started" })).toBe("In Progress");
    expect(stateLabel({ state: "   ", stateType: "completed" })).toBe("Done");
  });

  it("returns an empty string when neither name nor known type is present", () => {
    expect(stateLabel({})).toBe("");
    expect(stateLabel(undefined)).toBe("");
    expect(stateLabel({ stateType: "bogus" })).toBe("");
  });
});
