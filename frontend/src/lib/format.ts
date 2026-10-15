const nf = new Intl.NumberFormat();

/** Wall clock, shifted to the recorded time when the dashboard plays back a recorded run. */
let clockOffsetMs = 0;
export const setClockOffset = (ms: number) => (clockOffsetMs = ms);
export const nowMs = () => Date.now() - clockOffsetMs;

export const fmtInt = (n: number | null | undefined) => (n == null ? "—" : nf.format(Math.round(n)));

export function fmtNum(n: number | null | undefined, digits = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSecs(s: number | null | undefined) {
  if (s == null) return "—";
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export const fmtClock = (ts: number | null | undefined, seconds = false) =>
  ts == null
    ? "—"
    : new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });

export const fmtDateTime = (ts: number | null | undefined) =>
  ts == null
    ? "—"
    : new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function fmtAgo(seconds: number | null | undefined) {
  if (seconds == null) return "never";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export const agoFromTs = (ts: number | null | undefined) => (ts == null ? null : nowMs() / 1000 - ts);

/** Relative change in percent, or null when there is no comparable previous value. */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined) {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

export const fmtPct = (p: number | null, digits = 1) =>
  p == null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(digits)}%`;

export const SERIES_VARS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
export const seriesColor = (i: number) => `var(${SERIES_VARS[i % SERIES_VARS.length]})`;

/** Stable color per hashtag within a chart: assignment follows the entity's position in the
 * user's selection order, never its rank, so re-sorting does not repaint lines. */
export function colorMap(tags: string[]) {
  const m: Record<string, string> = {};
  tags.forEach((t, i) => (m[t] = seriesColor(i)));
  return m;
}
