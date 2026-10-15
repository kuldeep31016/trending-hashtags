import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, Flame, Layers, MessageSquare, Plus } from "lucide-react";
import { CountUp } from "../lib/anim";
import { useLive, rangeFrom } from "../lib/live";
import { useResource } from "../lib/api";
import { useMeta } from "../lib/meta";
import { fmtClock, fmtDateTime, fmtInt, fmtSecs } from "../lib/format";
import type { History, Run, TrendEvent } from "../lib/types";
import { Card, Empty, ErrorNote, Skeleton, StatTile } from "../components/ui";
import { DurationChart, SimpleLine, TrendChart, ViewToggle } from "../components/charts";
import { TagPicker } from "../components/TagPicker";
import { EventList } from "../components/pipeline";

const toLocalInput = (ts: number) => {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s: string) => (s ? new Date(s).getTime() / 1000 : null);

interface SnapTop {
  snapshot: { end_ts: number; total_tweets: number; job_seconds: number | null; window_start: number };
  top: { tag: string; count: number; rank: number }[];
}

export default function HistoryPage() {
  const { leaderboard: lb, windowKey, settings } = useLive();
  const meta = useMeta();
  const [fromS, setFromS] = useState("");
  const [toS, setToS] = useState("");
  const [tags, setTags] = useState<string[] | null>(null);
  const [extra, setExtra] = useState("");
  const [tableView, setTableView] = useState(false);

  const defFrom = rangeFrom(settings.range, lb?.window_end);
  const from = fromLocalInput(fromS) ?? defFrom;
  const to = fromLocalInput(toS);
  const qs = `${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`;
  const picked = tags ?? (lb?.top ?? []).slice(0, 4).map((e) => e.tag);

  const hist = useResource<History>(`/api/history?limit=600&tags=${picked.join(",")}${qs}`, windowKey);
  const runs = useResource<{ items: Run[] }>(`/api/runs?limit=300${from ? `&from=${from}` : ""}`, windowKey);
  const events = useResource<{ items: TrendEvent[] }>(`/api/events?limit=300${qs}`, windowKey);

  const snaps = hist.data?.snapshots ?? [];
  const [idx, setIdx] = useState<number | null>(null);
  useEffect(() => setIdx(null), [fromS, toS]);
  const sel = snaps.length ? snaps[Math.min(idx ?? snaps.length - 1, snaps.length - 1)] : null;
  const snapTop = useResource<SnapTop>(sel ? `/api/history/snapshot?at=${sel.end_ts}&limit=10` : null);

  const tagOptions = useMemo(() => {
    const s = new Set<string>((lb?.top ?? []).map((e) => e.tag));
    (events.data?.items ?? []).forEach((e) => e.tag && s.add(e.tag));
    return [...s].slice(0, 16);
  }, [lb, events.data]);

  const r = hist.data?.retention;
  return (
    <div className="space-y-4">
      <Card bodyClass="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          From
          <input type="datetime-local" value={fromS} min={r?.oldest ? toLocalInput(r.oldest) : undefined} onChange={(e) => setFromS(e.target.value)}
            className="h-8 rounded-[var(--radius-ctl)] border border-line bg-surface-2 px-2 text-[12.5px] text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          To
          <input type="datetime-local" value={toS} max={r?.newest ? toLocalInput(r.newest) : undefined} onChange={(e) => setToS(e.target.value)}
            className="h-8 rounded-[var(--radius-ctl)] border border-line bg-surface-2 px-2 text-[12.5px] text-ink" />
        </label>
        {(fromS || toS) && (
          <button onClick={() => { setFromS(""); setToS(""); }} className="h-8 px-2 text-[12.5px] text-accent hover:underline">Reset to top-bar range</button>
        )}
        <p className="ml-auto max-w-md text-[12px] text-ink-3">
          Stored: {fmtInt(r?.snapshots)} windows, {r?.oldest ? `${fmtDateTime(r.oldest)} – ${fmtDateTime(r.newest)}` : "none yet"}. Kept for {r?.days ?? meta?.pipeline.retention_days ?? 7} days in SQLite on the host.
        </p>
      </Card>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
        <StatTile tint="blue" icon={<Layers size={20} />} label="Windows in range" value={hist.data ? snaps.length : null} sub={`${fmtInt(r?.snapshots)} stored in total`} />
        <StatTile tint="violet" icon={<MessageSquare size={20} />} label="Avg tweets / window" value={snaps.length ? snaps.reduce((a, x) => a + x.total_tweets, 0) / snaps.length : null} delay={0.06}
          sub="5-minute sliding window" />
        <StatTile tint="amber" icon={<Flame size={20} />} label="Trend events" value={events.data ? events.data.items.length : null} sub="new leaders, surges, top-5 moves" delay={0.12} />
        <StatTile tint="sky" icon={<Clock size={20} />} label="Avg job duration" value={snaps.length ? snaps.reduce((a, x) => a + (x.job_seconds ?? 0), 0) / snaps.length : null}
          format={(v) => `${v.toFixed(1)} s`} sub="per MapReduce window" delay={0.18} />
      </div>
      {hist.error && <ErrorNote message={hist.error.message} onRetry={hist.reload} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title="Hashtag comparison" subtitle="Mentions per window for the selected hashtags" actions={<ViewToggle table={tableView} onChange={setTableView} />}>
          <div className="flex flex-wrap items-center gap-2">
            <TagPicker options={tagOptions} value={picked} onChange={setTags} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const t = extra.trim().replace(/^#/, "").toLowerCase();
                if (t && !picked.includes(t) && picked.length < 6) setTags([...picked, t]);
                setExtra("");
              }}
              className="flex items-center"
            >
              <label className="sr-only" htmlFor="add-tag">Add hashtag</label>
              <input id="add-tag" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="add #tag" spellCheck={false}
                className="h-7 w-24 rounded-l-[var(--radius-ctl)] border border-line bg-surface-2 px-2 text-[12px]" />
              <button aria-label="Add hashtag" className="inline-flex h-7 items-center rounded-r-[var(--radius-ctl)] border border-l-0 border-line bg-surface-2 px-1.5 text-ink-2 hover:text-ink">
                <Plus size={13} aria-hidden />
              </button>
            </form>
          </div>
          <div className="mt-3">
            {!hist.data ? <Skeleton className="h-[300px]" /> : (
              <TrendChart series={hist.data.series} tags={picked} events={events.data?.items ?? []} table={tableView} />
            )}
          </div>
        </Card>

        <Card title="Leaderboard at a past window" subtitle={sel ? `Window ending ${fmtClock(sel.end_ts, true)} · ${fmtInt(sel.total_tweets)} tweets` : "Pick a window"}>
          {snaps.length === 0 ? (
            <Empty title="No windows in this range" />
          ) : (
            <>
              <label className="block text-[12px] text-ink-3" htmlFor="snap">
                Window {Math.min(idx ?? snaps.length - 1, snaps.length - 1) + 1} of {snaps.length}
              </label>
              <input id="snap" type="range" min={0} max={snaps.length - 1} value={Math.min(idx ?? snaps.length - 1, snaps.length - 1)}
                onChange={(e) => setIdx(Number(e.target.value))} className="mt-1 w-full accent-[var(--accent)]" />
              <ol className="mt-3 space-y-1">
                {(snapTop.data?.top ?? []).map((e, i, all) => (
                  <li key={`${sel?.end_ts}-${e.tag}`} className="fade-up rounded-[8px] px-2 py-1.5 text-[13px] hover:bg-surface-2" style={{ animationDelay: `${i * 0.04}s` }}>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-3">
                        <span className={`num w-5 ${e.rank <= 3 ? "font-bold text-ink" : "text-ink-3"}`}>{e.rank}</span>
                        <Link to={`/explorer/${encodeURIComponent(e.tag)}`} className="font-semibold hover:text-accent hover:underline">#{e.tag}</Link>
                      </span>
                      <CountUp value={e.count} className="num font-semibold" />
                    </div>
                    <div className="ml-8 mt-1 h-1 overflow-hidden rounded-full bg-raised">
                      <div className="grow-x h-full rounded-full" style={{ width: `${(e.count / Math.max(all[0]?.count ?? 1, 1)) * 100}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))", animationDelay: `${0.1 + i * 0.04}s` }} />
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Processing duration" subtitle={`${runs.data?.items.length ?? 0} runs in range`}>
          <DurationChart runs={runs.data?.items ?? []} interval={meta?.pipeline.interval_seconds ?? 60} />
        </Card>
        <Card title="Tweets per window" subtitle={`Average job ${fmtSecs(snaps.length ? snaps.reduce((a, s) => a + (s.job_seconds ?? 0), 0) / snaps.length : null)}`}>
          <SimpleLine data={snaps.map((s) => ({ end_ts: s.end_ts, total: s.total_tweets }))} x="end_ts" y="total" label="Tweets in window" color="var(--s3)" />
        </Card>
      </div>

      <Card title="Trend event timeline" subtitle={`${events.data?.items.length ?? 0} events in range, newest first`} bodyClass="px-4 py-1">
        <div className="max-h-[420px] overflow-y-auto">
          <EventList events={events.data?.items ?? []} />
        </div>
      </Card>
    </div>
  );
}
