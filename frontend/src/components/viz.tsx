import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * Small bar chart of the last N real values (e.g. tweets per window). Bars grow from the
 * baseline with a stagger; the newest bar is fully opaque, older ones fade back. Hovering a bar
 * shows its exact value.
 */
export function MiniBars({
  values,
  color = "var(--accent)",
  width = 72,
  height = 34,
  format = (v: number) => v.toLocaleString(),
  label,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  format?: (v: number) => string;
  label: string;
}) {
  const reduce = useReducedMotion();
  const [grown, setGrown] = useState(!!reduce);
  const ready = values.length >= 2;
  useEffect(() => {
    if (!ready) return; // start growing only once there is something to draw
    const t = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(t);
  }, [ready]);
  const vals = values.slice(-10);
  if (vals.length < 2) return null;
  const max = Math.max(...vals, 1);
  const gap = 3;
  const bw = (width - gap * (vals.length - 1)) / vals.length;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: last ${vals.length} windows`} className="shrink-0 overflow-visible">
      {vals.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 2));
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={height - h}
            width={bw}
            height={h}
            rx={Math.min(2.5, bw / 2)}
            fill={color}
            opacity={0.3 + 0.7 * ((i + 1) / vals.length)}
            style={{
              transformBox: "fill-box",
              transformOrigin: "bottom",
              transform: grown ? "scaleY(1)" : "scaleY(0)",
              transition: reduce ? undefined : `transform 0.7s cubic-bezier(0.2, 0, 0, 1) ${i * 45}ms`,
            }}
          >
            <title>{format(v)}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Circular progress (0..1) with content in the middle; animates between values. */
export function Ring({
  value,
  size = 64,
  stroke = 6,
  color = "var(--accent)",
  spinning = false,
  children,
  label,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  spinning?: boolean;
  children?: React.ReactNode;
  label: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} className={spinning ? "motion-safe:animate-spin [animation-duration:1.6s]" : ""}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--raised)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={spinning ? c * 0.72 : c * (1 - v)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.9s linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}
