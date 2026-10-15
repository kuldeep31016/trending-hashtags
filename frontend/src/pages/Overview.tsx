import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, ArrowUpRight, ChevronRight, Clock, Database, Hash, MessageSquare, TrendingDown, TrendingUp } from "lucide-react";
import { useLive, rangeFrom } from "../lib/live";
import { useResource } from "../lib/api";
import { useMeta, useInjected } from "../lib/meta";
import { CountUp } from "../lib/anim";
import { fmtClock, fmtInt, fmtNum, fmtSecs, nowMs, pctChange } from "../lib/format";
import type { History, Metrics, Run, SentimentResponse, TrendEvent } from "../lib/types";
import { Card, Change, Empty, ErrorNote, IconTile, KeyValue, SimulatedBadge, Skeleton, StateLabel, Unavailable, type Tint } from "../components/ui";
import { LeaderboardTable, type RankMode } from "../components/LeaderboardTable";
import { DurationChart, SentimentDonut, TrendChart, ViewToggle } from "../components/charts";
import { EventList, PipelineFlow, useTick } from "../components/pipeline";
import { TagPicker } from "../components/TagPicker";
import { MiniBars, Ring } from "../components/viz";

function Kpi({
  icon,
  tint,
  label,
  value,
  foot,
  chart,
  title,
  index,
  to,
}: {
  icon: ReactNode;
  tint: Tint;
  label: string;
  value: ReactNode;
  foot: ReactNode;
  chart?: ReactNode;
  title?: string;
  index: number;
  to?: string;
}) {
  const reduce = useReducedMotion();
  const body = (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: index * 0.07, ease: [0.2, 0, 0, 1] }}
      className="card-lift group relative flex h-full min-w-0 items-start gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5"
      style={{ boxShadow: "var(--card-shadow)" }}
      title={title}
    >
      <IconTile tint={tint} size={48}>{icon}</IconTile>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink-2">{label}</div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="num display text-[30px] leading-none tracking-tight">{value}</div>
          {chart}
        </div>
        <div className="mt-2.5 min-h-[18px]">{foot}</div>
      </div>
      {to && <ChevronRight size={18} aria-hidden className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-3 transition-transform duration-200 group-hover:translate-x-0.5" />}
    </motion.div>
  );
  return to ? (
    <Link to={to} className="block rounded-[var(--radius-card)]" aria-label={`${label}: open details`}>
      {body}
    </Link>
  ) : (
    body
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(nowMs());
  useEffect(() => {
    const t = setInterval(() => setNow(nowMs()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Countdown to the driver's next scheduled MapReduce run, from its real heartbeat. */
function NextRun({ interval }: { interval: number }) {
  const { health, leaderboard } = useLive();
  const now = useNow(1000) / 1000;
  const drv = health?.stages.mapreduce.driver;
  if (leaderboard?.source === "local-sim") {
    return <Ring value={1} size={74} label="Simulation"><span className="text-[11px] text-ink-3">sim</span></Ring>;
  }
  if (!drv?.status) return <Ring value={0} size={74} label="Driver not seen"><span className="text-[11px] text-ink-3">—</span></Ring>;
  if (drv.status === "running" || drv.status === "retrying") {
    return (
      <Ring value={0.3} spinning size={74} color="var(--tint-violet)" label="MapReduce job running">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-2">{drv.status === "retrying" ? "Retry" : "Running"}</span>
      </Ring>
    );
  }
  const left = drv.next_run_at ? Math.max(0, drv.next_run_at - now) : null;
  const frac = left == null ? 0 : 1 - Math.min(1, left / interval);
  return (
    <Ring value={frac} size={74} color="var(--accent)" label={left == null ? "Driver idle" : `Next run in ${Math.ceil(left)} seconds`}>
      <span className="num text-[15px] font-bold leading-none">{left == null ? "—" : `${Math.ceil(left)}s`}</span>
      <span className="mt-0.5 text-[9.5px] uppercase tracking-wide text-ink-3">next run</span>
    </Ring>
  );
}

function Movers() {
  const { leaderboard: lb } = useLive();
  const injected = useInjected();
  const reduce = useReducedMotion();
  const scored = (lb?.trending ?? []).filter((e) => e.growth != null);
  const up = scored.slice(0, 3);
  const down = [...(lb?.top ?? [])]
    .filter((e) => e.growth != null && (e.growth ?? 0) < 0)
    .sort((a, b) => (a.growth ?? 0) - (b.growth ?? 0))
    .slice(0, 2);
  if (!up.length && !down.length)
    return <Empty title="Movers appear after 5 minutes">Growth needs a baseline window that ended one window length earlier.</Empty>;
  const row = (e: { tag: string; count: number; growth?: number | null; baseline_count?: number | null }, i: number, rising: boolean) => (
    <motion.li
      key={e.tag + rising}
      initial={reduce ? false : { opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: i * 0.06, duration: 0.35 }}
      className="flex items-center gap-3 rounded-[10px] px-2 py-2 transition-colors duration-150 hover:bg-surface-2"
    >
      <IconTile tint={rising ? "green" : "amber"} size={32}>
        {rising ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Link to={`/explorer/${encodeURIComponent(e.tag)}`} className="truncate font-semibold hover:text-accent">#{e.tag}</Link>
          {injected.has(e.tag) && <SimulatedBadge />}
        </div>
        <div className="num text-[11.5px] text-ink-3">
          {fmtInt(e.count)} now · {fmtNum(e.baseline_count ?? null, 0)} baseline
        </div>
      </div>
      <span className={`num text-[13px] font-bold ${rising ? "text-good" : "text-critical"}`}>
        {(e.growth ?? 0) > 0 ? "+" : ""}
        {fmtNum((e.growth ?? 0) * 100, 0)}%
      </span>
    </motion.li>
  );
  return (
    <ul className="space-y-0.5">
      {up.map((e, i) => row(e, i, true))}
      {down.map((e, i) => row(e, i + up.length, false))}
    </ul>
  );
}

export default function Overview() {
  const { leaderboard: lb, health, windowKey, settings } = useLive();
  const meta = useMeta();
  const [mode, setMode] = useState<RankMode>("volume");
  const [tableView, setTableView] = useState(false);
  const tick = useTick(15);

  const top = lb?.top ?? [];
  const [picked, setPicked] = useState<string[] | null>(null);
  const tags = useMemo(() => picked ?? top.slice(0, 3).map((e) => e.tag), [picked, top]);
  useEffect(() => {
    if (picked && top.length && picked.every((t) => !top.some((e) => e.tag === t))) setPicked(null);
  }, [top, picked]);

  const from = rangeFrom(settings.range, lb?.window_end);
  const histPath = tags.length ? `/api/history?tags=${tags.join(",")}${from ? `&from=${from}` : ""}` : null;
  const history = useResource<History>(histPath, windowKey);
  const events = useResource<{ items: TrendEvent[] }>(`/api/events?limit=60${from ? `&from=${from}` : ""}`, windowKey);
  const metrics = useResource<Metrics>("/api/metrics", `${windowKey}|${tick}`);
  const runs = useResource<{ items: Run[] }>("/api/runs?limit=40", windowKey);
  const sentiment = useResource<SentimentResponse>("/api/sentiment?limit=1", windowKey);

  const prev = lb?.previous;
  const prevLabel = prev?.window_end ? `vs ${fmtClock(prev.window_end)} window` : "";
  const interval = meta?.pipeline.interval_seconds ?? 60;
  const isSim = lb?.source === "local-sim";
  const snaps = history.data?.snapshots ?? [];
  const okRuns = (runs.data?.items ?? []).filter((r) => r.status === "success" && r.job_seconds != null);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
        <Kpi
          index={0}
          tint="blue"
          icon={<MessageSquare size={22} />}
          label="Tweets in window"
          value={lb?.total_tweets != null ? <CountUp value={lb.total_tweets} /> : <Skeleton className="h-8 w-28" />}
          chart={<MiniBars values={snaps.map((s) => s.total_tweets)} color="var(--tint-blue)" label="Tweets per window" />}
          foot={prev ? <Change pct={pctChange(lb?.total_tweets, prev.total_tweets)} suffix={prevLabel} /> : <Unavailable>No previous window to compare yet</Unavailable>}
        />
        <Kpi
          index={1}
          tint="violet"
          icon={<Hash size={22} />}
          label="Active hashtags"
          title="Distinct hashtags counted by MapReduce in the window"
          value={lb?.distinct_tags != null ? <CountUp value={lb.distinct_tags} /> : lb ? <Unavailable>Not yet measured</Unavailable> : <Skeleton className="h-8 w-16" />}
          chart={<MiniBars values={snaps.map((s) => s.tag_mentions)} color="var(--tint-violet)" label="Hashtag mentions per window" />}
          foot={
            prev?.distinct_tags != null ? (
              <Change pct={pctChange(lb?.distinct_tags, prev.distinct_tags)} suffix={prevLabel} />
            ) : (
              <Unavailable>
                <CountUp value={lb?.tag_mentions} /> hashtag mentions
              </Unavailable>
            )
          }
        />
        <Kpi
          index={2}
          tint="sky"
          icon={<Clock size={22} />}
          label={isSim ? "Simulated job duration" : "MapReduce job duration"}
          value={lb?.job_seconds != null ? <CountUp value={lb.job_seconds} format={(v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`)} /> : lb ? <Unavailable>Not yet measured</Unavailable> : <Skeleton className="h-8 w-20" />}
          chart={<MiniBars values={okRuns.map((r) => r.job_seconds as number)} color="var(--tint-sky)" format={(v) => `${v.toFixed(1)} s`} label="Job seconds per run" />}
          foot={
            prev?.job_seconds != null ? (
              <Change pct={pctChange(lb?.job_seconds, prev.job_seconds)} invert suffix={`vs previous (${fmtSecs(prev.job_seconds)})`} />
            ) : (
              <Unavailable>Schedule interval {interval} s</Unavailable>
            )
          }
        />
        <Kpi
          index={3}
          tint="green"
          icon={<Database size={22} />}
          label="Pipeline status"
          to="/pipeline"
          value={health ? <StateLabel state={health.status} size={22} className="text-[26px]" /> : <Skeleton className="h-8 w-28" />}
          foot={
            health ? (
              <span className="text-[12px] text-ink-3">
                {health.status === "healthy"
                  ? isSim ? "Simulation running normally" : "All components operational"
                  : Object.entries(health.stages).filter(([, s]) => s.in_use && s.state !== "healthy").map(([n]) => n).join(", ") + " need attention"}
              </span>
            ) : (
              <Unavailable>Waiting for first health check</Unavailable>
            )
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card title="Top trending hashtags" subtitle={`Top 10 in the last ${lb?.window_minutes ?? 5} minutes`} bodyClass="">
          <LeaderboardTable mode={mode} onModeChange={setMode} />
        </Card>
        <Card
          title="Trend activity"
          subtitle={`Mentions per processing window${settings.range === "all" ? "" : ` · last ${settings.range} min`}`}
          actions={<ViewToggle table={tableView} onChange={setTableView} />}
        >
          <TagPicker options={top.map((e) => e.tag)} value={tags} onChange={setPicked} />
          <div className="mt-3">
            {history.error && <ErrorNote message={history.error.message} onRetry={history.reload} />}
            {!history.data && history.loading ? (
              <Skeleton className="h-[300px]" />
            ) : history.data ? (
              <TrendChart series={history.data.series} tags={tags} events={events.data?.items ?? []} table={tableView} height={330} />
            ) : null}
          </div>
        </Card>
      </div>

      <Card
        title="Pipeline flow"
        subtitle="Real-time data pipeline status and latency"
        actions={<Link to="/pipeline" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent hover:underline">Details <ArrowRight size={13} aria-hidden /></Link>}
      >
        <PipelineFlow health={health} metrics={metrics.data} />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        <Card
          title="Sentiment snapshot"
          subtitle="Sentiment distribution in the current window"
          actions={<Link to="/sentiment" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent hover:underline">Analyse <ArrowRight size={13} aria-hidden /></Link>}
        >
          {lb?.sentiment ? (
            <>
              <SentimentDonut s={lb.sentiment} size={156} />
              {sentiment.data?.provenance === "template" && (
                <p className="mt-3 text-[11.5px] text-ink-3">Labels come from the synthetic phrase templates, not from a sentiment model.</p>
              )}
            </>
          ) : (
            <Empty title="Unavailable">{sentiment.data?.reason ?? "The current window carries no sentiment labels."}</Empty>
          )}
        </Card>
        <Card
          title="Recent events"
          subtitle="Detected by comparing consecutive windows"
          actions={<Link to="/history" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent hover:underline">View all <ArrowUpRight size={13} aria-hidden /></Link>}
        >
          <EventList events={(events.data?.items ?? []).slice(0, 6)} compact />
        </Card>
        <Card title="Biggest movers" subtitle="Growth vs the window 5 minutes earlier">
          <Movers />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Processing duration" subtitle={`Job time per run · dashed line = ${interval} s schedule`}>
          <DurationChart runs={runs.data?.items ?? []} interval={interval} height={220} />
        </Card>
        <Card title="Latest run" subtitle="What produced the numbers above">
          <div className="flex items-center gap-4 pb-2">
            <NextRun interval={interval} />
            <div className="min-w-0 text-[12.5px]">
              <div className="font-semibold">{lb?.source === "hadoop" ? "Hadoop Streaming on YARN" : lb?.source === "local-sim" ? "Local simulation" : lb?.source ?? "—"}</div>
              <div className="num text-ink-3">
                Window {lb?.window_start != null ? `${fmtClock(lb.window_start)}–${fmtClock(lb.window_end)}` : "—"}
              </div>
            </div>
          </div>
          <dl className="divide-y divide-line border-t border-line">
            <KeyValue k="Produced at" v={lb?.generated_at ? new Date(lb.generated_at).toLocaleTimeString() : "—"} />
            <KeyValue k="Hashtag mentions" v={<CountUp value={lb?.tag_mentions} />} />
            <KeyValue k="Jobs ok / failed" v={metrics.data ? `${metrics.data.processing.jobs_succeeded} / ${metrics.data.processing.jobs_failed}` : "—"} />
            <KeyValue k="Avg job (all runs)" v={fmtSecs(metrics.data?.processing.avg_job_s)} />
          </dl>
        </Card>
      </div>
    </div>
  );
}
