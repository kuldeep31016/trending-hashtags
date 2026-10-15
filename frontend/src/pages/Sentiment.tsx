import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLive, rangeFrom } from "../lib/live";
import { useResource } from "../lib/api";
import { fmtClock, fmtNum } from "../lib/format";
import type { SentimentResponse } from "../lib/types";
import { Frown, Meh, Smile, Tags } from "lucide-react";
import { Card, Empty, ErrorNote, KeyValue, Skeleton, StatTile } from "../components/ui";
import { SENTIMENT, SentimentBars, SentimentDonut } from "../components/charts";

export default function SentimentPage() {
  const { windowKey, settings, leaderboard } = useLive();
  const from = rangeFrom(settings.range, leaderboard?.window_end);
  const res = useResource<SentimentResponse>(`/api/sentiment${from ? `?from=${from}` : ""}`, windowKey);
  const d = res.data;

  if (res.error && !d) return <ErrorNote message={res.error.message} onRetry={res.reload} />;
  if (!d) return <Skeleton className="h-64" />;

  const share = d.series.map((p) => {
    const t = p.positive + p.neutral + p.negative || 1;
    return { end_ts: p.end_ts, positive: (p.positive / t) * 100, neutral: (p.neutral / t) * 100, negative: (p.negative / t) * 100 };
  });

  return (
    <div className="space-y-4">
      <div
        className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-ink-2"
        style={{ boxShadow: `inset 3px 0 0 ${d.provenance === "dataset" ? "var(--accent)" : "var(--warning)"}` }}
      >
        <span className="font-medium text-ink">
          {d.provenance === "template" ? "Experimental · template labels. " : d.provenance === "dataset" ? "Dataset labels. " : "Label source unknown. "}
        </span>
        {d.note ?? "No dataset metadata found (data/tweets.meta.json)."} The mapper emits a per-tweet sentiment key and a
        hashtag×sentiment key, and the reducer sums them with the hashtag counts in the same MapReduce job. Tweets without a valid label are counted as unlabeled, never guessed.
      </div>

      {!d.available ? (
        <Card><Empty title="Sentiment unavailable">{d.reason}</Empty></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            {(() => {
              const c = d.current;
              const tot = c ? c.positive + c.neutral + c.negative || 1 : 1;
              const pct = (v: number) => (v / tot) * 100;
              const f = (v: number) => `${v.toFixed(1)}%`;
              return (
                <>
                  <StatTile tint="blue" icon={<Smile size={20} />} label="Positive" value={c ? pct(c.positive) : null} format={f} sub={c ? `${c.positive.toLocaleString()} tweets` : undefined} />
                  <StatTile tint="sky" icon={<Meh size={20} />} label="Neutral" value={c ? pct(c.neutral) : null} format={f} sub={c ? `${c.neutral.toLocaleString()} tweets` : undefined} delay={0.06} />
                  <StatTile tint="amber" icon={<Frown size={20} />} label="Negative" value={c ? pct(c.negative) : null} format={f} sub={c ? `${c.negative.toLocaleString()} tweets` : undefined} delay={0.12} />
                  <StatTile tint="violet" icon={<Tags size={20} />} label="Labeled tweets" value={c?.labeled ?? null} sub={`${(c?.unlabeled ?? 0).toLocaleString()} unlabeled`} delay={0.18} />
                </>
              );
            })()}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <Card title="Current window" subtitle="Share of labeled tweets">
              {d.current && <SentimentDonut s={d.current} />}
              <dl className="mt-3 divide-y divide-line border-t border-line">
                <KeyValue k="Labeled tweets" v={d.current?.labeled ?? "—"} />
                <KeyValue k="Unlabeled tweets" v={d.current?.unlabeled ?? "—"} />
                <KeyValue k="Label mapping" v="Sentiment140 0/2/4 · Airline text · template" mono={false} />
              </dl>
            </Card>
            <Card title="Sentiment by hashtag" subtitle="Top 10 by volume · labeled tweets carrying each hashtag">
              <div className="mb-3 flex gap-4 text-[12px] text-ink-2">
                {SENTIMENT.map((k) => (
                  <span key={k.key} className="flex items-center gap-1.5">
                    <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: k.color }} />
                    {k.label}
                  </span>
                ))}
              </div>
              <SentimentBars rows={d.by_tag} />
            </Card>
          </div>
          <Card title="Sentiment share over time" subtitle="Percent of labeled tweets per processing window">
            {share.length < 2 ? (
              <Empty title="Not enough windows with labels yet" />
            ) : (
              <>
                <div className="mb-2 flex gap-4 text-[12px] text-ink-2">
                  {SENTIMENT.map((k) => (
                    <span key={k.key} className="flex items-center gap-1.5">
                      <span aria-hidden className="inline-block h-[3px] w-3.5 rounded-full" style={{ background: k.color }} />
                      {k.label}
                    </span>
                  ))}
                </div>
                <div style={{ height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={share} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="end_ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => fmtClock(v)} tick={{ fontSize: 11 }} minTickGap={36} />
                      <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} width={48} />
                      <Tooltip
                        content={({ active, payload, label }) =>
                          active && payload?.length ? (
                            <div className="rounded-[8px] border border-line-strong bg-surface px-3 py-2 text-[12px]" style={{ boxShadow: "var(--shadow)" }}>
                              <div className="num mb-1 text-ink-3">{fmtClock(Number(label), true)}</div>
                              {payload.map((p) => (
                                <div key={String(p.dataKey)} className="flex justify-between gap-4">
                                  <span className="capitalize text-ink-2">{String(p.dataKey)}</span>
                                  <span className="num font-medium">{fmtNum(Number(p.value), 1)}%</span>
                                </div>
                              ))}
                            </div>
                          ) : null
                        }
                      />
                      {SENTIMENT.map((k) => (
                        <Line key={k.key} dataKey={k.key} stroke={k.color} strokeWidth={2.25} dot={false} isAnimationActive animationDuration={1000} type="monotoneX" />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
