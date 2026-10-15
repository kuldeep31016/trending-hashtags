import { useCallback, useEffect, useRef, useState } from "react";
import { REPLAY, replayApi, replayReady } from "./replay";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function fetchJson<T>(path: string, timeoutMs = 10000): Promise<T> {
  if (REPLAY) {
    // hosted build: answer from the recorded run instead of a live API
    await replayReady();
    try {
      return structuredClone(replayApi(path)) as T;
    } catch (e) {
      throw new ApiError((e as { status?: number }).status ?? 500, (e as { status?: number }).status === 404 ? "not_found" : "replay_error", (e as Error).message);
    }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { signal: ctl.signal, cache: "no-store", headers: { Accept: "application/json" } });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      throw new ApiError(r.status, body?.error?.code ?? "http_error", body?.error?.message ?? `HTTP ${r.status}`);
    }
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === "AbortError") throw new ApiError(0, "timeout", "The API did not answer in time");
    throw new ApiError(0, "network", "Cannot reach the dashboard API");
  } finally {
    clearTimeout(timer);
  }
}

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch `path` whenever it or `refreshKey` changes (refreshKey = the live window id, so
 * pages refetch when a new MapReduce window lands). Keeps the last good data on error.
 */
export function useResource<T>(path: string | null, refreshKey: unknown = null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (path === null) return;
    const id = ++latest.current;
    setLoading(true);
    fetchJson<T>(path)
      .then((d) => {
        if (id !== latest.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: ApiError) => {
        if (id === latest.current) setError(e);
      })
      .finally(() => {
        if (id === latest.current) setLoading(false);
      });
  }, [path, refreshKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
