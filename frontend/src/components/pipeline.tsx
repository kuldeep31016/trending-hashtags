import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Code2, Cpu, Crown, Database, Flame, Loader, LogIn, LogOut, Radio } from "lucide-react";
import { CountUp } from "../lib/anim";
import { useLive } from "../lib/live";
import { useInjected } from "../lib/meta";
import { agoFromTs, fmtAgo, fmtClock, fmtInt, fmtNum, fmtSecs } from "../lib/format";
import type { Health, Metrics, Stage, TrendEvent } from "../lib/types";
import { Empty, IconTile, SimulatedBadge, StateLabel, type Tint } from "./ui";

/** Re-render/refetch tick that stops while visual updates are paused. */
export function useTick(seconds: number) {
  const { paused } = useLive();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setN((x) => x + 1), seconds * 1000);
    return () => clearInterval(t);
  }, [seconds, paused]);
  return n;
}

function StageCard({
  icon,
  tint,
  name,
  role,
  stage,
  lines,
  index,
}: {
  icon: ReactNode;
  tint: Tint;
  name: string;
  role: string;
  stage: Stage | undefined;
  lines: [string, ReactNode][];
  index: number;
}) {
  const reduce = useReducedMotion();
  const state = stage ? (stage.in_use ? stage.state : "unknown") : "unknown";
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 + index * 0.08 }}
      className="card-lift relative flex min-w-0 flex-1 flex-col rounded-[12px] border border-line bg-surface p-3.5"
    >
      <div className="flex items-center gap-3">
        <IconTile tint={tint} size={40}>{icon}</IconTile>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-bold leading-tight">{name}</div>
          <div className="truncate text-[11.5px] text-ink-3">{role}</div>
        </div>
      </div>
      <dl className="mt-3 space-y-1 text-[12.5px]">
        {lines.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-ink-3">{k}</dt>
            <dd className="num truncate text-right font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto pt-3 text-[12.5px]">
        {stage?.in_use === false ? (
          <span className="text-ink-3">Not used in simulation</span>
        ) : stage?.state === "healthy" && name === "Hadoop MapReduce" && stage.driver?.status === "running" ? (
          <span className="inline-flex items-center gap-1.5 font-semibold text-accent">
            <Loader size={13} aria-hidden className="motion-safe:animate-spin" /> Running job
          </span>
        ) : (
          <StateLabel state={state} size={13} />
        )}
        {stage && stage.in_use && stage.state !== "healthy" && (
          <p className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-3" title={stage.summary}>{stage.summary}</p>
        )}
      </div>
    </motion.div>
  );
}

/** Arrow between stages; dots travel along it only while data actually flows (both ends healthy). */
function Connector({ active }: { active: boolean }) {
  const { paused } = useLive();
  const on = active && !paused;
  return (
    <div className="relative hidden w-10 shrink-0 self-center lg:block" aria-hidden style={{ ["--flow-len" as string]: "40px" }}>
      <div className="h-[2px] rounded-full" style={{ background: on ? "linear-gradient(90deg, var(--accent-soft), var(--accent))" : "var(--line-strong)" }} />
      <ArrowRight size={14} className="absolute -right-1 -top-[6px]" style={{ color: on ? "var(--accent)" : "var(--ink-3)" }} />
      {on &&
        [0, 0.53, 1.06].map((d) => (
          <span key={d} className="flow-dot absolute -top-[2px] left-0 size-[6px] rounded-full bg-accent" style={{ animationDelay: `${d}s` }} />
        ))}
    </div>
  );
}

export function PipelineFlow({ health, metrics }: { health: Health | null; metrics: Metrics | null }) {
  const st = health?.stages;
  const prod = st?.kafka.producer;
  const k = st?.kafka.check;
  const h = st?.hdfs.check;
  const mr = st?.mapreduce;
  const last = mr?.last_success;
  const api = st?.api;
  const ok = (s?: Stage) => !!s && s.in_use && s.state === "healthy";
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch lg:gap-1.5">
      <StageCard
        index={0}
        tint="violet"
        icon={<Radio size={19} />}
        name="Kafka"
        role="Streaming ingest"
        stage={st?.kafka}
        lines={[
          ["Producer", prod?.rate_per_s ? <><CountUp value={prod.rate_per_s} format={(v) => v.toFixed(1)} />/s</> : "Not measured"],
          ["Partitions", k?.partitions ?? "—"],
          ["Consumer lag", k?.consumer_lag != null ? <CountUp value={k.consumer_lag} /> : "—"],
        ]}
      />
      <Connector active={ok(st?.kafka) && ok(st?.hdfs)} />
      <StageCard
        index={1}
        tint="green"
        icon={<Database size={19} />}
        name="HDFS"
        role="Data storage"
        stage={st?.hdfs}
        lines={[
          ["Written / min", metrics?.ingest.tweets_written_last_min != null ? <CountUp value={metrics.ingest.tweets_written_last_min} /> : "Not measured"],
          ["Ingest lag", metrics?.ingest.avg_ingest_lag_s != null ? fmtSecs(metrics.ingest.avg_ingest_lag_s) : "—"],
          ["Last write", h?.last_write ? fmtAgo(agoFromTs(h.last_write)) : "—"],
        ]}
      />
      <Connector active={ok(st?.hdfs) && ok(st?.mapreduce)} />
      <StageCard
        index={2}
        tint="blue"
        icon={<Cpu size={19} />}
        name="Hadoop MapReduce"
        role="Batch processing"
        stage={mr}
        lines={[
          ["Last job", last?.job_seconds != null ? <CountUp value={last.job_seconds} format={(v) => `${v.toFixed(1)} s`} /> : "—"],
          ["Finished", last?.finished_at ? fmtClock(last.finished_at, true) : "—"],
          ["Driver", mr?.driver?.status ?? "—"],
        ]}
      />
      <Connector active={ok(st?.mapreduce) && ok(st?.api)} />
      <StageCard
        index={3}
        tint="sky"
        icon={<Code2 size={19} />}
        name="Leaderboard API"
        role="Serving results"
        stage={api}
        lines={[
          ["Response", api?.latency?.avg_ms != null ? `${fmtNum(api.latency.avg_ms, 1)} ms` : "—"],
          ["p95", api?.latency?.p95_ms != null ? `${fmtNum(api.latency.p95_ms, 1)} ms` : "—"],
          ["Snapshot age", api?.freshness?.age_seconds != null ? fmtSecs(api.freshness.age_seconds) : "—"],
        ]}
      />
    </div>
  );
}

const EVENT = {
  new_leader: { Icon: Crown, verb: "took the #1 spot", color: "var(--tint-blue)", bg: "var(--tint-blue-bg)" },
  entered_top: { Icon: LogIn, verb: "entered the top 5", color: "var(--tint-green)", bg: "var(--tint-green-bg)" },
  left_top: { Icon: LogOut, verb: "left the top 5", color: "var(--ink-3)", bg: "var(--raised)" },
  surge: { Icon: Flame, verb: "is surging", color: "var(--tint-amber)", bg: "var(--tint-amber-bg)" },
} as const;

function describe(e: TrendEvent) {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "new_leader":
      return d.previous ? `replacing #${d.previous}` : "";
    case "entered_top":
      return `at #${d.rank} with ${fmtInt(Number(d.count))} mentions`;
    case "left_top":
      return `was #${d.previous_rank}`;
    case "surge":
      return `${fmtInt(Number(d.count))} mentions vs ${fmtNum(Number(d.baseline_count), 0)} baseline · score ${fmtNum(Number(d.trend_score), 1)}`;
  }
}

export function EventList({ events, compact = false }: { events: TrendEvent[]; compact?: boolean }) {
  const injected = useInjected();
  const reduce = useReducedMotion();
  if (!events.length)
    return (
      <Empty title="No trend events yet">
        Events are recorded when a hashtag takes #1, enters or leaves the top 5, or its trend score crosses the surge threshold.
      </Empty>
    );
  return (
    <ol className="relative">
      <span aria-hidden className="absolute bottom-3 left-[15px] top-3 w-px bg-line" />
      {events.map((e, i) => {
        const meta = EVENT[e.kind];
        return (
          <motion.li
            key={e.id ?? i}
            initial={reduce ? false : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.3 }}
            className={`relative flex gap-3 ${compact ? "py-2" : "py-2.5"}`}
          >
            <span className="relative z-[1] inline-flex size-[31px] shrink-0 items-center justify-center rounded-full ring-4 ring-surface" style={{ background: meta.bg, color: meta.color }}>
              <meta.Icon size={14} aria-hidden strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1 text-[13px]">
              <div className="flex flex-wrap items-center gap-x-1.5">
                {e.tag && (
                  <Link to={`/explorer/${encodeURIComponent(e.tag)}`} className="font-semibold hover:text-accent hover:underline">
                    #{e.tag}
                  </Link>
                )}
                <span className="text-ink-2">{meta.verb}</span>
                {e.tag && injected.has(e.tag) && (e.kind === "surge" || e.kind === "new_leader") && <SimulatedBadge />}
              </div>
              <div className="truncate text-[12px] text-ink-3">{describe(e)}</div>
            </div>
            <time className="num shrink-0 pt-0.5 text-[11.5px] text-ink-3">{fmtClock(e.end_ts ?? null)}</time>
          </motion.li>
        );
      })}
    </ol>
  );
}
