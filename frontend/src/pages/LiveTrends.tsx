import { useState } from "react";
import { useLive } from "../lib/live";
import { useResource } from "../lib/api";
import { fmtClock, fmtNum } from "../lib/format";
import type { TrendEvent } from "../lib/types";
import { Activity, Flame, Hash, TrendingUp } from "lucide-react";
import { Card, KeyValue, StatTile } from "../components/ui";
import { LeaderboardTable, type RankMode } from "../components/LeaderboardTable";
import { EventList } from "../components/pipeline";

export default function LiveTrends() {
  const { leaderboard: lb, windowKey } = useLive();
  const [mode, setMode] = useState<RankMode>("velocity");
  const sc = lb?.scoring;
  const surges = useResource<{ items: TrendEvent[] }>("/api/events?limit=200", windowKey);

  const surgeCount = (surges.data?.items ?? []).filter((e) => e.kind === "surge").length;
  const topGrow = lb?.trending?.[0];
  const topVol = lb?.top?.[0];
  return (
    <div className="space-y-5">
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
      <StatTile tint="green" icon={<TrendingUp size={20} />} label="Fastest grower" value={topGrow?.trend_score ?? null}
        format={(v) => v.toFixed(1)} sub={topGrow ? `#${topGrow.tag} · trend score` : "Needs 5 minutes of history"} />
      <StatTile tint="blue" icon={<Hash size={20} />} label="Top by volume" value={topVol?.count ?? null}
        sub={topVol ? `#${topVol.tag} · mentions in window` : undefined} delay={0.06} />
      <StatTile tint="amber" icon={<Flame size={20} />} label="Surges detected" value={surges.data ? surgeCount : null}
        sub="in stored history" delay={0.12} />
      <StatTile tint="violet" icon={<Activity size={20} />} label="Ranked by growth" value={lb ? lb.trending?.length ?? 0 : null}
        sub={`hashtags with ≥ ${sc?.min_count ?? 10} mentions`} delay={0.18} />
    </div>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Card
          title={mode === "volume" ? "Ranking by volume" : "Ranking by growth (velocity)"}
          subtitle={
            mode === "volume"
              ? "Highest mention count in the window; ties broken alphabetically (the academic baseline)"
              : "Fastest-growing hashtags relative to the previous comparable window"
          }
          bodyClass=""
        >
          <LeaderboardTable mode={mode} onModeChange={setMode} showDetails />
        </Card>
        <Card title="Surge events" subtitle="Moments a hashtag's trend score crossed the surge threshold" bodyClass="px-4 py-1">
          <EventList events={(surges.data?.items ?? []).filter((e) => e.kind === "surge").slice(0, 12)} />
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="How the trend score works">
          <div className="space-y-3 text-[13px] text-ink-2">
            <p>Volume answers “what is most talked about”. Growth answers “what is taking off”, so a hashtag can rank low by volume and first by growth.</p>
            <pre className="num overflow-x-auto rounded-[6px] border border-line bg-surface-2 p-3 text-[12px] leading-relaxed text-ink">
{`growth = (c − p) / (p + k)
score  = growth × log2(1 + c)`}
            </pre>
            <ul className="list-disc space-y-1 pl-4 text-[12.5px]">
              <li><b className="font-medium text-ink">c</b>: mentions in the current window.</li>
              <li>
                <b className="font-medium text-ink">p</b>: mentions in the baseline window (ended one window length earlier, no overlap), scaled to the current
                stream volume so a busier stream alone does not count as growth.
              </li>
              <li><b className="font-medium text-ink">k</b>: smoothing, so 1 → 2 mentions is not “+100%”.</li>
              <li>Only hashtags with at least <b className="font-medium text-ink">{sc?.min_count ?? 10}</b> mentions are ranked.</li>
              <li>Burst is a heuristic z-score against up to 10 earlier windows. Windows overlap, so it is a ranking aid, not a significance test.</li>
            </ul>
          </div>
        </Card>
        <Card title="Current parameters">
          <dl className="divide-y divide-line">
            <KeyValue k="Smoothing k" v={sc ? fmtNum(sc.k, 0) : "—"} />
            <KeyValue k="Minimum mentions" v={sc?.min_count ?? "—"} />
            <KeyValue k="Baseline lookback" v={sc ? `${Math.round(sc.lookback_seconds / 60)} min` : "—"} />
            <KeyValue k="Baseline window ended" v={sc?.baseline_end ? fmtClock(sc.baseline_end, true) : "Not available yet"} />
            <KeyValue k="Volume scaling" v={sc?.baseline_scale != null ? `× ${fmtNum(sc.baseline_scale, 2)}` : "—"} />
            <KeyValue k="Surge threshold" v={sc ? `score ≥ ${fmtNum(sc.surge_score, 0)}` : "—"} />
          </dl>
          <p className="mt-2 text-[11.5px] text-ink-3">Change them with driver flags: --velocity-k, --min-count, --lookback-minutes.</p>
        </Card>
      </div>
    </div>
    </div>
  );
}
