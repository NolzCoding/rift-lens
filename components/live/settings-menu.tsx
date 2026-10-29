"use client";

import { useEffect, useRef, useState } from "react";
import { Settings2, Volume2, VolumeX } from "lucide-react";

import type { LiveSettings, VoiceMode } from "@/components/live/use-live-settings";
import type { LiveHelpPower } from "@/lib/types";

const VOICE_OPTIONS: Array<{ value: VoiceMode; label: string }> = [{ value: "off", label: "Off" }, { value: "high", label: "Urgent" }, { value: "all", label: "All" }];
const POWER_OPTIONS: Array<{ value: LiveHelpPower; label: string; hint: string }> = [
  { value: "quick", label: "Quick", hint: "Fastest answers, lightest reasoning" },
  { value: "strong", label: "Strong", hint: "Balanced — deeper on Deep read" },
  { value: "max", label: "Max", hint: "Deepest reasoning everywhere, slowest" },
];

type ProviderName = "codex" | "antigravity" | "gemini";
type ProviderStatus = {
  provider: ProviderName;
  source: "setting" | "env" | "default";
  providers: Record<ProviderName, { installed: boolean | null; signedIn: boolean; hint: string }>;
};
const PROVIDER_OPTIONS: Array<{ value: ProviderName; label: string; name: string }> = [
  { value: "codex", label: "Codex", name: "Codex" }, { value: "antigravity", label: "Antigravity", name: "Antigravity CLI" }, { value: "gemini", label: "Gemini", name: "Gemini CLI" },
];

/** Codex (ChatGPT login), Antigravity CLI or Gemini CLI (Google login): saved server-side, so build research follows it too. */
function ProviderRow() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/ai-provider", { cache: "no-store" }).then((response) => response.json()).then((data: ProviderStatus) => { if (live) setStatus(data); }).catch(() => { if (live) setError("AI status unavailable"); });
    return () => { live = false; };
  }, []);

  const choose = (provider: ProviderName) => {
    setError("");
    fetch("/api/ai-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) })
      .then((response) => response.json()).then((data: ProviderStatus) => setStatus(data)).catch(() => setError("Could not save the AI provider"));
  };

  const current = status?.providers[status.provider];
  const hint = error || (!status ? "Checking…" : current?.signedIn ? `${PROVIDER_OPTIONS.find((option) => option.value === status.provider)?.name} signed in` : current?.hint || "Not signed in");
  return (
    <div className="voice-row">
      <span><b>AI provider</b><small>{hint}</small></span>
      <div className="mode-toggle">
        {PROVIDER_OPTIONS.map((option) => <button type="button" key={option.value} disabled={!status} className={status?.provider === option.value ? "active" : ""} onClick={() => choose(option.value)}>{option.label}</button>)}
      </div>
    </div>
  );
}

export function SettingsMenu({ settings, onChange }: { settings: LiveSettings; onChange: (patch: Partial<LiveSettings>) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  return (
    <div className="live-settings" ref={root}>
      <button type="button" className="live-settings-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open} title="Live settings" aria-label="Live settings">
        {settings.voice === "off" ? <VolumeX size={18} /> : <Volume2 size={18} />}
        <Settings2 size={20} />
      </button>
      {open && (
        <div className="live-settings-panel" role="dialog" aria-label="Live settings">
          <label><input type="checkbox" checked={settings.autoDeathCoach} onChange={(event) => onChange({ autoDeathCoach: event.target.checked })} /><span><b>Auto coach on death</b><small>One AI read per death</small></span></label>
          <label><input type="checkbox" checked={settings.autoGamePlan} onChange={(event) => onChange({ autoGamePlan: event.target.checked })} /><span><b>Auto game plan</b><small>Once per game, first 90s</small></span></label>
          <ProviderRow />
          <div className="voice-row">
            <span><b>AI power</b><small>{POWER_OPTIONS.find((option) => option.value === settings.power)?.hint}</small></span>
            <div className="mode-toggle">
              {POWER_OPTIONS.map((option) => <button type="button" key={option.value} className={settings.power === option.value ? "active" : ""} onClick={() => onChange({ power: option.value })}>{option.label}</button>)}
            </div>
          </div>
          <div className="voice-row">
            <span><b>Voice</b><small>Spoken alerts + death summary</small></span>
            <div className="mode-toggle">
              {VOICE_OPTIONS.map((option) => <button type="button" key={option.value} className={settings.voice === option.value ? "active" : ""} onClick={() => onChange({ voice: option.value })}>{option.label}</button>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
