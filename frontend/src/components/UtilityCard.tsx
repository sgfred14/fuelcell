import { Fuel, ShieldAlert, Thermometer, Waves, Wind, Zap } from "lucide-react";
import type { ChannelDef, CheckDef, HistoryPoint, Tick, UtilityDef } from "../types";
import { fmt, fmtUnit } from "../lib/format";
import { Sparkline } from "./Sparkline";
import { StatusBadge, StatusDot } from "./StatusBadge";

const ICONS = { fuel: Fuel, wind: Wind, thermo: Thermometer, bolt: Zap, steam: Waves, shield: ShieldAlert } as const;

interface Props {
  def: UtilityDef;
  tick: Tick | null;
  history: HistoryPoint[];
  checks: CheckDef[];
  channels: ChannelDef[];
  selected: boolean;
  onSelect: () => void;
}

export function UtilityCard({ def, tick, history, checks, channels, selected, onSelect }: Props) {
  const status = tick?.utilities[def.id]?.status ?? "unknown";
  const Icon = ICONS[def.icon as keyof typeof ICONS] ?? Zap;
  const recent = history.slice(-60);
  const myChecks = checks.filter((c) => def.checks.includes(c.id));
  const staleHere = def.channels.filter((c) => tick?.stale.includes(c));
  return (
    <article className={`ucard ucard-${status}${selected ? " is-selected" : ""}`} aria-label={`${def.name}: ${status}`}>
      <header className="ucard-head">
        <button type="button" className="ucard-title" onClick={onSelect} aria-pressed={selected}>
          <Icon size={18} aria-hidden="true" />
          <span>
            <strong>{def.name}</strong>
            <small>{def.blurb}</small>
          </span>
        </button>
        <StatusBadge status={status} />
      </header>

      <div className="readings">
        {def.key.map((ch) => {
          const meta = channels.find((c) => c.id === ch);
          const v = tick?.values[ch] ?? null;
          const dec = Math.abs(v ?? 0) >= 100 ? 0 : Math.abs(v ?? 0) >= 10 ? 1 : 2;
          return (
            <div className="reading" key={ch}>
              <span className="reading-label">{meta?.label ?? ch}</span>
              <span className="reading-value num">
                {fmt(v, dec)}
                <small>{meta?.unit}</small>
              </span>
              <Sparkline values={recent.map((h) => h.v[ch] ?? null)} />
            </div>
          );
        })}
      </div>

      <ul className="checks" aria-label={`${def.name} checks`}>
        {myChecks.map((c) => {
          const st = tick?.checks[c.id];
          return (
            <li key={c.id}>
              <StatusDot status={st?.status ?? "unknown"} />
              <span className="check-label">{c.label}</span>
              <span className="check-value num">{fmtUnit(st?.value ?? null, c.unit, c.decimals)}</span>
            </li>
          );
        })}
      </ul>
      {staleHere.length > 0 && <p className="stale-note">No fresh data: {staleHere.join(", ")}</p>}
    </article>
  );
}
