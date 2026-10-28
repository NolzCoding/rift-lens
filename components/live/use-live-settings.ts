"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LiveHelpPower } from "@/lib/types";

export type VoiceMode = "off" | "high" | "all";
export type LiveSettings = { autoDeathCoach: boolean; autoGamePlan: boolean; voice: VoiceMode; power: LiveHelpPower };

export const DEFAULT_LIVE_SETTINGS: LiveSettings = { autoDeathCoach: true, autoGamePlan: true, voice: "off", power: "strong" };
const STORAGE_KEY = "rift-lens:live-settings";

export function useLiveSettings() {
  const [settings, setSettings] = useState<LiveSettings>(DEFAULT_LIVE_SETTINGS);
  // Auto-triggers wait for this so a stored "off" is honoured on the first render.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null") as Partial<LiveSettings> | null;
      if (stored) setSettings({
        autoDeathCoach: typeof stored.autoDeathCoach === "boolean" ? stored.autoDeathCoach : DEFAULT_LIVE_SETTINGS.autoDeathCoach,
        autoGamePlan: typeof stored.autoGamePlan === "boolean" ? stored.autoGamePlan : DEFAULT_LIVE_SETTINGS.autoGamePlan,
        voice: stored.voice === "high" || stored.voice === "all" ? stored.voice : "off",
        power: stored.power === "quick" || stored.power === "max" ? stored.power : DEFAULT_LIVE_SETTINGS.power,
      });
    } catch { /* storage unavailable: keep defaults */ }
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<LiveSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { settings, update, ready };
}

/** Speech for alerts. Keeps at most ~2 utterances in flight and drops stale ones. */
export function useVoice(mode: VoiceMode) {
  const pending = useRef<SpeechSynthesisUtterance[]>([]);

  useEffect(() => {
    if (mode !== "off") return;
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    pending.current = [];
  }, [mode]);

  return useCallback((text: string, { priority = "normal", urgent = false }: { priority?: "high" | "normal"; urgent?: boolean } = {}) => {
    if (mode === "off" || (mode === "high" && priority !== "high" && !urgent)) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth || !text) return;
      if (urgent || pending.current.length >= 2) { synth.cancel(); pending.current = []; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.08;
      const done = () => { pending.current = pending.current.filter((entry) => entry !== utterance); };
      utterance.onend = done;
      utterance.onerror = done;
      pending.current.push(utterance);
      synth.speak(utterance);
    } catch { /* speech unavailable */ }
  }, [mode]);
}
