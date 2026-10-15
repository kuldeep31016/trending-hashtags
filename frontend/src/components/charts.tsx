import { useId, useMemo, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table2, LineChart as LineIcon } from "lucide-react";
import { colorMap, fmtClock, fmtInt, fmtNum, fmtSecs } from "../lib/format";
import { CountUp } from "../lib/anim";
import type { Run, Sentiment, SeriesPoint, TrendEvent } from "../lib/types";
import { Empty } from "./ui";

/* ---------- shared tooltip ------------------------------------------------------------ */

function TipBox({ title, rows }: { title: ReactNode; rows: { color?: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="min-w-[160px] rounded-[8px] border border-line-strong bg-surface px-3 py-2 text-[12px]" style={{ boxShadow: "var(--shadow)" }}>
      <div className="num mb-1.5 text-ink-3">{title}</div>
      <ul className="space-y-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-ink-2">
              {r.color && <span aria-hidden className="inline-block h-[3px] w-3 rounded-full" style={{ background: r.color }} />}
              {r.label}
            </span>
            <span className="num font-medium text-ink">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ViewToggle({ table, onChange }: { table: boolean; onChange: (t: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!table)}
      aria-pressed={table}
      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink"
    >
      {table ? <LineIcon size={14} aria-hidden /> : <Table2 size={14} aria-hidden />}
      {table ? "Chart" : "Table"}
    </button>
  );
}

function Legend({ items }: { items: { key: string; color: string; label: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Legend">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-[3px] w-3.5 rounded-full" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

const axisTick = { fontSize: 11 };

/* ---------- hashtag counts over windows ----------------------------------------------- */

/** Insert an empty row where windows are missing (pipeline outage) so lines break there
 * instead of drawing a straight line through time nobody measured. */
function withGaps(rows: Record<string, number>[], keys: string[]) {
  if (rows.length < 3) return rows;
  const gaps = rows.slice(1).map((r, i) => r.end_ts - rows[i].end_ts).sort((a, b) => a - b);
  const limit = Math.max(180, 3 * gaps[Math.floor(gaps.length / 2)]);
  const out: Record<string, number | null>[] = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].end_ts - rows[i - 1].end_ts > limit) {
      const gap: Record<string, number | null> = { end_ts: (rows[i].end_ts + rows[i - 1].end_ts) / 2 };
      keys.forEach((k) => (gap[k] = null));
      out.push(gap);
    }
    out.push(rows[i]);
  }
  return out as Record<string, number>[];
}

export function TrendChart({
  series,
  tags,
  events = [],
  height = 300,
  table = false,
}: {
  series: Record<string, SeriesPoint[]>;
  tags: string[];
  events?: TrendEvent[];
  height?: number;
  table?: boolean;
}) {
  const colors = colorMap(tags);
  const gid = useId().replace(/:/g, "");
  const reduce = useReducedMotion();
  const data = useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    tags.forEach((t) =>
      (series[t] ?? []).forEach((p) => {
        const row = byTs.get(p.end_ts) ?? { end_ts: p.end_ts };
        row[t] = p.count;
        byTs.set(p.end_ts, row);
      }),
    );
    const rows = [...byTs.values()].sort((a, b) => a.end_ts - b.end_ts);
    return withGaps(rows, tags);
  }, [series, tags]);

  const surges = events.filter((e) => e.kind === "surge" && e.tag && tags.includes(e.tag) && e.end_ts);

  if (!tags.length) return <Empty title="Select at least one hashtag" />;
  if (data.length < 2)
    return (
      <Empty title="Not enough history yet">
        {data.length === 1 ? "One window has been processed so far." : "No windows in this range."} The chart needs at least two
        MapReduce windows; one is produced roughly every minute (longer when a job overruns).
      </Empty>
    );

  if (table) {
    return (
      <div className="max-h-[360px] overflow-auto">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              <th className="eyebrow px-3 py-2 text-left">Window end</th>
              {tags.map((t) => (
                <th key={t} className="eyebrow px-3 py-2 text-right">#{t}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...data].filter((r) => tags.some((t) => r[t] != null)).reverse().map((r) => (
              <tr key={r.end_ts} className="border-t border-line">
                <td className="num px-3 py-1.5 text-ink-2">{fmtClock(r.end_ts, true)}</td>
                {tags.map((t) => (
                  <td key={t} className="num px-3 py-1.5 text-right">{fmtInt(r[t] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Legend items={tags.map((t) => ({ key: t, color: colors[t], label: `#${t}` }))} />
        {surges.length > 0 && (
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
            <svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" fill="var(--surface)" stroke="var(--ink-2)" strokeWidth="1.5" /></svg>
            surge detected
          </span>
        )}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              {tags.map((t) => (
                <linearGradient key={t} id={`${gid}-${t}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: colors[t], stopOpacity: tags.length > 2 ? 0.14 : 0.24 }} />
                  <stop offset="100%" style={{ stopColor: colors[t], stopOpacity: 0 }} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="end_ts" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={(v) => fmtClock(v)} tick={axisTick} minTickGap={40} />
            <YAxis tick={axisTick} width={52} allowDecimals={false} tickFormatter={(v) => fmtInt(v)} />
            <Tooltip
              cursor={{ stroke: "var(--accent)", strokeWidth: 1, strokeDasharray: "4 4" }}
              animationDuration={150}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TipBox
                    title={`Window ending ${fmtClock(Number(label), true)}`}
                    rows={[...payload]
                      .filter((p) => p.value != null)
                      .sort((a, b) => Number(b.value) - Number(a.value))
                      .map((p) => ({ color: colors[String(p.dataKey)], label: `#${p.dataKey}`, value: fmtInt(Number(p.value)) }))}
                  />
                ) : null
              }
            />
            {tags.map((t, i) => (
              <Area
                key={t}
                type="monotoneX"
                dataKey={t}
                stroke={colors[t]}
                strokeWidth={2.25}
                fill={`url(#${gid}-${t})`}
                dot={data.length <= 24 ? { r: 2.5, strokeWidth: 0, fill: colors[t] } : false}
                activeDot={{ r: 5, strokeWidth: 3, stroke: "var(--surface)" }}
                isAnimationActive={!reduce}
                animationDuration={1100}
                animationBegin={i * 120}
                animationEasing="ease-out"
                connectNulls={false}
              />
            ))}
            {surges.map((e) => {
              const row = data.find((d) => d.end_ts === e.end_ts);
              const y = row?.[e.tag as string];
              return y === undefined ? null : (
                <ReferenceDot key={`${e.tag}-${e.end_ts}`} x={e.end_ts} y={y} r={6} fill="var(--surface)" stroke={colors[e.tag as string]} strokeWidth={2.5} />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ---------- MapReduce job duration per run -------------------------------------------- */

export function DurationChart({ runs, interval, height = 200 }: { runs: Run[]; interval: number; height?: number }) {
  const reduce = useReducedMotion();
  // failed/skipped runs have no job time: draw a short stub so they stay visible
  const data = runs.map((r) => ({ ...r, value: r.job_seconds ?? Math.max(4, interval * 0.08) }));
  if (!data.length) return <Empty title="No MapReduce runs recorded yet" />;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="started_at" tickFormatter={(v) => fmtClock(v)} tick={axisTick} minTickGap={36} />
          <YAxis tick={axisTick} width={48} tickFormatter={(v) => `${v}s`} />
          <ReferenceLine
            y={interval}
            stroke="var(--ink-3)"
            strokeDasharray="4 4"
            label={{ value: `${interval}s schedule`, position: "insideTopRight", fill: "var(--ink-3)", fontSize: 10 }}
          />
          <Tooltip
            cursor={{ fill: "var(--raised)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as Run;
              return (
                <TipBox
                  title={`Started ${fmtClock(r.started_at, true)}`}
                  rows={[
                    { label: "Status", value: r.status === "success" ? "Succeeded" : r.status === "skipped" ? "Skipped: no input" : "Failed" },
                    { label: "Job duration", value: r.status === "success" ? fmtSecs(r.job_seconds) : "—" },
                    { label: "Attempts", value: r.attempts },
                    { label: "Schedule delay", value: fmtSecs(r.schedule_delay) },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="value" radius={[5, 5, 0, 0]} isAnimationActive={!reduce} animationDuration={900} maxBarSize={22}>
            {data.map((r, i) => (
              <Cell key={i} fill={r.status === "success" ? "var(--s1)" : r.status === "skipped" ? "var(--line-strong)" : "var(--critical)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---------- sentiment ----------------------------------------------------------------- */

export const SENTIMENT = [
  { key: "positive", label: "Positive", color: "var(--pos)" },
  { key: "neutral", label: "Neutral", color: "var(--neu)" },
  { key: "negative", label: "Negative", color: "var(--neg)" },
] as const;

export function SentimentDonut({ s, size = 150 }: { s: Sentiment; size?: number }) {
  const reduce = useReducedMotion();
  const total = s.positive + s.neutral + s.negative;
  const data = SENTIMENT.map((k) => ({ name: k.label, value: s[k.key], color: k.color }));
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" innerRadius={size * 0.36} outerRadius={size * 0.48} paddingAngle={1.5} stroke="var(--surface)" strokeWidth={2} isAnimationActive={!reduce} animationDuration={1000} startAngle={90} endAngle={-270} cornerRadius={4}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <CountUp value={total} className="num display text-[22px]" />
          <span className="text-[11px] text-ink-3">labeled tweets</span>
        </div>
      </div>
      <table className="min-w-[200px] flex-1 text-[13px]">
        <tbody>
          {SENTIMENT.map((k) => (
            <tr key={k.key} className="border-b border-line last:border-0">
              <td className="py-1.5">
                <span className="flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: k.color }} />
                  {k.label}
                </span>
              </td>
              <td className="num py-1.5 text-right font-medium">{total ? fmtNum((s[k.key] / total) * 100, 1) : "—"}%</td>
              <td className="num py-1.5 pl-4 text-right text-ink-3">{fmtInt(s[k.key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal 100% stacked bar per hashtag (2px surface gaps between segments). */
export function SentimentBars({ rows }: { rows: ({ tag: string; count: number } & Partial<Sentiment>)[] }) {
  if (!rows.length) return <Empty title="No per-hashtag sentiment in this window" />;
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => {
        const tot = (r.positive ?? 0) + (r.neutral ?? 0) + (r.negative ?? 0);
        return (
          <li key={r.tag} className="grid grid-cols-[minmax(110px,160px)_1fr_auto] items-center gap-3 text-[12.5px]">
            <span className="truncate font-medium">#{r.tag}</span>
            <div className="grow-x flex h-3 gap-[2px] overflow-hidden rounded-full" style={{ animationDelay: `${i * 0.06}s` }} role="img"
              aria-label={`#${r.tag}: ${SENTIMENT.map((k) => `${k.label} ${tot ? Math.round(((r[k.key] ?? 0) / tot) * 100) : 0}%`).join(", ")}`}>
              {SENTIMENT.map((k) => {
                const v = r[k.key] ?? 0;
                return v > 0 ? (
                  <div key={k.key} title={`${k.label}: ${fmtInt(v)} (${fmtNum((v / tot) * 100, 1)}%)`} style={{ width: `${(v / tot) * 100}%`, background: k.color }} />
                ) : null;
              })}
            </div>
            <span className="num w-14 text-right text-ink-3">{tot ? `${Math.round(((r.positive ?? 0) / tot) * 100)}% +` : "—"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- generic single-series line (ingest throughput, totals) -------------------- */

export function SimpleLine({
  data,
  x,
  y,
  color = "var(--s1)",
  height = 180,
  format = (v: number) => fmtInt(v),
  label,
  bars = false,
}: {
  data: Record<string, number | null>[];
  x: string;
  y: string;
  color?: string;
  height?: number;
  format?: (v: number) => string;
  label: string;
  bars?: boolean;
}) {
  const gid = useId().replace(/:/g, "");
  const reduce = useReducedMotion();
  if (data.length < 2) return <Empty title="Not enough data points yet" />;
  const tip = ({ active, payload, label: l }: any) =>
    active && payload?.length ? <TipBox title={fmtClock(Number(l), true)} rows={[{ color, label, value: format(Number(payload[0].value)) }]} /> : null;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {bars ? (
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey={x} tickFormatter={(v) => fmtClock(v)} tick={axisTick} minTickGap={36} />
            <YAxis tick={axisTick} width={52} tickFormatter={(v) => format(v)} />
            <Tooltip cursor={{ fill: "var(--raised)" }} content={tip} />
            <Bar dataKey={y} fill={color} radius={[5, 5, 0, 0]} isAnimationActive={!reduce} animationDuration={900} maxBarSize={18} />
          </BarChart>
        ) : (
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.25 }} />
                <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey={x} type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => fmtClock(v)} tick={axisTick} minTickGap={36} />
            <YAxis tick={axisTick} width={52} tickFormatter={(v) => format(v)} />
            <Tooltip cursor={{ stroke: "var(--accent)", strokeDasharray: "4 4" }} content={tip} />
            <Area type="monotoneX" dataKey={y} stroke={color} strokeWidth={2.25} fill={`url(#${gid})`} dot={false} isAnimationActive={!reduce} animationDuration={1000} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 3 }} />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
