import type { ReactNode } from "react";
import { Code2, Cpu, Database, ExternalLink, Loader, Radio } from "lucide-react";
import { useLive } from "../lib/live";
import { REPLAY } from "../lib/replay";
import { useResource } from "../lib/api";
import { useMeta } from "../lib/meta";
import { agoFromTs, fmtAgo, fmtClock, fmtInt, fmtNum, fmtSecs } from "../lib/format";
import type { Metrics, Run, Stage } from "../lib/types";
import { Card, Empty, IconTile, KeyValue, StatTile, StateLabel, stateColor, type Tint } from "../components/ui";
import { DurationChart, SimpleLine } from "../components/charts";
import { useTick } from "../components/pipeline";

function StagePanel({ title, stage, children, link, icon, tint }: { title: string; stage?: Stage; children: ReactNode; link?: ReactNode; icon: ReactNode; tint: Tint }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2.5">
          <IconTile tint={tint} size={36}>{icon}</IconTile>
          {title}
          {stage && !stage.in_use && <span className="text-[11px] font-normal text-ink-3">not used in simulation</span>}
        </span>
      }
      actions={stage ? <StateLabel state={stage.in_use ? stage.state : "unknown"} size={14} /> : null}
      className="flex flex-col"
    >
      {stage && (
        <p className="mb-2 border-l-2 pl-2.5 text-[12.5px] text-ink-2" style={{ borderColor: stateColor(stage.in_use ? stage.state : "unknown") }}>
          {stage.in_use ? stage.summary : stage.note}
        </p>
      )}
      <dl className="divide-y divide-line">{children}</dl>
      {link && <div className="mt-2">{link}</div>}
    </Card>
  );
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => REPLAY ? null : (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
    {children} <ExternalLink size={12} aria-hidden />
  </a>
);

function ReplayProgress() {
  const { health } = useLive();
  const meta = useMeta();
  const p = health?.stages.kafka.producer;
  const bursts = meta?.dataset?.injected_bursts ?? [];
  if (!p || !p.file_tweets) return null;
  const frac = Math.min(1, (p.position ?? 0) / p.file_tweets);
  return (
    <Card title="Demo replay progress" subtitle={`Pass ${Number(p.loop ?? 0) + 1} through the dataset · ${fmtInt(p.position)} of ${fmtInt(p.file_tweets)} tweets sent`}>
      <div className="relative h-7 rounded-[6px] bg-raised">
        {bursts.map((b, i) => (
          <div
            key={b.tag}
            className="grow-x absolute inset-y-1 rounded-[4px] opacity-85"
            title={`#${b.tag}: injected burst (${Math.round(b.start_fraction * 100)}–${Math.round(b.end_fraction * 100)}% of the stream)`}
            style={{ left: `${b.start_fraction * 100}%`, width: `${(b.end_fraction - b.start_fraction) * 100}%`, background: `var(--s${i + 2})` }}
          />
        ))}
        <div className="absolute -inset-y-1 w-[3px] rounded-full bg-ink transition-[left] duration-1000 ease-out" style={{ left: `${frac * 100}%` }} aria-hidden>
          <span className="ping absolute -left-[3px] -top-1 size-[9px] rounded-full bg-ink" style={{ color: "var(--ink)" }} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {bursts.map((b, i) => (
          <span key={b.tag} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: `var(--s${i + 2})` }} />#{b.tag}
          </span>
        ))}
        <span className="text-ink-3">· vertical line = producer position ({Math.round(frac * 100)}%) · bursts are injected for the demo</span>
      </div>
    </Card>
  );
}

export default function Pipeline() {
  const { health, windowKey, leaderboard } = useLive();
  const meta = useMeta();
  const tick = useTick(15);
  const metrics = useResource<Metrics>("/api/metrics", `${windowKey}|${tick}`);
  const runs = useResource<{ items: Run[] }>("/api/runs?limit=60", windowKey);
  const m = metrics.data;
  const st = health?.stages;
  const k = st?.kafka.check;
  const h = st?.hdfs.check;
  const y = st?.mapreduce.yarn;
  const drv = st?.mapreduce.driver;
  const failed = (runs.data?.items ?? []).filter((r) => r.status === "failed").slice(-5).reverse();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
        <span className="text-[13px] text-ink-3">Overall</span>
        {health ? <StateLabel state={health.status} size={16} className="text-[15px]" /> : <span className="text-ink-3">checking…</span>}
        <span className="text-[12.5px] text-ink-3">
          Cluster checks every 10 s{health?.cluster_checked_at ? `, last ${fmtAgo(agoFromTs(health.cluster_checked_at))}` : ""}. An HTTP 200 from this API does not mean the pipeline is healthy; each stage is checked on its own.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
        <StatTile tint="violet" icon={<Radio size={20} />} label="Tweets sent to Kafka" value={m?.ingest.producer_sent_total ?? null} sub="producer total" />
        <StatTile tint="green" icon={<Database size={20} />} label="Written to HDFS" value={m?.ingest.sink_written_total ?? null}
          sub={m?.ingest.tweets_written_last_min != null ? `${m.ingest.tweets_written_last_min.toLocaleString()} in the last minute` : undefined} delay={0.06} />
        <StatTile tint="blue" icon={<Cpu size={20} />} label="MapReduce jobs" value={m ? m.processing.jobs_succeeded : null}
          sub={m ? `${m.processing.jobs_failed} failed · avg ${fmtSecs(m.processing.avg_job_s)}` : undefined} delay={0.12} />
        <StatTile tint="sky" icon={<Code2 size={20} />} label="API response (p95)" value={st?.api.latency?.p95_ms ?? null} format={(v) => `${v.toFixed(1)} ms`}
          sub={st?.api.latency ? `${st.api.latency.requests} requests in 5 min` : undefined} delay={0.18} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
        <StagePanel title="Kafka" stage={st?.kafka} tint="violet" icon={<Radio size={18} />}>
          <KeyValue k="Bootstrap" v={k?.bootstrap ?? "—"} />
          <KeyValue k="Topic / partitions" v={k?.topic_exists === false ? "missing" : `${k?.topic ?? "—"} / ${k?.partitions ?? "—"}`} />
          <KeyValue k="Messages in topic" v={fmtInt(k?.end_offset_total)} />
          <KeyValue k="Sink consumer lag" v={k?.consumer_lag != null ? `${fmtInt(k.consumer_lag)} msgs` : "—"} />
          <KeyValue k="Producer" v={st?.kafka.producer ? `${st.kafka.producer.status}, ${fmtNum(st.kafka.producer.rate_per_s, 1)}/s` : "not seen"} />
          <KeyValue k="Producer sent (total)" v={fmtInt(m?.ingest.producer_sent_total)} />
          {k?.error && <KeyValue k="Last error" v={<span className="text-critical">{k.error}</span>} mono={false} />}
        </StagePanel>
        <StagePanel title="HDFS" stage={st?.hdfs} tint="green" icon={<Database size={18} />} link={meta && <Ext href={meta.endpoints.hdfs_ui}>NameNode UI</Ext>}>
          <KeyValue k="Filesystem" v={h?.fs_state ?? "—"} />
          <KeyValue k="DataNodes live / dead" v={h ? `${h.live_datanodes ?? "—"} / ${h.dead_datanodes ?? "—"}` : "—"} />
          <KeyValue k="Latest minute folder" v={h?.latest_minute_folder ?? "—"} />
          <KeyValue k="Last write" v={h?.last_write ? fmtAgo(agoFromTs(h.last_write)) : "—"} />
          <KeyValue k="Sink written (total)" v={fmtInt(m?.ingest.sink_written_total)} />
          <KeyValue k="Sink write errors" v={fmtInt(m?.ingest.sink_write_errors_total)} />
          {(st?.hdfs.sink?.last_error as any)?.message && <KeyValue k="Sink error" v={<span className="text-critical">{(st?.hdfs.sink?.last_error as any).message}</span>} mono={false} />}
        </StagePanel>
        <StagePanel title="MapReduce (YARN + driver)" stage={st?.mapreduce} tint="blue" icon={<Cpu size={18} />} link={meta && <Ext href={meta.endpoints.yarn_ui}>YARN UI</Ext>}>
          <KeyValue k="Driver" v={drv?.status ? `${drv.status}${drv.pid ? ` (pid ${drv.pid})` : ""}` : "not seen"} />
          <KeyValue k="Next run" v={drv?.next_run_at ? fmtClock(drv.next_run_at, true) : "—"} />
          <KeyValue k="Consecutive failures" v={drv?.consecutive_failures ?? "—"} />
          <KeyValue k="ResourceManager" v={y?.rm_state ?? "—"} />
          <KeyValue k="Active NodeManagers" v={y?.active_nodes ?? "—"} />
          <KeyValue k="Apps running / failed" v={y ? `${y.apps_running} / ${y.apps_failed}` : "—"} />
          <KeyValue k="Memory used" v={y ? `${fmtInt(y.allocated_mb)} / ${fmtInt((y.allocated_mb ?? 0) + (y.available_mb ?? 0))} MB` : "—"} />
        </StagePanel>
        <StagePanel title="Leaderboard API" stage={st?.api} tint="sky" icon={<Code2 size={18} />}>
          <KeyValue k="Requests (5 min)" v={fmtInt(st?.api.latency?.requests)} />
          <KeyValue k="Response avg / p95" v={st?.api.latency ? `${fmtNum(st.api.latency.avg_ms, 1)} / ${fmtNum(st.api.latency.p95_ms, 1)} ms` : "—"} />
          <KeyValue k="Snapshot age" v={fmtSecs(health?.freshness.age_seconds)} />
          <KeyValue k="Stale after" v={health?.freshness.stale_after ? `${health.freshness.stale_after} s` : "—"} />
          <KeyValue k="Data mode" v={health?.data_mode ?? "—"} />
          <KeyValue k="Window source" v={leaderboard?.source ?? "—"} />
        </StagePanel>
      </div>

      <ReplayProgress />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Tweets written to HDFS per minute" subtitle={m?.ingest.note ?? "Measured by the sink on every flush"}>
          <SimpleLine bars data={(m?.ingest.per_minute ?? []).map((p) => ({ ts: p.ts, written: p.written }))} x="ts" y="written" label="Tweets written" />
        </Card>
        <Card title="Ingest lag" subtitle="Flush time minus event time, averaged per minute (includes the 10 s sink buffer)">
          <SimpleLine data={(m?.ingest.per_minute ?? []).filter((p) => p.lag_avg != null).map((p) => ({ ts: p.ts, lag: p.lag_avg }))} x="ts" y="lag" label="Average lag" color="var(--s7)" format={(v) => `${fmtNum(v, 1)}s`} />
        </Card>
        <Card title="MapReduce job duration" subtitle={`Avg ${fmtSecs(m?.processing.avg_job_s)} · max ${fmtSecs(m?.processing.max_job_s)} · avg schedule delay ${fmtSecs(m?.processing.avg_schedule_delay_s)}`}>
          <DurationChart runs={runs.data?.items ?? []} interval={meta?.pipeline.interval_seconds ?? 60} />
        </Card>
        <Card title="Recent YARN applications" subtitle="This project's jobs, from the ResourceManager REST API" bodyClass="">
          {y?.recent_apps?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-[12.5px]">
                <thead className="bg-surface-2">
                  <tr>
                    <th className="eyebrow px-3 py-2 text-left">Application</th>
                    <th className="eyebrow px-3 py-2 text-left">Started</th>
                    <th className="eyebrow px-3 py-2 text-left">State</th>
                    <th className="eyebrow px-3 py-2 text-right">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {y.recent_apps.map((a: any) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="num px-3 py-1.5 text-ink-2">{a.id.replace("application_", "")}</td>
                      <td className="num px-3 py-1.5">{fmtClock(a.started, true)}</td>
                      <td className="px-3 py-1.5 text-[12px]">
                        {a.state === "RUNNING" || a.state === "ACCEPTED" || a.state === "SUBMITTED" ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-accent">
                            <Loader size={12} aria-hidden className="motion-safe:animate-spin" />
                            {a.state === "RUNNING" ? `Running ${Math.round(a.progress)}%` : "Queued"}
                          </span>
                        ) : (
                          <StateLabel size={12} state={a.final_status === "SUCCEEDED" ? "healthy" : "down"} className="text-[12px]" />
                        )}
                        {a.state !== "RUNNING" && <span className="ml-1 text-ink-3">{String(a.final_status).toLowerCase()}</span>}
                      </td>
                      <td className="num px-3 py-1.5 text-right">{fmtSecs(a.elapsed_s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={y ? "No jobs from this project yet" : "YARN not reachable"} />
          )}
        </Card>
      </div>

      <Card title="Recent failures" subtitle="Failed windows keep the last good snapshot on screen" bodyClass="px-4 py-2">
        {failed.length === 0 ? (
          <p className="py-2 text-[13px] text-ink-3">No failed windows recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {failed.map((r) => (
              <li key={r.started_at} className="py-2 text-[12.5px]">
                <span className="num text-ink-3">{fmtClock(r.started_at, true)}</span> · {r.attempts} attempt(s) ·{" "}
                <span className="num text-critical">{r.error}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
