"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LiveGameSnapshot, LiveHelpEnvelope, LiveHelpMode, LiveHelpPower, LiveHelpRequest } from "@/lib/types";

export type HelpSlot = {
  /** Caller-defined identity of what this read is about (e.g. gameId:diedAt). */
  key: string | null;
  mode: LiveHelpMode | null;
  envelope: LiveHelpEnvelope | null;
  loading: boolean;
  startedAt: number | null;
  /** Date.now() when the current envelope arrived (cache hits included); orders reads from different slots. */
  receivedAt: number | null;
  error: string | null;
};

const EMPTY: HelpSlot = { key: null, mode: null, envelope: null, loading: false, startedAt: null, receivedAt: null, error: null };

/** One HELP ME request slot. A newer run or reset() discards any in-flight response. */
export function useLiveHelp() {
  const [slot, setSlot] = useState<HelpSlot>(EMPTY);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  const run = useCallback(async (snapshot: LiveGameSnapshot, mode: LiveHelpMode, options: { key?: string; userFocus?: string; power?: LiveHelpPower } = {}) => {
    const id = ++generation.current;
    const key = options.key ?? null;
    setSlot((current) => ({ ...current, key, mode, loading: true, startedAt: Date.now(), error: null, ...(current.key === key ? {} : { envelope: null, receivedAt: null }) }));
    try {
      const body: LiveHelpRequest = { snapshot, mode, ...(options.power ? { power: options.power } : {}), ...(options.userFocus ? { userFocus: options.userFocus } : {}) };
      const response = await fetch("/api/live-help", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as LiveHelpEnvelope & { error?: string; details?: string };
      if (!response.ok) throw new Error([payload.error, payload.details].filter(Boolean).join(" ") || `HELP ME failed (${response.status}).`);
      if (id !== generation.current) return null;
      setSlot({ key, mode, envelope: payload, loading: false, startedAt: null, receivedAt: Date.now(), error: null });
      return payload;
    } catch (error) {
      if (id !== generation.current) return null;
      setSlot((current) => ({ ...current, loading: false, startedAt: null, error: error instanceof Error ? error.message : "HELP ME could not finish." }));
      return null;
    }
  }, []);

  const reset = useCallback(() => { generation.current += 1; setSlot(EMPTY); }, []);

  return { slot, run, reset };
}
