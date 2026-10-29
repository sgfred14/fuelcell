interface Props {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
}

/** Tiny trend line. Gaps (null) break the line. Decorative: the number next to it carries the information. */
export function Sparkline({ values, width = 92, height = 26, color = "currentColor" }: Props) {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const span = hi - lo || 1;
  const step = width / Math.max(values.length - 1, 1);
  let d = "";
  let pen = false;
  let lastX = 0;
  let lastY = 0;
  let hasLast = false;

  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { pen = false; return; }
    const x = i * step;
    const y = height - 3 - ((v - lo) / span) * (height - 6);
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
    lastX = x;
    lastY = y;
    hasLast = true;
  });

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="spark">
      <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--color-border)" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.6" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
      {hasLast && <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="1.8" fill={color} />}
    </svg>
  );
}
