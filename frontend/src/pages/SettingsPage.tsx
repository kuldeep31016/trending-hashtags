import { useLive, type Range, type Theme, type Transport } from "../lib/live";
import { REPLAY } from "../lib/replay";
import { useMeta } from "../lib/meta";
import { fmtInt, fmtNum } from "../lib/format";
import { Code2, Database, Palette, SlidersHorizontal } from "lucide-react";
import { Card, IconTile, KeyValue, Segmented, Select } from "../components/ui";

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-[12.5px] text-ink-3">{hint}</div>
      </div>
      {children}
    </div>
  );
}

const ENDPOINTS = [
  "/api/leaderboard", "/api/trends?mode=velocity", "/api/history", "/api/hashtags/worldcupfinal",
  "/api/sentiment", "/api/events", "/api/runs", "/api/health", "/api/metrics", "/api/meta",
];

export default function SettingsPage() {
  const { settings, update, connection } = useLive();
  const meta = useMeta();
  const ds = meta?.dataset;
  return (
    <div className="grid max-w-[1200px] grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title={<span className="flex items-center gap-2.5"><IconTile tint="blue" size={36}><Palette size={18} /></IconTile>Display</span>} subtitle="Stored in this browser only">
        <div className="divide-y divide-line">
          <Row label="Theme" hint="Dark suits the operations view; light suits projectors in bright rooms">
            <Segmented<Theme> label="Theme" value={settings.theme} onChange={(v) => update({ theme: v })}
              options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
          </Row>
          {!REPLAY && (
            <>
          <Row label="Live updates" hint={`Server-Sent Events push new windows instantly; polling is the fallback. Now: ${connection}`}>
            <Segmented<Transport> label="Update transport" value={settings.transport} onChange={(v) => update({ transport: v })}
              options={[{ value: "sse", label: "SSE" }, { value: "poll", label: "Polling" }]} />
          </Row>
          <Row label="Polling interval" hint="Used in polling mode and after SSE falls back">
            <Select<string> label="Polling interval" value={String(settings.pollSeconds)} onChange={(v) => update({ pollSeconds: Number(v) })}
              options={["3", "5", "10", "30"].map((v) => ({ value: v, label: `${v} s` }))} />
          </Row>
            </>
          )}
          <Row label="Default chart history" hint="Same as the selector in the top bar">
            <Select<Range> label="Default chart history" value={settings.range} onChange={(v) => update({ range: v })}
              options={[{ value: "15", label: "15 min" }, { value: "30", label: "30 min" }, { value: "60", label: "60 min" }, { value: "all", label: "All stored" }]} />
          </Row>
        </div>
      </Card>

      <Card title={<span className="flex items-center gap-2.5"><IconTile tint="violet" size={36}><SlidersHorizontal size={18} /></IconTile>Pipeline configuration</span>} subtitle="Read from the running system">
        <dl className="divide-y divide-line">
          <KeyValue k="Window length" v={`${meta?.pipeline.window_minutes ?? "—"} min`} />
          <KeyValue k="Driver interval" v={`${meta?.pipeline.interval_seconds ?? "—"} s`} />
          <KeyValue k="Result source" v={meta?.pipeline.source ?? "—"} />
          <KeyValue k="Velocity k / min mentions" v={meta?.pipeline.scoring ? `${fmtNum(meta.pipeline.scoring.k, 0)} / ${meta.pipeline.scoring.min_count}` : "—"} />
          <KeyValue k="History retention" v={`${meta?.pipeline.retention_days ?? "—"} days`} />
        </dl>
      </Card>

      <Card title={<span className="flex items-center gap-2.5"><IconTile tint="green" size={36}><Database size={18} /></IconTile>Dataset</span>} subtitle="data/tweets.meta.json, written by scripts/prepare_data.py">
        {ds ? (
          <dl className="divide-y divide-line">
            <KeyValue k="Tweets" v={fmtInt(ds.tweets)} />
            <KeyValue k="Sources" v={ds.sources.join(", ")} mono={false} />
            <KeyValue k="Seed" v={ds.seed} />
            <KeyValue k="Injected bursts" v={ds.injected_bursts.length ? ds.injected_bursts.map((b) => `#${b.tag}`).join(", ") : "none"} mono={false} />
            <KeyValue k="Sentiment labels" v={`${fmtInt(ds.sentiment_labels.labeled)} (${ds.sentiment_labels.provenance})`} />
          </dl>
        ) : (
          <p className="text-[13px] text-ink-3">No metadata file found. Regenerate the data with scripts/prepare_data.py.</p>
        )}
        {ds?.synthetic && (
          <p className="mt-3 text-[12px] text-ink-3">
            The tweets are synthetic and the bursts are injected on purpose so the demo has trends to detect. Detection runs on the data; the trends themselves are simulated.
          </p>
        )}
      </Card>

      {!REPLAY && (
      <Card title={<span className="flex items-center gap-2.5"><IconTile tint="sky" size={36}><Code2 size={18} /></IconTile>API</span>} subtitle="JSON endpoints served by Flask (schemas in docs/API.md)">
        <ul className="space-y-1 text-[12.5px]">
          {ENDPOINTS.map((e) => (
            <li key={e}><a className="num text-accent hover:underline" href={e} target="_blank" rel="noreferrer">GET {e}</a></li>
          ))}
          <li className="pt-1 text-ink-3">GET /api/stream: Server-Sent Events (leaderboard + health)</li>
          <li><a className="text-accent hover:underline" href="/classic">Original single-page dashboard</a></li>
        </ul>
      </Card>
      )}
    </div>
  );
}
