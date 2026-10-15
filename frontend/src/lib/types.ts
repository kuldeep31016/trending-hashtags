export type Source = "hadoop" | "local" | "local-sim";
export type DataMode = "live" | "stale" | "simulation" | "simulation-finished" | "empty";
export type HealthState = "healthy" | "degraded" | "down" | "unknown";

export interface Sentiment {
  positive: number;
  neutral: number;
  negative: number;
  labeled?: number;
  unlabeled?: number;
}

export interface LeaderEntry {
  rank: number;
  tag: string;
  count: number;
  delta: number | null;
  series: number[];
  baseline_count?: number | null;
  growth?: number | null;
  trend_score?: number | null;
  burst_score?: number | null;
  sentiment?: Sentiment | null;
}

export interface TrendingEntry extends Omit<LeaderEntry, "delta"> {
  volume_rank: number;
}

export interface TrendEvent {
  id?: number;
  kind: "new_leader" | "entered_top" | "left_top" | "surge";
  tag: string | null;
  end_ts?: number;
  created?: number;
  detail: Record<string, number | string | null>;
}

export interface Freshness {
  age_seconds: number | null;
  stale: boolean | null;
  stale_after: number | null;
  mode: DataMode;
}

export interface Leaderboard {
  generated_at?: string;
  source?: Source;
  window_minutes?: number;
  window_start?: number;
  window_end?: number;
  total_tweets?: number;
  distinct_tags?: number;
  tag_mentions?: number;
  job_seconds?: number | null;
  top: LeaderEntry[];
  trending?: TrendingEntry[];
  sentiment?: Sentiment | null;
  previous?: {
    window_end: number;
    total_tweets: number;
    distinct_tags?: number;
    tag_mentions?: number;
    job_seconds?: number | null;
    generated_at?: string;
  } | null;
  scoring?: {
    k: number;
    min_count: number;
    lookback_seconds: number;
    baseline_end: number | null;
    baseline_scale?: number | null;
    surge_score: number;
  };
  events?: TrendEvent[];
  status?: string;
  freshness: Freshness;
}

export interface Stage {
  state: HealthState;
  summary: string;
  in_use: boolean;
  note?: string;
  // stage-specific diagnostics
  check?: Record<string, any>;
  producer?: Record<string, any> | null;
  sink?: Record<string, any> | null;
  last_flush?: number | null;
  yarn?: Record<string, any> | null;
  driver?: Record<string, any>;
  last_success?: Run | null;
  last_failure?: Run | null;
  latency?: { requests: number; avg_ms: number; p95_ms: number } | null;
  freshness?: Freshness;
}

export interface Health {
  status: HealthState;
  checked_at: number;
  cluster_checked_at: number | null;
  source: Source;
  data_mode: DataMode;
  freshness: Freshness;
  stages: { kafka: Stage; hdfs: Stage; mapreduce: Stage; api: Stage };
}

export interface Run {
  id?: number;
  started_at: number;
  finished_at?: number;
  end_ts?: number;
  status: "success" | "failed" | "skipped";
  attempts: number;
  job_seconds: number | null;
  schedule_delay: number | null;
  error?: string | null;
}

export interface Metrics {
  measured_at: number;
  source: Source;
  ingest: {
    producer_sent_total: number | null;
    sink_consumed_total: number | null;
    sink_written_total: number | null;
    sink_write_errors_total: number;
    tweets_written_last_min: number | null;
    avg_ingest_lag_s: number | null;
    avg_hdfs_write_s: number | null;
    per_minute: { ts: number; written: number; lag_avg: number | null; write_s: number }[];
    note: string | null;
  };
  processing: {
    last_job_s: number | null;
    avg_job_s: number | null;
    max_job_s: number | null;
    jobs_succeeded: number;
    jobs_failed: number;
    avg_schedule_delay_s: number | null;
    distinct_hashtags: number | null;
    hashtag_mentions: number | null;
    tweets_in_window: number | null;
    runs: Run[];
  };
  api: { requests: number; avg_ms: number | null; p95_ms: number | null; requests_since_start: number };
  snapshot: { generated_at: string | null; age_s: number | null };
}

export interface SnapshotRow {
  id: number;
  end_ts: number;
  window_start: number;
  window_minutes: number;
  total_tweets: number;
  distinct_tags: number;
  tag_mentions: number;
  job_seconds: number | null;
  sentiment: Sentiment | null;
}

export interface SeriesPoint {
  end_ts: number;
  count: number;
  rank: number | null;
}

export interface History {
  source: Source;
  tags: string[];
  snapshots: SnapshotRow[];
  series: Record<string, SeriesPoint[]>;
  retention: { days: number; oldest: number | null; newest: number | null; snapshots: number };
}

export interface HashtagDetail {
  tag: string;
  source: Source;
  current: {
    window_end: number | null;
    count: number;
    rank: number | null;
    in_top: boolean;
    delta: number | null;
    growth: number | null;
    trend_score: number | null;
    baseline_count: number | null;
    burst_score: number | null;
    velocity_rank: number | null;
    sentiment: Sentiment | null;
  };
  overview: {
    first_seen: number;
    last_seen: number;
    windows: number;
    peak_count: number;
    best_rank: number;
    positive: number | null;
    neutral: number | null;
    negative: number | null;
  };
  series: SeriesPoint[];
  events: TrendEvent[];
}

export interface SentimentResponse {
  available: boolean;
  reason: string | null;
  provenance: "template" | "dataset" | null;
  note: string | null;
  current: Sentiment | null;
  by_tag: ({ tag: string; count: number } & Partial<Sentiment>)[];
  series: ({ end_ts: number } & Sentiment)[];
}

export interface Meta {
  dataset: {
    generated_at: string;
    tweets: number;
    sources: string[];
    synthetic: boolean;
    seed: number;
    enriched: boolean;
    injected_bursts: { tag: string; start_fraction: number; end_fraction: number; probability: number }[];
    sentiment_labels: { labeled: number; provenance: string; note: string };
  } | null;
  pipeline: {
    window_minutes: number;
    interval_seconds: number;
    source: Source | null;
    scoring: Leaderboard["scoring"] | null;
    retention_days: number;
  };
  endpoints: { hdfs_ui: string; yarn_ui: string };
}
