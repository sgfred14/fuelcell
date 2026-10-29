import { useState, useEffect } from "react";
import "./FuelCellReport.css";
import {
  BASE_CASE,
  netPower,
  NAV_ITEMS,
  NAV_IDS,
  OBJECTIVES,
  basisRows,
  resultRows,
  PIPING,
  LIMITATIONS,
  NEAR_TERM,
  EXTENDED,
} from "./reportData";

const C = BASE_CASE;
const NET = netPower(C);

/* ---------------- hooks ---------------- */

// NAV_IDS is a module-level constant, so the observer is created once
// (the original rebuilt it on every render because `ids` was a new array each time).
function useScrollSpy(ids) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

/* ---------------- small components ---------------- */

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none">
      <path d="M2 6.2L4.8 9L10 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Nav() {
  const active = useScrollSpy(NAV_IDS);
  return (
    <nav className="nav">
      <div className="nav__inner">
        <span className="nav__mark">
          <span className="nav__mark-dot" aria-hidden="true"></span>DT · FC
        </span>
        <div className="nav__links" role="navigation" aria-label="Sections">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={"#" + item.id}
              className={"nav__link" + (active === item.id ? " active" : "")}
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}

function HeroDiagram() {
  const mono = { fontFamily: "IBM Plex Mono" };
  return (
    <svg viewBox="0 0 360 360" width="100%" height="100%" style={{ maxWidth: 380 }} role="img" aria-label="Abstract loop of hydrogen, air, water and recovered power">
      <circle cx="180" cy="180" r="128" fill="none" stroke="var(--line-bright)" strokeWidth="1" />
      <circle cx="180" cy="180" r="128" fill="none" stroke="var(--cyan)" strokeWidth="2" strokeDasharray="6 10" className="pulse-path" opacity="0.8" />
      <circle cx="180" cy="52" r="5" fill="var(--cyan)" />
      <circle cx="308" cy="180" r="5" fill="var(--text-dim)" />
      <circle cx="180" cy="308" r="5" fill="#6FB6E8" />
      <circle cx="52" cy="180" r="5" fill="var(--amber)" />
      <text x="180" y="34" textAnchor="middle" {...mono} fontSize="13" fill="var(--cyan)">H₂</text>
      <text x="330" y="184" textAnchor="middle" {...mono} fontSize="13" fill="var(--text-dim)">Air</text>
      <text x="180" y="336" textAnchor="middle" {...mono} fontSize="13" fill="#6FB6E8">H₂O</text>
      <text x="30" y="184" textAnchor="middle" {...mono} fontSize="13" fill="var(--amber)">kW</text>
      <text x="180" y="176" textAnchor="middle" {...mono} fontSize="11" fill="var(--text-faint)">CRV-100</text>
      <text x="180" y="192" textAnchor="middle" fontFamily="Archivo" fontWeight="700" fontSize="15" fill="var(--text)">fuel cell</text>
    </svg>
  );
}

function StatChip({ value, unit, label, accent }) {
  return (
    <div className={"stat-chip" + (accent ? " stat-chip--accent" : "")}>
      <div className="stat-chip__val">
        {value}
        <span className="unit">{unit}</span>
      </div>
      <div className="stat-chip__label">{label}</div>
    </div>
  );
}

function Hero() {
  return (
    <header className="hero" id="top">
      <div className="container hero__inner">
        <div>
        
          <h1>
            Digital Twin-Based Fuel Cell <em>Utility Management</em> Platform
          </h1>
          <p className="hero__sub">
            A process-level digital twin of an integrated hydrogen fuel-cell system —
            reaction, hydrogen recycle, nitrogen recovery, water recovery and utility
            management, converged in a single Aspen HYSYS flowsheet.
          </p>
          <div className="hero__stats">
            <StatChip accent value={NET.toFixed(2)} unit="kW" label="net electrical power" />
            <StatChip value={C.conversion} unit="%" label="H₂ conversion" />
            <StatChip value={C.recycle.toFixed(3)} unit="kmol/h" label="recycle flow, RCY-1" />
            <StatChip value={C.b1.h2.toFixed(2)} unit="mol %" label="H₂ recovered in B1" />
          </div>
        </div>
        <div className="hero__diagram">
          <HeroDiagram />
        </div>
      </div>
    </header>
  );
}

function Section({ id, num, title, tag, lead, children, className }) {
  return (
    <section id={id} className={"section" + (className ? " " + className : "")}>
      <div className="container">
        <div className="section__head">
          {num && <div className="section__num">{num}</div>}
          <div>
            <h2 className="section__title">{title}</h2>
            {tag && <span className="section__tag">{tag}</span>}
          </div>
        </div>
        {lead && <p className="section__lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}

/* ---------------- process diagram ---------------- */

function DiagramBox({ x, y, w, h, label, sub }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="6" fill="var(--panel-2)" stroke="var(--line-bright)" strokeWidth="1.2" />
      <text x={x + w / 2} y={y + h / 2 - (sub ? 6 : -4)} textAnchor="middle" fontFamily="IBM Plex Mono" fontWeight="600" fontSize="13" fill="var(--text)">
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="9.5" fill="var(--text-faint)">
          {sub}
        </text>
      )}
    </g>
  );
}

function ProcessDiagram() {
  const cyan = "var(--cyan)", faint = "var(--text-faint)", amber = "var(--amber)", blue = "#6FB6E8";
  const mono = { fontFamily: "IBM Plex Mono" };
  return (
    <svg viewBox="0 0 1080 480" role="img" aria-label="Fuel-cell process flow diagram from mixer through reactor, separators and hydrogen recycle">
      <defs>
        <marker id="fc-ah2" markerWidth="7" markerHeight="7" refX="5.5" refY="2.5" orient="auto"><path d="M0,0L6,2.5L0,5Z" fill={cyan} /></marker>
        <marker id="fc-aair" markerWidth="7" markerHeight="7" refX="5.5" refY="2.5" orient="auto"><path d="M0,0L6,2.5L0,5Z" fill={faint} /></marker>
        <marker id="fc-awater" markerWidth="7" markerHeight="7" refX="5.5" refY="2.5" orient="auto"><path d="M0,0L6,2.5L0,5Z" fill={blue} /></marker>
      </defs>

      {/* feeds */}
      <text x="16" y="74" {...mono} fontSize="12" fill={cyan}>Fresh H₂</text>
      <text x="16" y="30" {...mono} fontSize="9.5" fill="var(--text-faint)">{C.freshH2.toFixed(3)} kmol/h</text>
      <line x1="16" y1="80" x2="118" y2="80" stroke={cyan} strokeWidth="1.6" markerEnd="url(#fc-ah2)" />
      <text x="16" y="312" {...mono} fontSize="12" fill={faint}>Air</text>
      <line x1="16" y1="322" x2="118" y2="322" stroke={faint} strokeWidth="1.6" markerEnd="url(#fc-aair)" />

      <DiagramBox x={120} y={58} w={110} h={44} label="MIX-100" sub="mixer" />
      <DiagramBox x={120} y={300} w={110} h={44} label="K-101" sub="air compr." />

      <line x1="230" y1="80" x2="284" y2="80" stroke={cyan} strokeWidth="1.6" markerEnd="url(#fc-ah2)" />
      <DiagramBox x={286} y={58} w={100} h={44} label="K-100" sub="H₂ compr." />

      <line x1="386" y1="80" x2="470" y2="120" stroke={cyan} strokeWidth="1.6" markerEnd="url(#fc-ah2)" />
      <line x1="230" y1="322" x2="470" y2="230" stroke={faint} strokeWidth="1.6" markerEnd="url(#fc-aair)" />

      <DiagramBox x={472} y={110} w={140} h={120} label="CRV-100" sub={`reactor · ${C.temperature}°C / ${C.pressure} bar`} />
      <text x="542" y="160" textAnchor="middle" {...mono} fontSize="9" fill={amber}>H₂+½O₂→H₂O</text>
      <path d="M542,110 q10,-26 26,-30" stroke={amber} strokeWidth="1.3" fill="none" strokeDasharray="3 4" />
      <text x="596" y="76" {...mono} fontSize="9.5" fill={amber}>H1 duty</text>

      <line x1="612" y1="140" x2="676" y2="110" stroke={cyan} strokeWidth="1.6" markerEnd="url(#fc-ah2)" />
      <DiagramBox x={678} y={88} w={96} h={44} label="E-100" sub="gas cooler" />
      <line x1="612" y1="200" x2="676" y2="300" stroke={blue} strokeWidth="1.6" markerEnd="url(#fc-awater)" />
      <DiagramBox x={678} y={278} w={96} h={44} label="E-101" sub="liquid cooler" />

      <line x1="774" y1="110" x2="838" y2="110" stroke={cyan} strokeWidth="1.6" markerEnd="url(#fc-ah2)" />
      <DiagramBox x={840} y={88} w={100} h={44} label="X-100" sub="N₂ split" />

      <line x1="940" y1="100" x2="1002" y2="60" stroke={faint} strokeWidth="1.6" markerEnd="url(#fc-aair)" />
      <text x="1006" y="56" {...mono} fontSize="10.5" fill="var(--text)">N₂ outlet</text>
      <text x="1006" y="70" {...mono} fontSize="9" fill="var(--text-faint)">≈{C.n2Product.toFixed(3)} kmol/h</text>

      <line x1="890" y1="132" x2="890" y2="188" stroke={cyan} strokeWidth="1.6" markerEnd="url(#fc-ah2)" />
      <text x="898" y="164" {...mono} fontSize="9.5" fill={cyan}>B1</text>
      <DiagramBox x={840} y={190} w={100} h={44} label="X-101" sub="H₂ / H₂O split" />

      <line x1="940" y1="222" x2="1002" y2="260" stroke={blue} strokeWidth="1.6" markerEnd="url(#fc-awater)" />
      <line x1="774" y1="300" x2="990" y2="292" stroke={blue} strokeWidth="1.6" markerEnd="url(#fc-awater)" />
      <text x="1006" y="278" {...mono} fontSize="10.5" fill="var(--text)">Water</text>
      <text x="1006" y="292" {...mono} fontSize="10.5" fill="var(--text)">recovery</text>

      <path d="M840,212 H 760 V 430 H 100 V 102" fill="none" stroke={cyan} strokeWidth="1.6" strokeDasharray="6 8" className="pulse-path" markerEnd="url(#fc-ah2)" />
      <text x="440" y="446" textAnchor="middle" {...mono} fontSize="10.5" fill={cyan}>
        RCY-1 hydrogen recycle · ≈{C.recycle.toFixed(3)} kmol/h
      </text>
    </svg>
  );
}

/* ---------------- accordion ---------------- */

function AccordionItem({ item, isOpen, onToggle }) {
  return (
    <div className={"accordion__item" + (isOpen ? " open" : "")}>
      <button className="accordion__trigger" aria-expanded={isOpen} onClick={onToggle}>
        {item.title}
        <span className="accordion__chev" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      </button>
      <div className="accordion__panel" style={{ maxHeight: isOpen ? "640px" : "0px" }}>
        <p className="accordion__note">{item.note}</p>
        <div className="accordion__panel-inner">
          <ul>
            {item.items.map((it) => (
              <li key={it}>{it}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Piping() {
  const [openIdx, setOpenIdx] = useState(0);
  return (
    <div>
      {PIPING.map((item, i) => (
        <AccordionItem
          key={item.title}
          item={item}
          isOpen={openIdx === i}
          onToggle={() => setOpenIdx(openIdx === i ? -1 : i)}
        />
      ))}
    </div>
  );
}

/* ---------------- results ---------------- */

function DataTable({ head, rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{head[0]}</th>
            <th>{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <td>{r[0]}</td>
              <td className="val">{r[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompositionBar() {
  const segs = [
    { label: `H₂ ${C.b1.h2}%`, pct: C.b1.h2, color: "var(--cyan)" },
    { label: `H₂O ${C.b1.h2o}%`, pct: C.b1.h2o, color: "#6FB6E8" },
    { label: `O₂ ${C.b1.o2}%`, pct: C.b1.o2, color: "var(--amber)" },
  ];
  return (
    <div className="bar-block">
      <h3>Stream B1 composition (pre hydrogen-recovery split)</h3>
      <div className="comp-bar">
        {segs.map((s) => (
          <div key={s.label} className="comp-seg" style={{ width: s.pct + "%", background: s.color }}>
            {s.pct > 8 ? s.label : ""}
          </div>
        ))}
      </div>
      <div className="legend">
        {segs.map((s) => (
          <div className="legend__item" key={s.label}>
            <span className="legend__swatch" style={{ background: s.color }}></span>
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function PowerWaterfall() {
  const rows = [
    { label: "Gross power", val: C.grossPower, color: "var(--cyan)" },
    { label: "− Compressor", val: C.compressorPower, color: "#8A4E2A" },
    { label: "− Cooling", val: C.coolingPower, color: "var(--amber-dim)" },
    { label: "Net power", val: NET, color: "var(--amber)" },
  ];
  const max = C.grossPower;
  return (
    <div className="bar-block">
      <h3>Gross-to-net power balance (kW)</h3>
      <div className="waterfall">
        {rows.map((r) => (
          <div className="wf-row" key={r.label}>
            <div className="wf-label">{r.label}</div>
            <div className="wf-track">
              <div className="wf-fill" style={{ width: (r.val / max) * 100 + "%", background: r.color }}></div>
            </div>
            <div className="wf-val">{+r.val.toFixed(4)} kW</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatBox({ value, unit, label }) {
  return (
    <div className="stat-box">
      <div className="stat-box__val">
        {value}
        <span className="unit"> {unit}</span>
      </div>
      <div className="stat-box__label">{label}</div>
    </div>
  );
}

/* ---------------- novelty ---------------- */

function TradeoffCurve() {
  const mono = { fontFamily: "IBM Plex Mono" };
  return (
    <div>
      <svg viewBox="0 0 420 260" role="img" aria-label="Illustrative curve of net electrical power against hydrogen recycle ratio, peaking at an intermediate value">
        <line x1="40" y1="220" x2="400" y2="220" stroke="var(--line-bright)" strokeWidth="1.2" />
        <line x1="40" y1="220" x2="40" y2="20" stroke="var(--line-bright)" strokeWidth="1.2" />
        <text x="220" y="248" textAnchor="middle" {...mono} fontSize="11" fill="var(--text-faint)">hydrogen recycle ratio →</text>
        <text x="18" y="120" textAnchor="middle" {...mono} fontSize="11" fill="var(--text-faint)" transform="rotate(-90 18 120)">net power →</text>
        <path d="M50,200 C 140,60 260,55 390,190" fill="none" stroke="var(--cyan)" strokeWidth="2.4" />
        <circle cx="228" cy="64" r="5" fill="var(--amber)" />
        <text x="228" y="48" textAnchor="middle" {...mono} fontSize="10.5" fill="var(--amber)">optimum region</text>
      </svg>
      <p className="curve-caption">
        Illustrative only — the optimum recycle ratio trades hydrogen savings against added compression load.
      </p>
    </div>
  );
}

function FutureList({ items }) {
  return items.map((f, i) => (
    <div className="future-item" key={f.h}>
      <div className="future-item__idx">{String(i + 1).padStart(2, "0")}</div>
      <div>
        <h4>{f.h}</h4>
        <p>{f.t}</p>
      </div>
    </div>
  ));
}

/* ---------------- page ---------------- */

export default function FuelCellReport() {
  return (
    <div className="fc-report">
      <div className="grid-bg" aria-hidden="true"></div>
      <Nav />
      <Hero />

      <Section id="overview" num="01" title="Overview" tag="Abstract & introduction">
        <div className="two-col">
          <div>
            <p className="section__lead" style={{ marginBottom: 20 }}>
              Hydrogen fuel cells convert the chemical energy of hydrogen directly into
              electricity, producing water and heat as their main by-products. This project
              develops a process-level digital twin of an integrated hydrogen fuel-cell
              utility platform in {C.software} — going beyond simple power generation to
              integrate hydrogen recovery and recycle, nitrogen recovery, water recovery,
              and cooling and compression utilities into one process system.
            </p>
            <p className="section__lead" style={{ marginBottom: 0 }}>
              A fuel-cell stack is only one part of a real plant. Balance-of-plant equipment —
              compressors, coolers, separators, piping and controls — consumes energy and
              shapes the useful net output. The novelty here is not any single unit operation,
              but integrating{" "}
              <strong style={{ color: "var(--text)" }}>
                electricity generation, hydrogen recovery, nitrogen recovery, water recovery and
                utility optimization
              </strong>{" "}
              within one simulation framework.
            </p>
            <div className="equation">
              H<sub>2</sub> + ½ O<sub>2</sub> → H<sub>2</sub>O
            </div>
          </div>
          <div className="card">
            <h3>What the twin is built from</h3>
            <p>
              A converged Aspen HYSYS flowsheet forms the process layer, while a linked HYSYS
              spreadsheet — the FC-Power layer — turns those results into electrical and
              utility-management figures.
            </p>
            <h3 style={{ marginTop: 22 }}>Why it matters</h3>
            <p>
              Treating hydrogen, nitrogen and water as recoverable resources — not waste —
              reframes the fuel cell from an isolated power unit into an integrated
              resource-recovery platform.
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="objectives"
        num="02"
        title="Objectives"
        tag="Twelve project goals"
        lead="The project set out twelve concrete goals, from building the base process model through to laying the groundwork for future optimization and PUPD development."
      >
        <div className="checklist">
          {OBJECTIVES.map((o) => (
            <div className="checklist__item" key={o}>
              <span className="checklist__mark">
                <CheckIcon />
              </span>
              <span className="checklist__text">{o}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="process"
        num="03"
        title="Process description"
        tag="Mixer → compression → reaction → recovery → recycle"
        lead="Fresh hydrogen joins the recycle stream in MIX-100, is compressed in K-100, and reacts with compressed air from K-101 inside CRV-100 — a conversion reactor standing in for the fuel-cell stack. The gas exhaust is cooled and split twice: first to pull off nitrogen, then to separate the remaining hydrogen-rich fraction from water. The hydrogen-rich stream closes the loop back to the mixer through RCY-1."
      >
        <div className="diagram-wrap">
          <ProcessDiagram />
        </div>
        <div className="legend">
          <div className="legend__item"><span className="legend__swatch" style={{ background: "var(--cyan)" }}></span>Hydrogen-bearing stream</div>
          <div className="legend__item"><span className="legend__swatch" style={{ background: "var(--text-faint)" }}></span>Air / nitrogen stream</div>
          <div className="legend__item"><span className="legend__swatch" style={{ background: "#6FB6E8" }}></span>Water stream</div>
          <div className="legend__item"><span className="legend__swatch" style={{ background: "var(--amber)" }}></span>Heat duty (H1)</div>
        </div>
      </Section>

      <Section
        id="basis"
        num="04"
        title="Simulation basis & assumptions"
        tag="Base case operating conditions"
        lead={`The ${C.efficiency}% fuel-cell electrical efficiency is a modelling assumption used in the utility-management spreadsheet, not a value the HYSYS reactor calculates directly — a rigorous PEM model would need cell voltage, current density and loss terms. The present model is best read as a process-integration and utility-management study rather than a detailed electrochemical stack model.`}
      >
        <DataTable head={["Parameter", "Base case"]} rows={basisRows(C)} />
      </Section>

      <Section
        id="piping"
        num="05"
        title="PUPD & piping design"
        tag="Utility routing for hydrogen, air, nitrogen, water and cooling"
        lead="Piping and utility design matter here because hydrogen, air, nitrogen, water and cooling all move through the plant. Each service line carries its own material, valving and instrumentation requirements — expand a category for detail."
      >
        <Piping />
      </Section>

      <Section id="results" num="06" title="Simulation results" tag="Converged base-case output">
        <div className="stat-grid">
          <StatBox value={C.recycle.toFixed(3)} unit="kmol/h" label="Recycle flow" />
          <StatBox value={C.n2Product.toFixed(3)} unit="kmol/h" label="Nitrogen product" />
          <StatBox value={C.grossPower.toFixed(2)} unit="kW" label="Gross electrical power" />
          <StatBox value={NET.toFixed(2)} unit="kW" label="Net electrical power" />
        </div>
        <CompositionBar />
        <PowerWaterfall />
        <DataTable head={["Stream / quantity", "Value"]} rows={resultRows(C)} />
      </Section>

      <Section
        id="twin"
        num="07"
        title="Digital twin architecture"
        tag="Two linked layers"
        lead="The twin is built from two interconnected layers: Aspen HYSYS provides the converged process picture, and a linked FC-Power spreadsheet turns those results into utility-management figures."
      >
        <div className="twin-grid">
          <div className="twin-col twin-col--process">
            <h3>PROCESS LAYER · ASPEN HYSYS</h3>
            <ul>
              {["Stream flow rates", "Temperatures & pressures", "Component compositions", "Reactor conversion", "Heat duties", "Separation results", "Recycle convergence", "Compressor & cooler duty"].map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="twin-arrow" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path d="M4 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="twin-col twin-col--utility">
            <h3>UTILITY-MANAGEMENT LAYER · FC-POWER SHEET</h3>
            <ul>
              {["Gross electrical power", "Compressor consumption", "Cooling requirement", "Net electrical power", "Hydrogen recovery", "Nitrogen production", "Specific energy consumption"].map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section
        id="novelty"
        num="08"
        title="Novelty & engineering significance"
        tag="From power generation to resource-recovery platform"
        lead="A conventional fuel-cell model focuses on electrical output alone. This platform widens the system boundary to include hydrogen recycle, nitrogen recovery, water recovery, heat management and the utilities that make them possible."
      >
        <div className="novelty-wrap">
          <div>
            <p className="body-text" style={{ marginBottom: 16 }}>
              Hydrogen recycle turns unreacted hydrogen from a loss into a resource-efficiency
              loop. Nitrogen recovery adds a second potential product from the same air feed.
              But the two aren't free: raising hydrogen recovery can raise recycle flow, and
              with it, compression load — so the best operating point is rarely the maximum
              possible recycle ratio.
            </p>
            <p className="body-text">
              The digital twin's real job is finding the region where hydrogen consumption is
              low, recovery is high, nitrogen output holds, auxiliary power stays low, and net
              electrical power is maximized — all at once.
            </p>
          </div>
          <TradeoffCurve />
        </div>
      </Section>

      <Section
        id="safety"
        num="09"
        title="Safety & limitations"
        tag="Hydrogen handling and model boundaries"
        lead="Hydrogen leakage can form a flammable mixture, so leak prevention, ventilation and detection are treated as first-order design requirements, not add-ons."
      >
        <div className="safety-grid">
          <div className="safety-card">
            <h3>Required safety layer</h3>
            <p>
              Hydrogen detectors, adequate ventilation, pressure-relief systems, emergency
              shutdown valves and safe venting arrangements throughout the hydrogen-handling
              sections of the plant.
            </p>
          </div>
          <div className="safety-card">
            <h3>Model limitations</h3>
            <ul className="limits-list">
              {LIMITATIONS.map((l) => (
                <li key={l.b}>
                  <b>{l.b}</b>
                  {l.t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section
        id="future"
        title="Future perspectives"
        className="future-section"
        lead="The report already sets out a clear next phase for the model itself. Alongside it, here's where the platform could go beyond this study — extending it from a steady-state PUPD simulation toward a live, connected digital twin."
      >
        <span className="future-badge">Extended beyond the original report</span>
        <div className="future-columns">
          <div className="future-col future-col--report">
            <div className="future-col-head">FROM THE REPORT · extending the current model</div>
            <FutureList items={NEAR_TERM} />
          </div>
          <div className="future-col future-col--ext">
            <div className="future-col-head">EXTENDED VISION · beyond the report</div>
            <FutureList items={EXTENDED} />
          </div>
        </div>
      </Section>

      <Section id="conclusion" num="10" title="Conclusion" tag="Where the platform stands today">
        <div className="conclusion-inner">
          <p>
            A preliminary <strong>Digital Twin-Based Fuel Cell Utility Management Platform</strong>{" "}
            has been built in {C.software}, integrating hydrogen and air compression, the
            fuel-cell reaction, exhaust cooling, nitrogen recovery, water recovery and hydrogen
            recycle in one converged flowsheet.
          </p>
          <p>
            At the current base case — {C.freshH2} kmol/h fresh hydrogen, {C.conversion}% conversion,
            ≈{C.temperature} °C and ≈{C.pressure} bar — the simulation converges with ≈
            {C.recycle.toFixed(3)} kmol/h recycle flow and ≈{C.n2Product.toFixed(3)} kmol/h nitrogen
            product; the hydrogen-rich separation stream holds ≈{C.b1.h2} mol% hydrogen, confirming
            it's suitable for recycle. On an assumed {C.efficiency}% electrical efficiency, gross
            output is {C.grossPower.toFixed(2)} kW, and net output after compressor and cooling
            utilities is approximately <strong>{Math.round(NET)} kW</strong>.
          </p>
          <p>
            Its significance is integrating electricity generation with resource recovery and
            utility management, rather than treating the fuel cell as an isolated unit. The HYSYS
            model is a foundation for evaluating how process conditions, recycle, product recovery
            and energy consumption interact — and, longer term, for growing from a steady-state
            PUPD study into a dynamic digital twin with real-time monitoring, advanced control,
            economic optimization and experimental validation.
          </p>
        </div>
      </Section>

      <footer>
        <div className="container footer-inner">
          <span>Digital Twin-Based Fuel Cell Utility Management Platform</span>
          <span>
            {C.software} · {C.propertyPackage} basis
          </span>
        </div>
      </footer>
    </div>
  );
}