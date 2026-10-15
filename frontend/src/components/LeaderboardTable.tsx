import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, ChevronDown, ChevronUp, Search } from "lucide-react";
import { useLive } from "../lib/live";
import { useInjected } from "../lib/meta";
import { fmtNum } from "../lib/format";
import { CountUp } from "../lib/anim";
import type { LeaderEntry, TrendingEntry } from "../lib/types";
import { Empty, Movement, Segmented, SimulatedBadge, Skeleton, Sparkline } from "./ui";

export type RankMode = "volume" | "velocity";
type SortKey = "rank" | "count" | "score" | "tag";

interface Row {
  rank: number;
  tag: string;
  count: number;
  delta: number | null | undefined;
  series: number[];
  trend_score: number | null | undefined;
  growth: number | null | undefined;
  baseline_count: number | null | undefined;
  burst_score: number | null | undefined;
  volume_rank?: number;
}

export function LeaderboardTable({
  mode,
  onModeChange,
  showDetails = false,
  limit = 10,
}: {
  mode: RankMode;
  onModeChange: (m: RankMode) => void;
  showDetails?: boolean;
  limit?: number;
}) {
  const { leaderboard } = useLive();
  const injected = useInjected();
  const reduce = useReducedMotion();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: 1 });

  const rows: Row[] = useMemo(() => {
    if (!leaderboard) return [];
    const src: (LeaderEntry | TrendingEntry)[] = mode === "volume" ? leaderboard.top : leaderboard.trending ?? [];
    let r = src.slice(0, limit).map((e) => ({ ...e, delta: "delta" in e ? e.delta : undefined }) as Row);
    const needle = q.trim().replace(/^#/, "").toLowerCase();
    if (needle) r = r.filter((e) => e.tag.includes(needle));
    const { key, dir } = sort;
    if (key !== "rank") {
      r = [...r].sort((a, b) => {
        const av = key === "count" ? a.count : key === "score" ? a.trend_score ?? -Infinity : a.tag;
        const bv = key === "count" ? b.count : key === "score" ? b.trend_score ?? -Infinity : b.tag;
        return (av < bv ? -1 : av > bv ? 1 : a.rank - b.rank) * (key === "tag" ? dir : -dir);
      });
    } else if (dir === -1) r = [...r].reverse();
    return r;
  }, [leaderboard, mode, limit, q, sort]);

  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const hasVelocity = (leaderboard?.trending?.length ?? 0) > 0;

  const header = (key: SortKey, label: string, align = "text-left", title?: string) => {
    const on = sort.key === key;
    return (
      <th scope="col" className={`eyebrow px-3 py-2 font-semibold ${align}`} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button
          title={title}
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}
          className={`inline-flex items-center gap-0.5 uppercase tracking-[0.06em] hover:text-ink ${on ? "text-ink-2" : ""}`}
        >
          {label}
          {on && (sort.dir === 1 ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />)}
        </button>
      </th>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <Segmented<RankMode>
          label="Ranking mode"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "volume", label: "By volume", title: "Highest mention count in the window" },
            { value: "velocity", label: "By growth", title: "Fastest growth vs the previous comparable window" },
          ]}
        />
        <label className="relative">
          <span className="sr-only">Filter hashtags</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter"
            spellCheck={false}
            className="h-8 w-40 rounded-[var(--radius-ctl)] border border-line bg-surface-2 pl-8 pr-2 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-line-strong"
          />
        </label>
      </div>

      {!leaderboard ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : leaderboard.top.length === 0 ? (
        <Empty title="No hashtags yet">
          The first window appears when the first MapReduce job finishes. Start the pipeline with{" "}
          <code className="num text-ink-2">scripts/demo.sh up</code>.
        </Empty>
      ) : mode === "velocity" && !hasVelocity ? (
        <Empty title="Growth ranking needs history">
          Velocity compares each hashtag with the window that ended {Math.round((leaderboard.scoring?.lookback_seconds ?? 300) / 60)} minutes
          earlier. It appears once one full window of history exists (and only for hashtags with at least{" "}
          {leaderboard.scoring?.min_count ?? 10} mentions).
        </Empty>
      ) : rows.length === 0 ? (
        <Empty title={`No hashtag matches “${q}”`} />
      ) : (
        <div className="@container overflow-x-auto">
          <table className="w-full min-w-[320px] border-collapse text-[13px]">
            <thead className="bg-surface-2">
              <tr className="border-b border-line">
                {header("rank", "#", "text-left w-12")}
                {header("tag", "Hashtag")}
                {header("count", "Mentions", "text-right")}
                {header("score", mode === "velocity" ? "Trend score" : "Score", "text-right hidden @lg:table-cell", "Trend score = growth × log2(1 + mentions)")}
                {mode === "volume" ? (
                  <th scope="col" className="eyebrow px-3 py-2 text-center">Change</th>
                ) : (
                  <th scope="col" className="eyebrow px-3 py-2 text-right" title="Mentions in the baseline window, scaled to current stream volume">
                    Baseline
                  </th>
                )}
                <th scope="col" className="eyebrow hidden px-3 py-2 text-left @xl:table-cell">Last 12 windows</th>
                {showDetails && <th scope="col" className="eyebrow px-3 py-2 text-right">Growth</th>}
                {showDetails && <th scope="col" className="eyebrow px-3 py-2 text-right" title="Heuristic z-score vs earlier windows">Burst</th>}
                <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Inspect</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                return (
                  <motion.tr
                    key={r.tag}
                    layout={reduce ? false : "position"}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, ease: [0.2, 0, 0, 1], delay: reduce ? 0 : i * 0.035 }}
                    className="group h-[48px] border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-accent-soft"
                  >
                    <td className={`num px-3 text-[13.5px] ${r.rank <= 3 ? "font-semibold text-ink" : "text-ink-3"}`}>{r.rank}</td>
                    <td className="px-3">
                      <div className="flex items-center gap-2">
                        <Link to={`/explorer/${encodeURIComponent(r.tag)}`} className="font-medium text-ink hover:text-accent hover:underline">
                          #{r.tag}
                        </Link>
                        {injected.has(r.tag) && <SimulatedBadge />}
                        {mode === "velocity" && r.volume_rank !== undefined && (
                          <span className="text-[11px] text-ink-3">vol #{r.volume_rank}</span>
                        )}
                      </div>
                      <div className="mt-1.5 h-[5px] w-full max-w-[260px] overflow-hidden rounded-full bg-raised" aria-hidden>
                        <motion.div
                          className="h-full rounded-full"
                          style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }}
                          initial={reduce ? false : { width: 0 }}
                          animate={{ width: `${(r.count / maxCount) * 100}%` }}
                          transition={{ duration: 0.9, ease: [0.2, 0, 0, 1], delay: reduce ? 0 : 0.15 + i * 0.04 }}
                        />
                      </div>
                    </td>
                    <td className="num px-3 text-right font-semibold">
                      <CountUp value={r.count} />
                    </td>
                    <td className="num hidden px-3 text-right text-ink-2 @lg:table-cell">
                      {r.trend_score == null ? <span className="text-ink-3" title="Needs a baseline window and the minimum volume">—</span> : fmtNum(r.trend_score, 1)}
                    </td>
                    {mode === "volume" ? (
                      <td className="px-3 text-center"><Movement delta={r.delta} /></td>
                    ) : (
                      <td className="num px-3 text-right text-ink-2">{fmtNum(r.baseline_count ?? null, 0)}</td>
                    )}
                    <td className="hidden px-3 @xl:table-cell">
                      <Sparkline series={r.series} label={`#${r.tag} mentions over the last ${r.series.length} windows`} />
                    </td>
                    {showDetails && (
                      <td className="num px-3 text-right text-ink-2">
                        {r.growth == null ? "—" : `${r.growth > 0 ? "+" : ""}${fmtNum(r.growth, 2)}`}
                      </td>
                    )}
                    {showDetails && <td className="num px-3 text-right text-ink-2">{fmtNum(r.burst_score ?? null, 1)}</td>}
                    <td className="px-2 text-right">
                      <Link
                        to={`/explorer/${encodeURIComponent(r.tag)}`}
                        aria-label={`Inspect #${r.tag}`}
                        className="inline-flex size-7 items-center justify-center rounded-[var(--radius-ctl)] text-ink-3 opacity-60 hover:bg-raised hover:text-ink group-hover:opacity-100"
                      >
                        <ArrowUpRight size={15} aria-hidden />
                      </Link>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
