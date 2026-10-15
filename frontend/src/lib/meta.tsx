import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useResource } from "./api";
import { useLive } from "./live";
import type { Meta } from "./types";

const Ctx = createContext<Meta | null>(null);

/** Fetches /api/meta once per result source and shares it with every component. */
export function MetaProvider({ children }: { children: ReactNode }) {
  const { leaderboard } = useLive();
  const meta = useResource<Meta>("/api/meta", leaderboard?.source ?? null).data;
  return <Ctx.Provider value={meta}>{children}</Ctx.Provider>;
}

export function useMeta() {
  return useContext(Ctx);
}

/** Hashtags whose bursts were injected into the demo dataset on purpose. */
export function useInjected(): Set<string> {
  const meta = useMeta();
  return useMemo(() => new Set((meta?.dataset?.injected_bursts ?? []).map((b) => b.tag)), [meta]);
}
