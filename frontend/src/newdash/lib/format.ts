import type { Status } from "../types";

export const RANK: Record<Status, number> = { unknown: 0, ok: 0, warning: 1, alarm: 2 };

export function worst(...s: Status[]): Status {
  let w: Status = "ok";
  for (const x of s) if (RANK[x] > RANK[w]) w = x;
  return w;
}

export function fmt(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtSigned(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v > 0 ? "+" : "") + fmt(v, decimals);
}

export function fmtUnit(v: number | null | undefined, unit: string, decimals = 1): string {
  const n = fmt(v, decimals);
  if (n === "—" || !unit) return n;
  return unit === "%" || unit === "×" ? `${n}${unit}` : `${n} ${unit}`;
}

/** Formats number using scientific notation for very small/large magnitudes, or standard decimals */
export function fmtSci(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (v !== 0 && (Math.abs(v) < 0.001 || Math.abs(v) >= 1e5)) {
    return v.toExponential(decimals);
  }
  return fmt(v, decimals);
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
}

export function fmtDuration(min: number): string {
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}

export function statusLabel(s: Status): string {
  return { ok: "Normal", warning: "Warning", alarm: "Alarm", unknown: "No data" }[s];
}

export function sourceLabel(src: string): string {
  return { physics: "Limit check", learned: "Learned model", sensor: "Sensor" }[src] ?? src;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Band text such as "> 103 K" or "< −5 or > 5 %" for a check limit pair. */
export function bandText(lo: number | null, hi: number | null, unit: string, decimals = 1): string {
  const u = unit && unit !== "%" && unit !== "×" ? ` ${unit}` : unit;
  const f = (x: number) => fmt(x, Math.abs(x) >= 100 ? 0 : decimals).replace(/\.0+$/, "");
  if (lo !== null && hi !== null) return `< ${f(lo)} or > ${f(hi)}${u}`;
  if (hi !== null) return `> ${f(hi)}${u}`;
  if (lo !== null) return `< ${f(lo)}${u}`;
  return "—";
}
