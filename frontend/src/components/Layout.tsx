import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  ChevronsLeft,
  ChevronsRight,
  Hash,
  History,
  LayoutGrid,
  Menu,
  Moon,
  Pause,
  Play,
  Settings,
  Smile,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import { useLive, type Connection, type Range } from "../lib/live";
import { fmtAgo, fmtClock, nowMs } from "../lib/format";
import { Select, StateDot } from "./ui";
import type { HealthState } from "../lib/types";

export const NAV = [
  { to: "/", label: "Overview", Icon: LayoutGrid },
  { to: "/trends", label: "Live Trends", Icon: Activity },
  { to: "/explorer", label: "Hashtag Explorer", Icon: Hash },
  { to: "/sentiment", label: "Sentiment Analysis", Icon: Smile },
  { to: "/pipeline", label: "Pipeline Health", Icon: Workflow },
  { to: "/history", label: "Historical Analytics", Icon: History },
  { to: "/settings", label: "Settings", Icon: Settings },
];

function useNow(ms = 1000) {
  const [now, setNow] = useState(nowMs());
  useEffect(() => {
    const t = setInterval(() => setNow(nowMs()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Brand({ compact }: { compact: boolean }) {
  return (
    <div className="flex h-[72px] items-center gap-3 px-5">
      <svg viewBox="0 0 28 28" className="size-8 shrink-0" aria-hidden>
        <rect x="3" y="13" width="5.5" height="12" rx="2" fill="var(--accent)" opacity="0.5" />
        <rect x="11.25" y="4" width="5.5" height="21" rx="2" fill="var(--accent)" />
        <rect x="19.5" y="9" width="5.5" height="16" rx="2" fill="var(--accent)" opacity="0.75" />
      </svg>
      {!compact && (
        <div className="min-w-0 leading-tight">
          <div className="display text-[20px] leading-tight text-ink">PulseTrend</div>
          <div className="truncate text-[11.5px] text-ink-3">Real-Time Hashtag Analytics</div>
        </div>
      )}
    </div>
  );
}

function SystemStatus() {
  const { health } = useLive();
  const now = useNow(1000);
  const rows: [string, HealthState | undefined, boolean][] = health
    ? [
        ["Kafka", health.stages.kafka.state, health.stages.kafka.in_use],
        ["HDFS", health.stages.hdfs.state, health.stages.hdfs.in_use],
        ["MapReduce", health.stages.mapreduce.state, health.stages.mapreduce.in_use],
        ["API", health.stages.api.state, health.stages.api.in_use],
      ]
    : [];
  const all = health?.status === "healthy";
  const d = new Date(now);
  return (
    <div className="m-3 rounded-[var(--radius-card)] border border-line bg-surface p-3.5" style={{ boxShadow: "var(--card-shadow)" }}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="ping inline-block size-2 rounded-full" style={{ background: health ? (all ? "var(--good)" : "var(--warning)") : "var(--ink-3)", color: all ? "var(--good)" : "transparent" }} aria-hidden />
        {health ? (all ? "All systems online" : "Attention needed") : "Checking…"}
      </div>
      <div className="num mt-1.5 text-[15px] font-semibold">{d.toLocaleTimeString()}</div>
      <div className="text-[11.5px] text-ink-3">{d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
      <ul className="mt-3 space-y-1.5 border-t border-line pt-2.5">
        {rows.map(([name, st, inUse]) => (
          <li key={name} className="flex items-center justify-between text-[12px]">
            <span className="flex items-center gap-2 text-ink-2">
              <StateDot state={inUse ? st ?? "unknown" : "unknown"} />
              {name}
            </span>
            <span className="text-ink-3">{inUse ? cap(st ?? "unknown") : "Not used"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <Brand compact={collapsed} />
      <ul className="mt-2 flex-1 space-y-1 px-3">
        {NAV.map(({ to, label, Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={to === "/"}
              onClick={onNavigate}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                `relative flex h-11 items-center gap-3 rounded-[10px] px-3 text-[14px] transition-colors duration-150 ${
                  isActive ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-raised hover:text-ink"
                } ${collapsed ? "justify-center" : ""}`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" />}
                  <Icon size={19} aria-hidden className={isActive ? "text-accent" : ""} />
                  {!collapsed && <span>{label}</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      {!collapsed && <SystemStatus />}
      {onToggle && (
        <button
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="m-2 flex h-8 items-center justify-center gap-2 rounded-[var(--radius-ctl)] text-[12px] text-ink-3 hover:bg-raised hover:text-ink"
        >
          {collapsed ? <ChevronsRight size={16} aria-hidden /> : <><ChevronsLeft size={16} aria-hidden /> Collapse</>}
        </button>
      )}
    </nav>
  );
}

const HEAD: Record<string, { title: string; sub: string }> = {
  "/": { title: "Real-time trending hashtags", sub: "" },
  "/trends": { title: "Volume vs velocity", sub: "Which hashtags are biggest, and which are growing fastest" },
  "/explorer": { title: "Hashtag explorer", sub: "Counts, ranks, growth and sentiment for any stored hashtag" },
  "/sentiment": { title: "Sentiment analysis", sub: "Aggregated inside the same MapReduce job as the counts" },
  "/pipeline": { title: "Pipeline health", sub: "Kafka, HDFS, YARN, the driver and the API, each checked on its own" },
  "/history": { title: "Historical analytics", sub: "Every finished window, kept for 7 days" },
  "/settings": { title: "Settings", sub: "Display, live updates and system configuration" },
};

function overviewSub(lb: ReturnType<typeof useLive>["leaderboard"]) {
  const engine = lb?.source === "local-sim" ? "local MapReduce simulation" : "Hadoop MapReduce";
  const win = lb?.window_start != null && lb.window_end != null ? ` · window ${fmtClock(lb.window_start)}–${fmtClock(lb.window_end)}` : "";
  return `Streaming tweets via Kafka → HDFS → ${engine} (${lb?.window_minutes ?? 5}-minute window)${win}`;
}

const CONN: Record<Connection, { label: string; color: string; hint: string }> = {
  live: { label: "Live", color: "var(--good)", hint: "Receiving updates over Server-Sent Events" },
  polling: { label: "Polling", color: "var(--good)", hint: "Receiving updates by polling the API" },
  connecting: { label: "Connecting", color: "var(--warning)", hint: "Connecting to the update stream" },
  disconnected: { label: "Disconnected", color: "var(--critical)", hint: "The dashboard API is unreachable" },
  replay: { label: "Replay", color: "var(--accent)", hint: "Playing back a recorded run of the real pipeline" },
};

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { connection, leaderboard, paused, setPaused, pendingUpdates, settings, update, health } = useLive();
  const { pathname } = useLocation();
  useNow(5000);
  const page = NAV.find((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to))) ?? NAV[0];
  const c = CONN[connection];
  const genTs = leaderboard?.generated_at ? new Date(leaderboard.generated_at).getTime() / 1000 : null;
  const mode = health?.data_mode ?? leaderboard?.freshness?.mode;
  return (
    <header className="sticky top-0 z-20 bg-canvas/85 backdrop-blur-md">
      <div className="flex min-h-[88px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:px-8">
        <button onClick={onMenu} className="-ml-1 rounded-md p-1.5 text-ink-2 hover:bg-raised lg:hidden" aria-label="Open navigation">
          <Menu size={19} aria-hidden />
        </button>
        <div className="min-w-[200px] flex-1">
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">{page.label}</div>
          <h1 className="text-[22px] font-bold leading-tight sm:truncate sm:text-[26px]">{HEAD[page.to]?.title ?? page.label}</h1>
          <p className="line-clamp-2 text-[13px] text-ink-2 sm:truncate sm:text-[13.5px]">{page.to === "/" ? overviewSub(leaderboard) : HEAD[page.to]?.sub}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3 text-[12.5px]" title={c.hint}>
            <span
              aria-hidden
              className={`inline-block size-2 rounded-full ${connection === "live" && !paused ? "ping" : ""}`}
              style={{ background: paused ? "var(--ink-3)" : c.color, color: c.color }}
            />
            <span className="font-semibold" style={{ color: paused ? undefined : c.color }}>{paused ? "Paused" : c.label}</span>
            {mode === "simulation" || mode === "simulation-finished" ? (
              <span className="text-ink-3">· simulation</span>
            ) : null}
          </span>
          <span className="hidden text-[12px] text-ink-3 sm:inline" title="Time the latest MapReduce window was produced">
            Updated <span className="num text-ink-2">{fmtClock(genTs, true)}</span>
            {genTs && <span> · {fmtAgo(nowMs() / 1000 - genTs)}</span>}
          </span>
          <Select<Range>
            label="Chart history range"
            value={settings.range}
            onChange={(v) => update({ range: v })}
            options={[
              { value: "15", label: "Last 15 minutes" },
              { value: "30", label: "Last 30 minutes" },
              { value: "60", label: "Last 60 minutes" },
              { value: "all", label: "All stored history" },
            ]}
          />
          <button
            onClick={() => setPaused(!paused)}
            aria-pressed={paused}
            title={paused ? "Resume visual updates" : "Pause visual updates (the pipeline keeps running)"}
            className={`inline-flex h-9 items-center gap-1.5 rounded-[10px] border px-3 text-[12.5px] font-semibold ${
              paused ? "border-accent bg-accent-soft text-ink" : "border-line bg-surface text-ink-2 hover:text-ink"
            }`}
          >
            {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
            {paused ? `Resume${pendingUpdates ? ` (${pendingUpdates} new)` : ""}` : "Pause"}
          </button>
          <button
            onClick={() => update({ theme: settings.theme === "dark" ? "light" : "dark" })}
            aria-label={`Switch to ${settings.theme === "dark" ? "light" : "dark"} theme`}
            className="inline-flex size-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-sm hover:text-ink"
          >
            {settings.theme === "dark" ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
          </button>
        </div>
      </div>
      <StatusBanner />
    </header>
  );
}

function StatusBanner() {
  const { leaderboard, connection, paused, health, replay } = useLive();
  const f = leaderboard?.freshness;
  let tone: "warn" | "info" | "crit" | null = null;
  let text: ReactNode = null;
  if (connection === "replay" && replay) {
    tone = "info";
    const day = leaderboard?.generated_at ? new Date(leaderboard.generated_at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "";
    text = (
      <>
        <b className="font-semibold text-ink">Recorded replay</b> of a real run on {day}: tweets streamed through Kafka into HDFS and counted by Hadoop
        MapReduce on YARN. Window {replay.index + 1} of {replay.total} is shown; a new recorded window plays every 12 s and the run loops.
        {paused ? " Playback paused." : ""}
      </>
    );
  } else if (connection === "disconnected") {
    tone = "crit";
    text = "The dashboard API is unreachable. Showing the last data received; reconnecting automatically.";
  } else if (paused) {
    tone = "info";
    text = "Visual updates are paused. The pipeline keeps running; new windows are buffered until you resume.";
  } else if (f?.mode === "stale") {
    tone = "warn";
    text = (
      <>
        Stale data: the latest window is {fmtAgo(f.age_seconds)} old (expected within {f.stale_after} s).{" "}
        {health?.stages.mapreduce.summary ? `MapReduce: ${health.stages.mapreduce.summary}.` : ""} The last good snapshot stays visible.
      </>
    );
  } else if (f?.mode === "simulation" || f?.mode === "simulation-finished") {
    tone = "info";
    text =
      f.mode === "simulation"
        ? "Local simulation: demo_local.py replays the dataset on a simulated clock through the same mapper/reducer. Kafka, HDFS and YARN are not involved."
        : "Local simulation finished: showing its final window. Start the live pipeline (scripts/demo.sh up) for real Hadoop results.";
  }
  if (!tone) return null;
  const border = tone === "crit" ? "var(--critical)" : tone === "warn" ? "var(--warning)" : "var(--accent)";
  return (
    <div role="status" aria-live="polite" className="border-t border-line bg-surface-2 px-4 py-2 text-[12.5px] text-ink-2 lg:px-6" style={{ boxShadow: `inset 3px 0 0 ${border}` }}>
      {text}
    </div>
  );
}

function PageTransition({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}>
      {children}
    </motion.div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("pt-sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("pt-sidebar", c ? "open" : "collapsed");
      } catch {
        /* ignore */
      }
      return !c;
    });

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside
        className={`fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-surface lg:block ${collapsed ? "w-[72px]" : "w-[248px]"}`}
      >
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-black/50" aria-label="Close navigation" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[260px] border-r border-line bg-surface" style={{ boxShadow: "var(--shadow)" }}>
            <button onClick={() => setDrawer(false)} className="absolute right-2 top-3 rounded-md p-1.5 text-ink-2 hover:bg-raised" aria-label="Close navigation">
              <X size={18} aria-hidden />
            </button>
            <Sidebar collapsed={false} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}
      <div className={collapsed ? "lg:pl-[72px]" : "lg:pl-[248px]"}>
        <TopBar onMenu={() => setDrawer(true)} />
        <main id="main" className="mx-auto max-w-[1680px] px-4 pb-10 pt-2 lg:px-8">
          <PageTransition key={pathname}>{children}</PageTransition>
        </main>
      </div>
    </div>
  );
}
