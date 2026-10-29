// All report content and base-case numbers live here.
// When the HYSYS model is re-run, update BASE_CASE — every chart, table,
// stat chip and the conclusion text read from it. Net power is derived.

export const BASE_CASE = {
  software: "Aspen HYSYS V14",
  propertyPackage: "NRTL Electrolyte",
  freshH2: 1.0,            // kmol/h
  mixedFeed: 1.248,        // kmol/h
  recycle: 0.248,          // kmol/h (RCY-1)
  conversion: 80,          // %
  temperature: 80,         // °C
  pressure: 3,             // bar
  efficiency: 50,          // % (assumed)
  n2Product: 1.88,         // kmol/h
  b1: { h2: 78.47, h2o: 21.34, o2: 0.19 }, // mol %
  grossPower: 28.5,        // kW
  compressorPower: 0.1363, // kW
  coolingPower: 2.613,     // kW
};

export const netPower = (c = BASE_CASE) =>
  c.grossPower - c.compressorPower - c.coolingPower;

export const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "objectives", label: "Objectives" },
  { id: "process", label: "Process" },
  { id: "basis", label: "Basis" },
  { id: "piping", label: "Piping" },
  { id: "results", label: "Results" },
  { id: "twin", label: "Digital twin" },
  { id: "novelty", label: "Novelty" },
  { id: "safety", label: "Safety" },
  { id: "future", label: "Future" },
  { id: "conclusion", label: "Conclusion" },
];

export const NAV_IDS = NAV_ITEMS.map((n) => n.id);

export const OBJECTIVES = [
  "Develop a hydrogen–air fuel-cell process model in Aspen HYSYS V14",
  "Represent the overall fuel-cell reaction with a conversion reactor",
  "Simulate hydrogen and air compression requirements",
  "Recover unreacted hydrogen from the fuel-cell exhaust",
  "Recycle recovered hydrogen back to the fuel-cell feed",
  "Recover nitrogen from the air-derived exhaust stream",
  "Recover a water-rich product stream",
  "Calculate gross electrical power from a fuel-cell efficiency model",
  "Determine auxiliary power consumed by compression and cooling",
  "Calculate the net electrical power of the integrated system",
  "Establish a digital-twin framework for future optimization",
  "Provide a preliminary piping and utility basis for PUPD development",
];

export const basisRows = (c = BASE_CASE) => [
  ["Fresh hydrogen feed", `${c.freshH2.toFixed(3)} kmol/h`],
  ["Hydrogen conversion", `${c.conversion}%`],
  ["Fuel-cell temperature", `≈ ${c.temperature} °C`],
  ["Operating pressure", `≈ ${c.pressure} bar`],
  ["Fuel-cell electrical efficiency", `${c.efficiency}% (assumed)`],
  ["Reactor model", "Conversion reactor (CRV-100)"],
  ["Property basis", c.propertyPackage],
  ["Simulation type", "Steady state"],
  ["Software", c.software],
];

export const resultRows = (c = BASE_CASE) => [
  ["Fresh H₂ feed", `${c.freshH2.toFixed(3)} kmol/h`],
  ["Total mixed fuel feed", `≈ ${c.mixedFeed.toFixed(3)} kmol/h`],
  ["Recycle flow (RCY-1)", `≈ ${c.recycle.toFixed(3)} kmol/h`],
  ["Nitrogen product", `≈ ${c.n2Product.toFixed(3)} kmol/h`],
  ["H₂ in stream B1", `${(c.b1.h2 / 100).toFixed(4)} mole fraction`],
  ["H₂O in stream B1", `${(c.b1.h2o / 100).toFixed(4)} mole fraction`],
  ["O₂ in stream B1", `${(c.b1.o2 / 100).toFixed(4)} mole fraction`],
];

export const PIPING = [
  {
    title: "Hydrogen piping",
    note: "Fresh and recycle hydrogen run in closed piping — stainless steel such as SS 316L suits high-purity hydrogen service for its cleanliness and corrosion resistance. Hydrogen is never handled through open ventilation ducts.",
    items: ["Isolation valves", "Check valves", "Pressure-relief devices", "Flow-control valves", "Emergency shutdown valves", "Pressure & flow measurement"],
  },
  {
    title: "Air piping & ducting",
    note: "The air feed runs through process piping or low-pressure ducting depending on the final equipment layout.",
    items: ["Flow-control valve before K-101", "Pressure measurement before K-101"],
  },
  {
    title: "Fuel-cell exhaust",
    note: "The hot exhaust leaving CRV-100 is carried in appropriately rated piping or ducting, insulated where needed to limit heat loss and protect personnel.",
    items: ["Heat-rated piping/ducting", "Insulation where required"],
  },
  {
    title: "Nitrogen product line",
    note: "Recovered nitrogen leaves X-100 through a dedicated product line.",
    items: ["Isolation valve", "Pressure indicator", "Flow measurement"],
  },
  {
    title: "Water line",
    note: "The water-rich product from E-101 and X-101 runs through liquid-service piping.",
    items: ["Suitable drains", "Isolation valves"],
  },
  {
    title: "Cooling-water system",
    note: "E-100 and E-101 both draw on a shared cooling-water utility.",
    items: ["Supply line", "Return line", "Control valve", "Temperature indicators", "Flow measurement"],
  },
  {
    title: "Safety & relief systems",
    note: "Because hydrogen is highly flammable, the detailed plant carries a dedicated safety layer, checked against ASME B31.3 Process Piping requirements.",
    items: ["Hydrogen leak detection", "Adequate ventilation", "Pressure-relief systems", "Emergency shutdown systems", "Safe venting", "Electrical-area classification", "Grounding & bonding"],
  },
];

export const LIMITATIONS = [
  { b: "CRV-100 is a conversion reactor, ", t: "not a rigorous PEM electrochemical model — electrical output is calculated separately from an assumed efficiency rather than from cell voltage and current density." },
  { b: "X-100 and X-101 are component splitters, ", t: "a simplified stand-in for real nitrogen-recovery and hydrogen/water separation equipment." },
  { b: "The model is steady state, ", t: "while an actual fuel-cell system sees continuous swings in load, hydrogen supply, air flow, temperature and pressure." },
];

export const NEAR_TERM = [
  { h: "Rigorous PEM electrochemical model", t: "Replace the assumed efficiency with cell voltage, current density, and activation, ohmic and concentration losses." },
  { h: "Polarization-curve modelling", t: "Characterize stack performance across load, matching the digital twin to real stack behaviour." },
  { h: "Dynamic simulation", t: "Move from steady state to time-resolved behaviour under load, supply and temperature swings." },
  { h: "Hydrogen purge optimization", t: "Tune recycle purge to balance hydrogen utilization against inert build-up in the loop." },
  { h: "Heat integration & equipment sizing", t: "Detailed heat integration plus compressor, heat-exchanger and pipe sizing for a buildable design." },
  { h: "Economic & sensitivity analysis", t: "Vary conversion, efficiency, pressure and recycle ratio; cost the resulting design points." },
  { h: "Control-system design", t: "Define the control philosophy and loops for the compressors, coolers and recycle loop." },
  { h: "Safety analysis & experimental validation", t: "HAZOP-style review of the flowsheet and validation of key results against bench or pilot data." },
];

export const EXTENDED = [
  { h: "Live sensor synchronization", t: "Feed real plant instrumentation — flow, temperature, pressure, stack current — into the HYSYS-based twin so it tracks the actual unit rather than only a design case." },
  { h: "ML surrogates & learned control", t: "Train fast surrogate models on converged HYSYS cases for millisecond predictions, and explore reinforcement-learning agents that tune recycle ratio and compressor duty on the fly." },
  { h: "Coupling to green-hydrogen supply", t: "Extend the boundary upstream to an electrolyzer run on renewables, turning the platform into an end-to-end production-to-power twin." },
  { h: "Multi-stack scale-up & grid integration", t: "Grow the single fuel-cell block into a multi-stack farm feeding a microgrid, with load-following and grid-support studies." },
  { h: "Twin-based predictive maintenance", t: "Flag compressor, cooler or membrane degradation early by watching the gap between live plant data and twin predictions." },
  { h: "Cloud dashboard & digital thread", t: "Publish the utility-management layer as a browser dashboard — this site's natural successor — linking design, commissioning and operating data over the asset's life." },
  { h: "Techno-economic & carbon accounting", t: "Add capital and operating cost correlations plus carbon-intensity tracking, so the recycle-vs-auxiliary-power trade-off is optimized on cost and emissions, not kW alone." },
  { h: "Immersive training & virtual HAZOP", t: "Drive AR/VR walkthroughs from the twin's own geometry and stream data for operator training and virtual hazard reviews of the hydrogen system." },
  { h: "Standards-aligned certification path", t: "Align the twin with emerging digital-twin and functional-safety standards alongside ASME B31.3 piping compliance, ahead of eventual plant certification." },
];