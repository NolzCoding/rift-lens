import { Brain, BrainCircuit, Radio, RotateCcw } from "lucide-react";

import { LiveGameDashboard } from "@/components/live-game-dashboard";
import { isLiveFixtureName } from "@/lib/live-fixtures";

export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { mock } = await searchParams;
  return (
    <main>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="site-header live-site-header live-page-header">
        <div className="brand-mark"><BrainCircuit size={19} /></div>
        <div>
          <div className="brand-name">RIFT<span>//</span>LENS</div>
          <p>Live game copilot</p>
        </div>
        <nav>
          <a href="/"><RotateCcw size={12} /> Replay review</a>
          <a href="/live"><Radio size={12} /> Live second screen</a>
          <a href="/profile"><Brain size={12} /> Memory</a>
        </nav>
        <div className="header-status"><span /> Local-only feed</div>
      </header>
      <div className="live-page-shell"><LiveGameDashboard mock={isLiveFixtureName(mock) ? mock : null} /></div>
    </main>
  );
}
