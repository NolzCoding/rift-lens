import type { Metadata } from "next";
import { connection } from "next/server";
import { BrainCircuit, History, Radio, RotateCcw } from "lucide-react";

import { ProfileView } from "@/components/profile-view";
import { ensureResearchLoaded, researchOverview } from "@/lib/build-research";
import { profileImports } from "@/lib/item-set-import";
import { readSettings } from "@/lib/memory-store";
import { getProfile, scheduleMatchHistoryImport } from "@/lib/player-profile";

import "./profile.css";

export const metadata: Metadata = {
  title: "Rift Lens — Player memory",
  description: "Long-term memory across recorded live games: builds, matchups, killers and recurring mistakes.",
};

export default async function ProfilePage() {
  await connection();
  // Throttled and fire-and-forget: never delays the page; new games show after the next load or Rebuild.
  scheduleMatchHistoryImport();
  // Researched builds feed the build check, so they are in memory before the profile is built (read once per server start).
  await ensureResearchLoaded();
  const [profile, settings, extras, research] = await Promise.all([getProfile(), readSettings(), profileImports(), researchOverview()]);
  return (
    <main>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="site-header live-site-header">
        <div className="brand-mark"><BrainCircuit size={19} /></div>
        <div>
          <div className="brand-name">RIFT<span>//</span>LENS</div>
          <p>Player memory</p>
        </div>
        <nav>
          <a href="/"><RotateCcw size={12} /> Replay review</a>
          <a href="/live"><Radio size={12} /> Live second screen</a>
          <a href="/profile"><History size={12} /> Memory</a>
        </nav>
        <div className="header-status"><span /> Stored on this PC</div>
      </header>
      <div className="profile-shell"><ProfileView initial={{ profile, settings, ...extras, research }} /></div>
    </main>
  );
}
