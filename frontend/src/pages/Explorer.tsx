import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Layers, MessageSquare, Search, TrendingUp, Trophy } from "lucide-react";
import { useLive } from "../lib/live";
import { useResource } from "../lib/api";
import { useInjected } from "../lib/meta";
import { fmtClock, fmtDateTime, fmtInt, fmtNum } from "../lib/format";
import type { HashtagDetail } from "../lib/types";
import { Card, Empty, ErrorNote, KeyValue, Movement, SimulatedBadge, Skeleton, StatTile } from "../components/ui";
import { SentimentDonut, SimpleLine } from "../components/charts";
import { EventList } from "../components/pipeline";

function SearchBox({ initial }: { initial: string }) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const nav = useNavigate();
  const listId = useId();
  const needle = q.trim().replace(/^#/, "").toLowerCase();
  const res = useResource<{ items: { tag: string; peak_count: number; last_seen: number }[] }>(
    `/api/hashtags?q=${encodeURIComponent(needle)}&limit=8`,
  );
  const items = res.data?.items ?? [];
  useEffect(() => setActive(-1), [needle]);
  const go = (t: string) => {
    setOpen(false);
    setQ(t);
    nav(`/explorer/${encodeURIComponent(t)}`);
  };
  return (
    <div className="relative w-full max-w-md">
      <label htmlFor={`${listId}-in`} className="sr-only">Search hashtags</label>
      <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
      <input
        id={`${listId}-in`}
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        value={q}
        spellCheck={false}
        autoComplete="off"
        placeholder="Search a hashtag, e.g. worldcupfinal"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, -1));
          else if (e.key === "Enter") {
            const t = active >= 0 ? items[active]?.tag : needle;
            if (t) go(t);
          } else if (e.key === "Escape") setOpen(false);
        }}
        className="h-10 w-full rounded-[var(--radius-ctl)] border border-line bg-surface pl-9 pr-3 text-[14px] text-ink placeholder:text-ink-3 focus:border-line-strong"
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-10 mt-1 w-full overflow-hidden rounded-[8px] border border-line-strong bg-surface py-1" style={{ boxShadow: "var(--shadow)" }}>
          {items.map((it, i) => (
            <li
              key={it.tag}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                go(it.tag);
              }}
              className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-[13px] ${i === active ? "bg-raised" : "hover:bg-surface-2"}`}
            >
              <span className="font-medium">#{it.tag}</span>
              <span className="num text-[11.5px] text-ink-3">peak {fmtInt(it.peak_count)} · {fmtClock(it.last_seen)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RankChart({ series }: { series: HashtagDetail["series"] }) {
  const data = series.filter((p) => p.rank != null);
  if (data.length < 2) return <Empty title="Not enough ranked windows yet" />;
  return (
    <div style={{ height: 180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="end_ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => fmtClock(v)} tick={{ fontSize: 11 }} minTickGap={36} />
          <YAxis reversed allowDecimals={false} domain={[1, "dataMax"]} tick={{ fontSize: 11 }} width={40} tickFormatter={(v) => `#${v}`} />
          <Tooltip
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="rounded-[8px] border border-line-strong bg-surface px-3 py-2 text-[12px]" style={{ boxShadow: "var(--shadow)" }}>
                  <div className="num text-ink-3">{fmtClock(Number(label), true)}</div>
                  <div className="num font-medium">Rank #{String(payload[0].value)}</div>
                </div>
              ) : null
            }
          />
          <Line type="stepAfter" dataKey="rank" stroke="var(--s7)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function Explorer() {
  const { tag: raw } = useParams();
  const tag = raw ? decodeURIComponent(raw).replace(/^#/, "").toLowerCase() : "";
  const { windowKey, leaderboard } = useLive();
  const injected = useInjected();
  const res = useResource<HashtagDetail>(tag ? `/api/hashtags/${encodeURIComponent(tag)}` : null, windowKey);
  const d = res.data && res.data.tag === tag ? res.data : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchBox key={tag} initial={tag ? `#${tag}` : ""} />
        <p className="max-w-lg text-[12px] text-ink-3">
          The pipeline stores aggregated hashtag counts per window, not individual tweets, so this view shows counts, ranks and sentiment totals rather than tweet text.
        </p>
      </div>

      {!tag ? (
        <Card title="Pick a hashtag">
          <p className="mb-3 text-[13px] text-ink-3">Currently in the top 10:</p>
          <div className="flex flex-wrap gap-2">
            {(leaderboard?.top ?? []).map((e) => (
              <Link key={e.tag} to={`/explorer/${encodeURIComponent(e.tag)}`} className="rounded-[var(--radius-ctl)] border border-line px-2.5 py-1 text-[13px] hover:border-line-strong hover:text-accent">
                #{e.tag} <span className="num text-ink-3">{fmtInt(e.count)}</span>
              </Link>
            ))}
            {!leaderboard?.top.length && <span className="text-[13px] text-ink-3">No windows yet.</span>}
          </div>
        </Card>
      ) : res.error?.status === 404 ? (
        <Card><Empty title={`#${tag} has not appeared in any stored window`}>Hashtags are stored for the top 200 of every window. Try another spelling.</Empty></Card>
      ) : res.error && !d ? (
        <ErrorNote message={res.error.message} onRetry={res.reload} />
      ) : !d ? (
        <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[26px] font-bold">#{d.tag}</h2>
            {injected.has(d.tag) && <SimulatedBadge />}
            {d.current.in_top ? (
              <span className="text-[12.5px] text-ink-3">rank <span className="num text-ink">#{d.current.rank}</span> by volume <Movement delta={d.current.delta} /></span>
            ) : (
              <span className="text-[12.5px] text-ink-3">{d.current.rank ? <>rank <span className="num">#{d.current.rank}</span>, outside the top 10</> : "not in the current window"}</span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            <StatTile tint="blue" icon={<MessageSquare size={20} />} label="Mentions (5 min)" value={d.current.count} sub="current window" />
            <StatTile tint="violet" icon={<Trophy size={20} />} label="Volume rank" value={d.current.rank} format={(v) => `#${Math.round(v)}`}
              sub={d.current.in_top ? "in the top 10" : "outside the top 10"} delay={0.06} />
            <StatTile tint="green" icon={<TrendingUp size={20} />} label="Peak mentions" value={d.overview.peak_count} sub={`best rank #${d.overview.best_rank}`} delay={0.12} />
            <StatTile tint="sky" icon={<Layers size={20} />} label="Windows present" value={d.overview.windows} sub="stored windows with this tag" delay={0.18} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card title="Current window">
              <dl className="divide-y divide-line">
                <KeyValue k="Mentions (5 min)" v={d.current.count} />
                <KeyValue k="Volume rank" v={d.current.rank ? `#${d.current.rank}` : "—"} />
                <KeyValue k="Growth" v={d.current.growth == null ? "Needs baseline" : `${d.current.growth > 0 ? "+" : ""}${fmtNum(d.current.growth, 2)}`} />
                <KeyValue k="Trend score" v={d.current.trend_score == null ? "—" : fmtNum(d.current.trend_score, 1)} />
                <KeyValue k="Baseline mentions" v={d.current.baseline_count == null ? "—" : fmtNum(d.current.baseline_count, 0)} />
                <KeyValue k="Burst score" v={d.current.burst_score == null ? "—" : fmtNum(d.current.burst_score, 1)} />
                <KeyValue k="Growth rank" v={d.current.velocity_rank ? `#${d.current.velocity_rank}` : "—"} />
              </dl>
              {!d.current.in_top && d.current.growth == null && (
                <p className="mt-2 text-[11.5px] text-ink-3">Scores are computed for every hashtag but published for the top 10 by volume and by growth.</p>
              )}
            </Card>
            <Card title="Lifetime in stored history">
              <dl className="divide-y divide-line">
                <KeyValue k="First seen" v={fmtDateTime(d.overview.first_seen)} />
                <KeyValue k="Last seen" v={fmtDateTime(d.overview.last_seen)} />
                <KeyValue k="Windows present" v={d.overview.windows} />
                <KeyValue k="Peak mentions" v={d.overview.peak_count} />
                <KeyValue k="Best rank" v={`#${d.overview.best_rank}`} />
              </dl>
            </Card>
            <Card title="Sentiment" subtitle="Current window">
              {d.current.sentiment ? (
                <SentimentDonut s={d.current.sentiment} size={120} />
              ) : (
                <Empty title="Unavailable">No labeled tweets carried this hashtag in the current window, or it is outside the published top 10.</Empty>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Mentions per window" subtitle={`${d.series.length} stored windows`}>
              <SimpleLine data={d.series.map((p) => ({ end_ts: p.end_ts, count: p.count }))} x="end_ts" y="count" label={`#${d.tag}`} />
            </Card>
            <Card title="Rank over time" subtitle="Rank among all hashtags in each window (1 = top)">
              <RankChart series={d.series} />
            </Card>
          </div>
          <Card title="Events for this hashtag" bodyClass="px-4 py-1">
            <EventList events={d.events} />
          </Card>
        </>
      )}
    </div>
  );
}
