import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CircleCheck, CircleHelp, CircleX, Inbox, Minus, RefreshCw } from "lucide-react";
import type { HealthState } from "../lib/types";
import { CountUp } from "../lib/anim";

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClass = "px-5 pb-5 pt-2",
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`fade-up card-hover rounded-[var(--radius-card)] border border-line bg-surface ${className}`}
      style={{ boxShadow: "var(--card-shadow)" }}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-[17px] font-bold leading-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

const STATE: Record<HealthState, { label: string; color: string; Icon: typeof CircleCheck }> = {
  healthy: { label: "Healthy", color: "var(--good)", Icon: CircleCheck },
  degraded: { label: "Degraded", color: "var(--warning)", Icon: AlertTriangle },
  down: { label: "Down", color: "var(--critical)", Icon: CircleX },
  unknown: { label: "Unknown", color: "var(--ink-3)", Icon: CircleHelp },
};

/** Status always ships as icon + label; color is never the only signal. */
export function StateLabel({ state, size = 14, className = "" }: { state: HealthState; size?: number; className?: string }) {
  const s = STATE[state] ?? STATE.unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${className}`} style={{ color: s.color }}>
      <s.Icon size={size} aria-hidden strokeWidth={2.2} />
      <span>{s.label}</span>
    </span>
  );
}

export function StateDot({ state }: { state: HealthState }) {
  const s = STATE[state] ?? STATE.unknown;
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: s.color }} />;
}

export function stateColor(state: HealthState) {
  return (STATE[state] ?? STATE.unknown).color;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Inbox size={20} className="text-ink-3" aria-hidden />
      <p className="font-medium text-ink-2">{title}</p>
      {children && <div className="max-w-md text-[13px] text-ink-3">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 border-l-2 border-critical bg-raised/60 px-3 py-2 text-[13px]">
      <span className="text-ink-2">
        <span className="font-medium text-ink">Could not load: </span>
        {message}
      </span>
      {onRetry && (
        <button onClick={onRetry} className="inline-flex items-center gap-1 text-accent hover:underline">
          <RefreshCw size={13} aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}

export function Unavailable({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-ink-3">{children}</span>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-[9px] border border-line bg-surface-2 p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`rounded-[7px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors duration-200 ${
              on ? "bg-accent text-white shadow-sm" : "text-ink-2 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className = "",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-9 cursor-pointer appearance-none rounded-[10px] border border-line bg-surface pl-3 pr-8 text-[12.5px] font-semibold text-ink shadow-sm transition-colors hover:border-line-strong"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg aria-hidden viewBox="0 0 10 6" className="pointer-events-none absolute right-3 h-1.5 w-2.5 text-ink-3">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </label>
  );
}

let sparkId = 0;

/** Area sparkline that draws itself in (stroke dash) and fades its gradient fill. */
export function Sparkline({ series, color = "var(--accent)", width = 110, height = 28, label }: {
  series: number[];
  color?: string;
  width?: number;
  height?: number;
  label?: string;
}) {
  const [id] = useState(() => `spark-${++sparkId}`);
  if (!series || series.length < 2) {
    return <span className="text-[11px] text-ink-3">{series?.length === 1 ? "1 window" : "—"}</span>;
  }
  const max = Math.max(...series, 1);
  const pts = series.map((v, i) => [(i / (series.length - 1)) * (width - 4) + 2, height - 3 - (v / max) * (height - 6)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `trend over ${series.length} windows`} className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} className="spark-fill" />
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="spark-line" />
      <circle cx={lx} cy={ly} r={2.5} fill={color} className="spark-dot" />
    </svg>
  );
}

/** Rank movement: NEW is its own state (violet), distinct from "moved up" (green). */
export function Movement({ delta }: { delta: number | null | undefined }) {
  const pill = "inline-flex min-w-[38px] items-center justify-center gap-0.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold";
  if (delta === null || delta === undefined)
    return <span className={`${pill} bg-new-soft tracking-wide text-new`}>NEW</span>;
  if (delta > 0)
    return (
      <span className={`${pill} bg-good-soft text-good`} aria-label={`up ${delta}`}>
        <ArrowUp size={12} aria-hidden strokeWidth={2.6} />
        <span className="num">{delta}</span>
      </span>
    );
  if (delta < 0)
    return (
      <span className={`${pill} bg-critical-soft text-critical`} aria-label={`down ${-delta}`}>
        <ArrowDown size={12} aria-hidden strokeWidth={2.6} />
        <span className="num">{-delta}</span>
      </span>
    );
  return (
    <span className={`${pill} text-ink-3`} aria-label="no change">
      <Minus size={13} aria-hidden />
    </span>
  );
}

export type Tint = "blue" | "violet" | "sky" | "green" | "amber";

/** Soft tinted square holding an icon (the mockup's KPI / pipeline tiles). */
export function IconTile({ tint, children, size = 44 }: { tint: Tint; children: ReactNode; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[12px]"
      style={{ width: size, height: size, background: `var(--tint-${tint}-bg)`, color: `var(--tint-${tint})` }}
    >
      {children}
    </span>
  );
}

export function Change({ pct, invert = false, suffix = "vs previous window" }: { pct: number | null; invert?: boolean; suffix?: string }) {
  if (pct === null) return null;
  const good = invert ? pct < 0 : pct > 0;
  const flat = Math.abs(pct) < 0.05;
  const color = flat ? "var(--ink-3)" : good ? "var(--good)" : "var(--critical)";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
      <span className="num inline-flex items-center gap-0.5 font-semibold" style={{ color }}>
        {flat ? "±0%" : <>{pct > 0 ? <ArrowUp size={12} strokeWidth={2.6} aria-hidden /> : <ArrowDown size={12} strokeWidth={2.6} aria-hidden />}{Math.abs(pct).toFixed(1)}%</>}
      </span>
      {suffix}
    </span>
  );
}

export function KeyValue({ k, v, mono = true }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
      <dt className="text-ink-3">{k}</dt>
      <dd className={`text-right font-medium text-ink ${mono ? "num" : ""}`}>{typeof v === "number" ? <CountUp value={v} /> : v}</dd>
    </div>
  );
}

/** Compact animated statistic: tinted icon tile, label, counting value, optional sub-line. */
export function StatTile({
  icon,
  tint,
  label,
  value,
  format,
  sub,
  delay = 0,
}: {
  icon: ReactNode;
  tint: Tint;
  label: string;
  value: number | null | undefined;
  format?: (v: number) => string;
  sub?: ReactNode;
  delay?: number;
}) {
  return (
    <div
      className="fade-up card-lift flex items-center gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4"
      style={{ boxShadow: "var(--card-shadow)", animationDelay: `${delay}s` }}
    >
      <IconTile tint={tint} size={44}>{icon}</IconTile>
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ink-2">{label}</div>
        <div className="num display text-[24px] leading-tight">
          {value == null ? <span className="text-[15px] font-medium text-ink-3">Not yet available</span> : <CountUp value={value} format={format} />}
        </div>
        {sub && <div className="truncate text-[12px] text-ink-3">{sub}</div>}
      </div>
    </div>
  );
}

export function SimulatedBadge({ title }: { title?: string }) {
  return (
    <span
      title={title ?? "Injected into the demo dataset on purpose; not a naturally occurring trend"}
      className="inline-flex items-center rounded-[4px] border border-line-strong px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-3"
    >
      Simulated
    </span>
  );
}
