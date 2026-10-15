/**
 * Replay mode (build with VITE_REPLAY=1) for hosting the dashboard without the cluster.
 *
 * scripts/record_replay.py records a real run of the pipeline: every MapReduce window exactly
 * as the API served it, plus the stored history. This module answers the dashboard's /api/*
 * calls from those files for the "current" recorded window, mirroring dashboard/app.py, so
 * every page works and every number shown is a recorded one.
 */
import type { Health, Leaderboard, Meta, Metrics, Run, TrendEvent } from "./types";

export const REPLAY = import.meta.env.VITE_REPLAY === "1";

interface Frame {
  leaderboard: Leaderboard;
  health: Health;
  metrics: Metrics;
  captured_at: number;
}
interface SnapRow {
  id: number;
  end_ts: number;
  window_start: number;
  window_minutes: number;
  total_tweets: number;
  distinct_tags: number;
  tag_mentions: number;
  job_seconds: number | null;
  sentiment: Record<string, number> | null;
}
interface TagRow {
  snapshot_id: number;
  tag: string;
  count: number;
  rank: number;
  positive: number | null;
  neutral: number | null;
  negative: number | null;
}
interface DB {
  snapshots: SnapRow[];
  snapshot_tags: TagRow[];
  events: (TrendEvent & { end_ts: number })[];
  runs: (Run & { end_ts: number })[];
}

let frames: Frame[] = [];
let db: DB = { snapshots: [], snapshot_tags: [], events: [], runs: [] };
let meta: (Meta & { recorded_at?: number; frames?: number }) | null = null;
let idx = 0;
let byTag = new Map<string, Map<number, TagRow>>();

let readyResolve: () => void;
const ready = new Promise<void>((r) => (readyResolve = r));
/** Resolves once the recording is loaded and a frame is selected. */
export const replayReady = () => ready;

export async function loadReplay() {
  const base = import.meta.env.BASE_URL;
  const [f, d, m] = await Promise.all(
    ["frames", "db", "meta"].map((n) => fetch(`${base}replay/${n}.json`).then((r) => r.json())),
  );
  frames = f;
  db = d;
  meta = m;
  byTag = new Map();
  for (const t of db.snapshot_tags) {
    if (!byTag.has(t.tag)) byTag.set(t.tag, new Map());
    byTag.get(t.tag)!.set(t.snapshot_id, t);
  }
  return frames.length;
}

export const frameCount = () => frames.length;
export const frameIndex = () => idx;
export const setFrame = (i: number) => {
  idx = ((i % frames.length) + frames.length) % frames.length;
  readyResolve();
};
export const currentFrame = () => frames[idx];
export const recordedAt = () => meta?.recorded_at ?? null;
/** Recorded time of the current frame: the moment that window was published. */
export const frameTime = () => (frames[idx]?.leaderboard.generated_at ? Date.parse(frames[idx].leaderboard.generated_at!) / 1000 : 0);

class NotFound extends Error {
  status = 404;
}

function visibleSnaps() {
  const end = frames[idx].leaderboard.window_end ?? Infinity;
  return db.snapshots.filter((s) => s.end_ts <= end + 0.5);
}

function series(snaps: SnapRow[], tag: string) {
  const m = byTag.get(tag);
  return snaps.map((s) => {
    const r = m?.get(s.id);
    return { end_ts: s.end_ts, count: r?.count ?? 0, rank: r?.rank ?? null };
  });
}

function num(v: string | null) {
  return v === null || v === "" ? null : Number(v);
}

/** Same paths, parameters and response shapes as the Flask API. */
export function replayApi(path: string): unknown {
  const url = new URL(path, "http://replay");
  const q = url.searchParams;
  const p = url.pathname;
  const f = frames[idx];
  const lb = f.leaderboard;
  const T = lb.window_end ?? 0;

  if (p === "/api/leaderboard") return lb;
  if (p === "/api/health") return f.health;
  if (p === "/api/metrics") return f.metrics;
  if (p === "/api/meta") return meta;

  if (p === "/api/trends") {
    const mode = q.get("mode") ?? "volume";
    const limit = num(q.get("limit")) ?? 10;
    const items = (mode === "velocity" ? lb.trending ?? [] : lb.top).slice(0, limit);
    return { mode, source: lb.source, window_end: T, scoring: lb.scoring, items, note: null };
  }

  if (p === "/api/history") {
    const from = num(q.get("from"));
    const to = num(q.get("to"));
    const limit = num(q.get("limit")) ?? 240;
    let tags = (q.get("tags") ?? "").split(",").map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean).slice(0, 10);
    if (!tags.length) tags = lb.top.slice(0, 5).map((e) => e.tag);
    const all = visibleSnaps();
    const snaps = all.filter((s) => (from == null || s.end_ts >= from) && (to == null || s.end_ts <= to)).slice(-limit);
    return {
      source: lb.source,
      tags,
      snapshots: snaps,
      series: Object.fromEntries(tags.map((t) => [t, series(snaps, t)])),
      retention: { days: 7, oldest: all[0]?.end_ts ?? null, newest: all[all.length - 1]?.end_ts ?? null, snapshots: all.length },
    };
  }

  if (p === "/api/history/snapshot") {
    const at = num(q.get("at")) ?? T;
    const s = visibleSnaps().filter((x) => x.end_ts <= at).pop();
    if (!s) throw new NotFound("no snapshot at or before that time");
    const top = db.snapshot_tags.filter((t) => t.snapshot_id === s.id).sort((a, b) => a.rank - b.rank).slice(0, num(q.get("limit")) ?? 10);
    return { snapshot: s, top };
  }

  if (p === "/api/hashtags") {
    const needle = (q.get("q") ?? "").replace(/^#/, "").toLowerCase();
    const snaps = new Map(visibleSnaps().map((s) => [s.id, s]));
    const agg = new Map<string, { tag: string; peak_count: number; last_seen: number }>();
    for (const t of db.snapshot_tags) {
      const s = snaps.get(t.snapshot_id);
      if (!s || !t.tag.includes(needle)) continue;
      const a = agg.get(t.tag) ?? { tag: t.tag, peak_count: 0, last_seen: 0 };
      a.peak_count = Math.max(a.peak_count, t.count);
      a.last_seen = Math.max(a.last_seen, s.end_ts);
      agg.set(t.tag, a);
    }
    const items = [...agg.values()].sort((a, b) => b.peak_count - a.peak_count || a.tag.localeCompare(b.tag)).slice(0, num(q.get("limit")) ?? 20);
    return { query: needle, items };
  }

  if (p.startsWith("/api/hashtags/")) {
    const tag = decodeURIComponent(p.slice("/api/hashtags/".length)).replace(/^#/, "").toLowerCase();
    const snaps = visibleSnaps();
    const ser = series(snaps, tag);
    const present = snaps.filter((s) => byTag.get(tag)?.has(s.id));
    if (!present.length) throw new NotFound(`#${tag} has not appeared in any stored window`);
    const rows = present.map((s) => byTag.get(tag)!.get(s.id)!);
    const sum = (k: "positive" | "neutral" | "negative") => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    const cur = lb.top.find((e) => e.tag === tag);
    const vel = (lb.trending ?? []).find((e) => e.tag === tag);
    const src = cur ?? vel;
    const latest = ser[ser.length - 1];
    return {
      tag,
      source: lb.source,
      current: {
        window_end: T,
        count: latest?.count ?? 0,
        rank: latest?.rank ?? null,
        in_top: !!cur,
        delta: cur?.delta ?? null,
        growth: src?.growth ?? null,
        trend_score: src?.trend_score ?? null,
        baseline_count: src?.baseline_count ?? null,
        burst_score: src?.burst_score ?? null,
        velocity_rank: vel?.rank ?? null,
        sentiment: src?.sentiment ?? null,
      },
      overview: {
        first_seen: present[0].end_ts,
        last_seen: present[present.length - 1].end_ts,
        windows: present.length,
        peak_count: Math.max(...rows.map((r) => r.count)),
        best_rank: Math.min(...rows.map((r) => r.rank)),
        positive: sum("positive"),
        neutral: sum("neutral"),
        negative: sum("negative"),
      },
      series: ser,
      events: db.events.filter((e) => e.tag === tag && e.end_ts <= T + 0.5).reverse().slice(0, 50),
    };
  }

  if (p === "/api/sentiment") {
    const from = num(q.get("from"));
    const labels = meta?.dataset?.sentiment_labels;
    return {
      available: !!lb.sentiment,
      reason: lb.sentiment ? null : "the tweets in the current window carry no sentiment labels",
      provenance: labels?.provenance ?? null,
      note: labels?.note ?? null,
      current: lb.sentiment,
      by_tag: lb.top.filter((e) => e.sentiment).map((e) => ({ tag: e.tag, count: e.count, ...e.sentiment })),
      series: visibleSnaps()
        .filter((s) => s.sentiment && (from == null || s.end_ts >= from))
        .map((s) => ({ end_ts: s.end_ts, positive: s.sentiment!.positive, neutral: s.sentiment!.neutral, negative: s.sentiment!.negative })),
    };
  }

  if (p === "/api/events") {
    const from = num(q.get("from"));
    const to = num(q.get("to"));
    const tag = q.get("tag");
    const items = db.events
      .filter((e) => e.end_ts <= T + 0.5 && (from == null || e.end_ts >= from) && (to == null || e.end_ts <= to) && (!tag || e.tag === tag))
      .reverse()
      .slice(0, num(q.get("limit")) ?? 50);
    return { source: lb.source, items };
  }

  if (p === "/api/runs") {
    const from = num(q.get("from"));
    const runs = db.runs.filter((r) => (r.finished_at ?? r.started_at) <= f.captured_at && (from == null || r.started_at >= from));
    const ok = runs.filter((r) => r.status === "success");
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      source: lb.source,
      items: runs.slice(-(num(q.get("limit")) ?? 100)),
      stats: {
        ok: ok.length,
        failed: runs.filter((r) => r.status === "failed").length,
        avg_job: avg(ok.map((r) => r.job_seconds ?? 0)),
        max_job: ok.length ? Math.max(...ok.map((r) => r.job_seconds ?? 0)) : null,
        avg_delay: avg(runs.map((r) => r.schedule_delay ?? 0)),
      },
    };
  }

  throw new NotFound("unknown endpoint");
}
