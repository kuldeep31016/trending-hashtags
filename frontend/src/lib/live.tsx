import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchJson } from "./api";
import { REPLAY, frameCount, frameTime, loadReplay, setFrame, frameIndex, currentFrame } from "./replay";
import { setClockOffset } from "./format";
import type { Health, Leaderboard } from "./types";

export type Connection = "connecting" | "live" | "polling" | "disconnected" | "replay";
export type Transport = "sse" | "poll";
export type Range = "15" | "30" | "60" | "all";
export type Theme = "light" | "dark";

interface Settings {
  transport: Transport;
  pollSeconds: number;
  range: Range;
  theme: Theme;
}

interface LiveState {
  leaderboard: Leaderboard | null;
  previousLeaderboard: Leaderboard | null;
  health: Health | null;
  connection: Connection;
  lastUpdate: number | null; // browser time a new window arrived
  paused: boolean;
  pendingUpdates: number;
  windowKey: string | null; // changes whenever a new MapReduce window is displayed
  settings: Settings;
  replay: { index: number; total: number } | null;
  setPaused: (p: boolean) => void;
  update: (s: Partial<Settings>) => void;
}

const REPLAY_FIRST_FRAME = 3;
const REPLAY_STEP_MS = 12000; // one recorded MapReduce window every 12 s of playback

const DEFAULTS: Settings = { transport: "sse", pollSeconds: 5, range: "30", theme: "light" };
const KEY = "pt-settings";

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const theme = localStorage.getItem("pt-theme");
    return { ...DEFAULTS, ...saved, theme: theme === "light" || theme === "dark" ? theme : DEFAULTS.theme };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(s: Settings) {
  try {
    const { theme, ...rest } = s;
    localStorage.setItem(KEY, JSON.stringify(rest));
    localStorage.setItem("pt-theme", theme);
  } catch {
    /* storage unavailable (private mode): settings just won't persist */
  }
}

const Ctx = createContext<LiveState | null>(null);

const keyOf = (lb: Leaderboard | null) => (lb ? `${lb.generated_at ?? ""}|${lb.window_end ?? ""}` : null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [shown, setShown] = useState<{ cur: Leaderboard | null; prev: Leaderboard | null }>({ cur: null, prev: null });
  const [health, setHealth] = useState<Health | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [paused, setPausedState] = useState(false);
  const [pendingUpdates, setPending] = useState(0);
  const pausedRef = useRef(false);
  const buffered = useRef<{ lb?: Leaderboard; health?: Health }>({});
  const shownKey = useRef<string | null>(null);

  const acceptLeaderboard = useCallback((lb: Leaderboard) => {
    const k = keyOf(lb);
    if (k === shownKey.current) {
      setShown((s) => ({ ...s, cur: lb })); // same window, refreshed freshness info
      return;
    }
    if (pausedRef.current) {
      buffered.current.lb = lb;
      setPending((n) => n + 1);
      return;
    }
    shownKey.current = k;
    setShown((s) => ({ prev: s.cur && s.cur.top.length ? s.cur : s.prev, cur: lb }));
    setLastUpdate(Date.now());
  }, []);

  const acceptHealth = useCallback((h: Health) => {
    if (pausedRef.current) buffered.current.health = h;
    else setHealth(h);
  }, []);

  const setPaused = useCallback(
    (p: boolean) => {
      pausedRef.current = p;
      setPausedState(p);
      if (!p) {
        const { lb, health: h } = buffered.current;
        buffered.current = {};
        setPending(0);
        if (h) setHealth(h);
        if (lb) acceptLeaderboard(lb);
      }
    },
    [acceptLeaderboard],
  );

  // replay build: step through the recorded windows on a loop, like new windows arriving
  const [replayPos, setReplayPos] = useState<{ index: number; total: number } | null>(null);
  useEffect(() => {
    if (!REPLAY) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const show = (i: number) => {
      setFrame(i);
      const f = currentFrame();
      setClockOffset(Date.now() - frameTime() * 1000);
      acceptLeaderboard(f.leaderboard);
      acceptHealth(f.health);
      setReplayPos({ index: frameIndex(), total: frameCount() });
    };
    loadReplay()
      .then((n) => {
        if (cancelled || !n) return;
        setConnection("replay");
        show(Math.min(REPLAY_FIRST_FRAME, n - 1)); // open on a window that already has history to show
        timer = setInterval(() => {
          if (!pausedRef.current) show(frameIndex() + 1);
        }, REPLAY_STEP_MS);
      })
      .catch(() => !cancelled && setConnection("disconnected"));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [acceptLeaderboard, acceptHealth]);

  // transport: SSE first, polling as fallback (or when chosen in Settings)
  useEffect(() => {
    if (REPLAY) return;
    let closed = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;

    const poll = async () => {
      try {
        const [lb, h] = await Promise.all([
          fetchJson<Leaderboard>("/api/leaderboard"),
          fetchJson<Health>("/api/health"),
        ]);
        if (closed) return;
        acceptLeaderboard(lb);
        acceptHealth(h);
        setConnection("polling");
      } catch {
        if (!closed) setConnection("disconnected");
      }
    };
    const startPolling = () => {
      if (timer) return;
      poll();
      timer = setInterval(poll, Math.max(2, settings.pollSeconds) * 1000);
    };

    if (settings.transport === "poll" || typeof EventSource === "undefined") {
      startPolling();
    } else {
      setConnection("connecting");
      es = new EventSource("/api/stream");
      es.addEventListener("open", () => {
        failures = 0;
        setConnection("live");
      });
      es.addEventListener("leaderboard", (e) => {
        setConnection("live");
        acceptLeaderboard(JSON.parse((e as MessageEvent).data));
      });
      es.addEventListener("health", (e) => acceptHealth(JSON.parse((e as MessageEvent).data)));
      es.addEventListener("error", () => {
        failures += 1;
        setConnection(failures >= 3 ? "disconnected" : "connecting");
        if (failures >= 3) {
          es?.close();
          es = null;
          startPolling(); // keep the dashboard working through proxies that break SSE
        }
      });
    }
    return () => {
      closed = true;
      es?.close();
      if (timer) clearInterval(timer);
    };
  }, [settings.transport, settings.pollSeconds, acceptLeaderboard, acceptHealth]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  const update = useCallback((s: Partial<Settings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...s };
      saveSettings(next);
      return next;
    });
  }, []);

  const value = useMemo<LiveState>(
    () => ({
      leaderboard: shown.cur,
      previousLeaderboard: shown.prev,
      health,
      connection,
      lastUpdate,
      paused,
      pendingUpdates,
      windowKey: keyOf(shown.cur),
      settings,
      replay: replayPos,
      setPaused,
      update,
    }),
    [shown, health, connection, lastUpdate, paused, pendingUpdates, settings, replayPos, setPaused, update],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}

/** `from` query value for the selected chart range, relative to the latest window end. */
export function rangeFrom(range: Range, windowEnd: number | undefined): number | null {
  if (range === "all" || !windowEnd) return null;
  return windowEnd - Number(range) * 60;
}
