import { bandText, fmt, fmtDuration, fmtSci, fmtUnit, median, minutesBetween, worst } from "./format";

describe("format helpers", () => {
  it("formats numbers and gaps", () => {
    expect(fmt(3.14159, 2)).toBe("3.14");
    expect(fmt(null)).toBe("—");
    expect(fmt(Number.NaN)).toBe("—");
    expect(fmt(12345.6, 0)).toBe("12,346");
  });
  it("formats scientific notation for extreme values", () => {
    expect(fmtSci(0.000042, 2)).toBe("4.20e-5");
    expect(fmtSci(1200000, 2)).toBe("1.20e+6");
    expect(fmtSci(0.752, 3)).toBe("0.752");
    expect(fmtSci(null)).toBe("—");
  });
  it("attaches units the way operators write them", () => {
    expect(fmtUnit(97.04, "K", 1)).toBe("97.0 K");
    expect(fmtUnit(-3.2, "%", 1)).toBe("-3.2%");
    expect(fmtUnit(null, "K")).toBe("—");
  });
  it("describes durations", () => {
    expect(fmtDuration(0)).toBe("just now");
    expect(fmtDuration(18)).toBe("18 min");
    expect(fmtDuration(120)).toBe("2 h");
    expect(fmtDuration(125)).toBe("2 h 05 min");
    expect(minutesBetween("2026-03-01T06:00:00Z", "2026-03-01T06:42:00Z")).toBe(42);
  });
  it("picks the worst status", () => {
    expect(worst("ok", "warning", "alarm")).toBe("alarm");
    expect(worst("ok", "unknown")).toBe("ok");
  });
  it("writes limit bands", () => {
    expect(bandText(null, 103, "K", 1)).toBe("> 103 K");
    expect(bandText(-5, 5, "%", 1)).toBe("< -5 or > 5%");
    expect(bandText(null, null, "K")).toBe("—");
  });
  it("median", () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
