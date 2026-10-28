"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Coins,
  Crosshair,
  Eye,
  Gauge,
  GitCompareArrows,
  Radio,
  ShieldAlert,
  ShoppingBag,
  Skull,
  Sparkles,
  Swords,
  Target,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { AiCoachPanel, type AiCoachState } from "@/components/ai-coach-panel";
import { ItemBuild } from "@/components/item-build";
import { MetricRing } from "@/components/metric-ring";
import { TimelineOverview } from "@/components/timeline-overview";
import { UploadZone } from "@/components/upload-zone";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { TooltipProvider } from "@/components/ui/tooltip";
import { impactBadge, reviewInsights, type Fact, type PriorityIcon } from "@/lib/replay-insights";
import { sampleAnalysis } from "@/lib/sample-data";
import type { AiReviewEnvelope, BuildReview, DeepMetrics, Player, RecordedTimeline, ReplayAnalysis } from "@/lib/types";
import { formatDuration, formatNumber } from "@/lib/utils";

/** Card colours by role, not by champion. */
const roleStyles: Record<string, { gradient: string; glow: string; label: string }> = {
  TOP: { gradient: "from-orange-300 to-rose-400", glow: "shadow-rose-500/15", label: "Top" },
  JUNGLE: { gradient: "from-emerald-300 to-teal-500", glow: "shadow-emerald-500/15", label: "Jungle" },
  MIDDLE: { gradient: "from-violet-400 to-cyan-300", glow: "shadow-violet-500/20", label: "Mid" },
  BOTTOM: { gradient: "from-sky-300 to-indigo-400", glow: "shadow-sky-500/15", label: "Bot" },
  UTILITY: { gradient: "from-amber-200 to-fuchsia-400", glow: "shadow-fuchsia-500/15", label: "Support" },
};
const fallbackStyle = { gradient: "from-slate-300 to-slate-500", glow: "shadow-slate-500/10", label: "Role unknown" };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat-block">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function ChampionCard({ player, duration, build, version, isYou }: { player: Player; duration: number; build: BuildReview | null; version: string; isYou: boolean }) {
  const style = roleStyles[player.position] ?? fallbackStyle;
  const badge = impactBadge(player);
  const [portrait, setPortrait] = useState(true);
  return (
    <Card className={`champion-card shadow-2xl ${style.glow}`}>
      <CardHeader className="champion-header">
        <div className="flex items-center gap-3.5">
          <div className={`champion-mark relative overflow-hidden bg-gradient-to-br ${style.gradient}`}>
            {player.champion.slice(0, 1)}
            {portrait && (
              <img alt="" className="absolute inset-0 h-full w-full object-cover" src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${player.champion}.png`} onError={() => setPortrait(false)} />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-lg">{player.champion}</CardTitle>
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </div>
            <CardDescription>{player.name}{isYou ? " (you)" : ""} · {style.label} · Level {player.level || "?"}</CardDescription>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold tracking-tight text-white">{player.kills} / <span className="text-rose-300">{player.deaths}</span> / {player.assists}</p>
          <p className="mt-1 text-xs text-slate-500">{Math.round(player.killParticipation * 100)}% kill participation</p>
        </div>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Champion damage" value={formatNumber(player.damage)} detail={`${(player.damageShare * 100).toFixed(1)}% team share`} />
          <Stat label="Farm / gold" value={`${(player.cs / (duration / 60000)).toFixed(1)}/m`} detail={`${player.cs} CS · ${formatNumber(player.gold)}g`} />
          <Stat label="Vision" value={String(player.vision)} detail={`${player.wardsPlaced} wards placed`} />
          <Stat label="Longest life" value={clock(player.longestLife)} detail={`${formatNumber(player.buildingDamage)} structure dmg`} />
        </div>
        <div className="my-5 h-px bg-white/6" />
        <ItemBuild player={player} build={build} version={version} />
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Runes</span>
            <span className="text-xs text-slate-500">{player.runes.length} selected</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {player.runes.map((rune) => <span key={rune} className="rune-pill">{rune}</span>)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Packet-decoded spell sequences: the replay decoder only emits these for specific champions (its metrics are keyed by
 * champion name). Shown only for decoded champions that were actually reviewed in this replay.
 */
const DEEP_RINGS: Record<string, (metrics: DeepMetrics) => Array<{ value: number; label: string; detail: string; color: string }>> = {
  Viktor: ({ Viktor: m }) => (m ? [{ value: (m.qEmpoweredChampionHits / Math.max(m.observedQ, 1)) * 100, label: "Viktor Q → empowered auto", detail: `${m.qEmpoweredChampionHits} confirmed / ${m.observedQ} visible Q casts`, color: "#a78bfa" }] : []),
  Lux: ({ Lux: m }) => (m ? [{ value: (m.rCastsWithChampionContact / Math.max(m.observedRDistinct, 1)) * 100, label: "Lux R connection", detail: `${m.rCastsWithChampionContact} of ${m.observedRDistinct} visible ults hit`, color: "#f5d56e" }] : []),
};

function deepChampions(analysis: ReplayAnalysis) {
  const metrics = analysis.deepMetrics;
  if (!metrics) return [];
  return Object.keys(DEEP_RINGS).filter((champion) => metrics[champion as keyof DeepMetrics] && analysis.players.some((player) => player.champion === champion));
}

function SpellPanel({ analysis, champions }: { analysis: ReplayAnalysis; champions: string[] }) {
  const metrics = analysis.deepMetrics!;
  const rings = champions.flatMap((champion) => DEEP_RINGS[champion](metrics));
  const duo = champions.length > 1 ? metrics.Duo : undefined;
  const [first, second] = champions;
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <div className="flex items-center gap-2"><Radio size={15} className="text-cyan-300" /><span className="eyebrow">Packet-confirmed</span></div>
          <CardTitle className="mt-2 text-lg">Spell conversion</CardTitle>
          <CardDescription>Decoded cast and damage events, not guesses from the scoreboard.</CardDescription>
        </div>
        <Badge tone="info">High-confidence events</Badge>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-3">
        {rings.map((ring) => <MetricRing key={ring.label} {...ring} />)}
        {duo && <MetricRing value={(duo.viktorDamageFollowups / Math.max(duo.decodedLuxQContacts, 1)) * 100} label="Root follow-up" detail={`${duo.viktorDamageFollowups} of ${duo.decodedLuxQContacts} Q contacts followed`} color="#67e8f9" />}
      </CardContent>
      {duo && (
        <div className="sequence-strip">
          <div><span className="sequence-node node-a">Q</span><p>{second} contact</p><strong>{duo.decodedLuxQContacts}</strong></div>
          <ArrowRight size={18} />
          <div><span className="sequence-node node-b">E</span><p>{first} spell follow-up</p><strong>{duo.viktorSpellFollowups}</strong></div>
          <ArrowRight size={18} />
          <div><span className="sequence-node node-impact">✦</span><p>Same-target damage</p><strong>{duo.viktorDamageFollowups}</strong></div>
        </div>
      )}
    </Card>
  );
}

function RecordedCard({ recorded }: { recorded: RecordedTimeline }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <div className="flex items-center gap-2"><Radio size={15} className="text-cyan-300" /><span className="eyebrow">Recorded live by Rift Lens</span></div>
          <CardTitle className="mt-2 text-lg">Your purchases and deaths</CardTitle>
          <CardDescription>
            {recorded.csAt10 != null ? `${recorded.csAt10} CS at 10:00${recorded.csAt10Average != null ? ` (your average on this champion: ${recorded.csAt10Average})` : ""}. ` : ""}
            {recorded.partial ? "The recording has gaps, so a few events may be missing." : "Matched to this replay by game id and start time."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="recorded-grid">
        <div>
          <span className="eyebrow flex items-center gap-1.5"><ShoppingBag size={12} /> Finished items, in order</span>
          <ul className="recorded-list mt-3">
            {recorded.completed.length ? recorded.completed.map((entry) => (
              <li key={`${entry.itemId}-${entry.time}`}><time>{clock(entry.time)}</time><span>{entry.item}</span></li>
            )) : <li><time>–</time><span>No finished items recorded.</span></li>}
          </ul>
        </div>
        <div>
          <span className="eyebrow flex items-center gap-1.5"><Skull size={12} /> Deaths</span>
          <ul className="recorded-list mt-3">
            {recorded.deaths.length ? recorded.deaths.map((death) => (
              <li key={death.time}>
                <time>{clock(death.time)}</time>
                <span>
                  {death.killerChampion || death.killer}{death.assisters.length ? ` + ${death.assisters.join(" + ")}` : ""}
                  <small className={death.goldUnspent >= 1000 ? "text-rose-300" : undefined}>holding {death.goldUnspent.toLocaleString("en-US")}g · level {death.level}</small>
                </span>
              </li>
            )) : <li><time>–</time><span>No deaths. Nice.</span></li>}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

const PRIORITY_TONES = ["cyan", "violet", "amber"] as const;
const PRIORITY_ICONS: Record<PriorityIcon, React.ReactNode> = {
  target: <Target size={18} />, crosshair: <Crosshair size={18} />, shield: <ShieldAlert size={18} />, eye: <Eye size={18} />, coins: <Coins size={18} />, swords: <Swords size={18} />,
};

function PriorityCard({ number, title, description, tone, icon }: { number: string; title: string; description: string; tone: (typeof PRIORITY_TONES)[number]; icon: React.ReactNode }) {
  return (
    <div className={`priority-card priority-${tone}`}>
      <div className="priority-top"><span>{number}</span>{icon}</div>
      <h4>{title}</h4>
      <p>{description}</p>
    </div>
  );
}

function FactCard({ fact }: { fact: Fact }) {
  return (
    <div className={`fact-card fact-${fact.tone}`}>
      <span>{fact.label}</span>
      <strong>{fact.value}</strong>
      <small>{fact.detail}</small>
    </div>
  );
}

export default function Dashboard() {
  const [analysis, setAnalysis] = useState<ReplayAnalysis>(sampleAnalysis);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiState, setAiState] = useState<AiCoachState>("locked");
  const [aiResult, setAiResult] = useState<AiReviewEnvelope | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const insights = useMemo(() => reviewInsights(analysis), [analysis]);
  const review = analysis.review;
  const isSample = analysis === sampleAnalysis;
  const version = review?.dataPatch || `${analysis.replay.clientVersion.split(".").slice(0, 2).join(".")}.1`;
  const mode = analysis.replay.mode ?? { label: "Unknown mode", class: "unknown", queueId: null, verified: false };
  const isSwiftplay = mode.class === "swiftplay";
  const isModeUnknown = mode.class === "unknown";
  const deep = deepChampions(analysis);

  const enemyDamage = analysis.enemyLane.reduce((sum, player) => sum + player.damage, 0);
  const enemyCs = analysis.enemyLane.reduce((sum, player) => sum + player.cs, 0);
  const enemyStructures = analysis.enemyLane.reduce((sum, player) => sum + player.buildingDamage, 0);
  const enemyGold = analysis.enemyLane.reduce((sum, player) => sum + (player.gold ?? 0), 0);
  const yourDamage = analysis.players.reduce((sum, player) => sum + player.damage, 0);
  const yourCs = analysis.players.reduce((sum, player) => sum + player.cs, 0);
  const yourStructures = analysis.players.reduce((sum, player) => sum + player.buildingDamage, 0);
  const yourGold = analysis.players.reduce((sum, player) => sum + player.gold, 0);
  const sideLabel = analysis.players.length > 1 ? analysis.players.map((player) => player.champion).join(" + ") : "You";
  const laneRows = [
    { label: "Champion damage", yours: yourDamage, theirs: enemyDamage },
    { label: isSwiftplay ? "Last-hit CS" : "CS", yours: yourCs, theirs: enemyCs },
    { label: "Gold", yours: yourGold, theirs: enemyGold },
    { label: "Building damage", yours: yourStructures, theirs: enemyStructures },
  ];
  // The row where the two sides separated most (relative to the bigger side).
  const widest = [...laneRows].sort((a, b) => Math.abs(b.yours - b.theirs) / Math.max(b.yours, b.theirs, 1) - Math.abs(a.yours - a.theirs) / Math.max(a.yours, a.theirs, 1))[0];
  const laneWon = insights.goldDiff >= 0;
  const confidence = review?.recorded ? "High" : review ? "Medium" : "Limited";

  const comparison = useMemo(() => [
    { metric: "Damage", You: Math.round(yourDamage / 1000), Enemy: Math.round(enemyDamage / 1000) },
    { metric: "Farm", You: yourCs, Enemy: enemyCs },
    { metric: "Gold", You: Math.round(yourGold / 1000), Enemy: Math.round(enemyGold / 1000) },
    { metric: "Structures", You: Math.round(yourStructures / 100), Enemy: Math.round(enemyStructures / 100) },
  ], [yourDamage, enemyDamage, yourCs, enemyCs, yourGold, enemyGold, yourStructures, enemyStructures]);

  const lookupCachedAiReview = async (nextAnalysis: ReplayAnalysis) => {
    setAiState("checking");
    setAiError(null);
    try {
      const response = await fetch("/api/ai-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "lookup", analysis: nextAnalysis }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The local AI cache could not be checked.");
      if (payload.status === "ready") {
        setAiResult(payload as AiReviewEnvelope);
        setAiState("ready");
      } else {
        setAiResult(null);
        setAiState("idle");
      }
    } catch (reason) {
      setAiState("error");
      setAiError(reason instanceof Error ? reason.message : "The local AI cache could not be checked.");
    }
  };

  // Development only: /?analysis=<replay name> reopens an analysis saved by /api/analyze (lib/dev-analysis.ts).
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const name = new URLSearchParams(window.location.search).get("analysis");
    if (!name) return;
    let cancelled = false;
    void fetch(`/api/dev-analysis?name=${encodeURIComponent(name)}`).then(async (response) => {
      const payload = await response.json();
      if (cancelled) return;
      if (!response.ok) { setError(payload.error ?? "Saved analysis not found."); return; }
      setAnalysis(payload as ReplayAnalysis);
      setAiResult(null);
      void lookupCachedAiReview(payload as ReplayAnalysis);
    }).catch(() => { if (!cancelled) setError("Saved analysis could not be loaded."); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateAiReview = async (regenerate = false) => {
    setAiState("generating");
    setAiError(null);
    try {
      const response = await fetch("/api/ai-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", regenerate, analysis }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const detail = payload.details ? ` ${payload.details}` : "";
        throw new Error(`${payload.error ?? "The AI review failed."}${detail}`);
      }
      setAiResult(payload as AiReviewEnvelope);
      setAiState("ready");
    } catch (reason) {
      setAiState("error");
      setAiError(reason instanceof Error ? reason.message : "The AI review failed.");
    }
  };

  const regenerateAiReview = () => {
    if (!window.confirm("Generate a fresh review? This ignores the saved response and uses Codex credits again.")) return;
    void generateAiReview(true);
  };

  const analyzeReplay = async (file: File, deep: boolean) => {
    setLoading(true);
    setError(null);
    const form = new FormData();
    form.append("replay", file);
    form.append("deep", String(deep));
    try {
      const response = await fetch("/api/analyze", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Replay analysis failed.");
      const nextAnalysis = payload as ReplayAnalysis;
      setAnalysis(nextAnalysis);
      setAiResult(null);
      void lookupCachedAiReview(nextAnalysis);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Replay analysis failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <TooltipProvider>
      <main>
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />
        <header className="site-header">
          <div className="brand-mark"><BrainCircuit size={19} /></div>
          <div>
            <div className="brand-name">RIFT<span>//</span>LENS</div>
            <p>Replay intelligence</p>
          </div>
          <nav>
            <a href="/live">Live game</a>
            <a href="/profile">Memory</a>
            <a href="#overview">Overview</a>
            <a href="#ai-coach">AI coach</a>
            <a href="#builds">Builds</a>
            {deep.length > 0 && <a href="#spells">Spell data</a>}
            <a href="#timeline">Timeline</a>
            <a href="#plan">Game plan</a>
          </nav>
          <div className="header-status"><span /> Local parser online</div>
        </header>

        <div className="page-shell">
          <section className="intro">
            <Badge tone="info"><Sparkles size={12} /> AI coaching workspace</Badge>
            <h1>Turn a replay into a<br /><span>clearer next game.</span></h1>
            <p>Upload the raw match. Get a build check against the top build and the enemy team, your deaths and purchases from Rift Lens&apos;s live recording, and the three fixes that matter most.</p>
          </section>

          <UploadZone loading={loading} onAnalyze={analyzeReplay} />
          {loading && (
            <div className="analysis-progress">
              <div className="flex items-center justify-between text-xs"><span>Decoding replay events…</span><span>Deep reviews can take 1–2 minutes</span></div>
              <Progress value={68} className="mt-3" />
            </div>
          )}
          {error && <div className="error-banner"><TriangleAlert size={16} />{error}</div>}
          {isSample && <div className="sample-banner"><Sparkles size={14} /> This is a sample review. Upload one of your .rofl files to review your own game.</div>}

          <section id="overview" className="match-bar">
            <div>
              <span className={`result-orb result-${analysis.replay.outcome}`} />
              <div><strong>{analysis.replay.outcome.toUpperCase()}</strong><p>{analysis.replay.name}</p></div>
            </div>
            <div className="match-meta">
              <span><Timer size={14} /> {formatDuration(analysis.replay.durationMs)}</span>
              <span><Swords size={14} /> {analysis.replay.teamKills} team kills</span>
              <span><Gauge size={14} /> {mode.label}{mode.queueId ? ` · Q${mode.queueId}` : ""}</span>
              <span><Activity size={14} /> Patch {analysis.replay.clientVersion.split(".").slice(0, 2).join(".")}</span>
            </div>
            <Badge tone={mode.verified ? "good" : "neutral"}><CheckCircle2 size={12} /> {mode.verified ? "Mode verified" : "Replay verified"}</Badge>
          </section>

          <section className={`mode-awareness mode-${mode.class}`}>
            <div><Gauge size={17} /><span><small>Analysis model</small><strong>{mode.label}</strong></span></div>
            <p>{isSwiftplay ? "Accelerated level and gold pacing · nearby-minion income · lane-relative benchmarks" : isModeUnknown ? "Mode-specific economy verdicts paused until League Client match history is available" : "Standard queue-specific pacing and role benchmarks"}</p>
            <Badge tone={mode.verified ? "info" : "warn"}>{mode.verified ? "Minute snapshots enabled" : "Replay-only fallback"}</Badge>
          </section>

          <section className="overview-hero">
            <div className="ai-orb"><BrainCircuit size={28} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><span className="eyebrow">What decided this game</span>{isSwiftplay && <Badge tone="info">Swiftplay-adjusted</Badge>}</div>
              <h2>{insights.headline}</h2>
              <p>{insights.summary}</p>
              <div className="fact-grid">
                {insights.facts.map((fact) => <FactCard key={fact.id} fact={fact} />)}
              </div>
            </div>
            <div className="confidence"><Gauge size={16} /><span><strong>{confidence}</strong> confidence</span></div>
          </section>

          <AiCoachPanel
            state={aiState}
            result={aiResult}
            error={aiError}
            onGenerate={() => void generateAiReview(false)}
            onRegenerate={regenerateAiReview}
          />

          <div id="builds" className="section-heading">
            <div><span className="eyebrow">{analysis.players.length > 1 ? "Your bot lane" : "Your game"}</span><h2>Performance & build check</h2></div>
            <p>Your final items against the top build for your champion and role, and against what the enemy team built.</p>
          </div>

          <section className="grid gap-5 xl:grid-cols-2">
            {analysis.players.map((player) => (
              <ChampionCard
                key={player.participantId}
                player={player}
                duration={analysis.replay.durationMs}
                build={review?.builds.find((entry) => entry.participantId === player.participantId) ?? null}
                version={version}
                isYou={player === insights.you && Boolean(review)}
              />
            ))}
            {review?.recorded && <RecordedCard recorded={review.recorded} />}
          </section>

          {analysis.enemyLane.length > 0 && (
            <section className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
              <Card>
                <CardHeader>
                  <div><CardTitle className="text-lg">{sideLabel} vs {insights.laneLabel}</CardTitle><CardDescription>End-of-game totals against your lane opponent{analysis.enemyLane.length > 1 ? "s" : ""}.</CardDescription></div>
                  <Badge tone={laneWon ? "good" : "bad"}>{laneWon ? "Lane won on gold" : "Lane lost on gold"}</Badge>
                </CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={comparison} barGap={8}>
                      <CartesianGrid stroke="rgba(255,255,255,.055)" vertical={false} />
                      <XAxis dataKey="metric" axisLine={false} tickLine={false} tick={{ fill: "#7f8ba3", fontSize: 11 }} />
                      <YAxis hide />
                      <ChartTooltip contentStyle={{ background: "#111827", border: "1px solid #263146", borderRadius: 12, fontSize: 12 }} cursor={{ fill: "rgba(255,255,255,.025)" }} />
                      <Bar dataKey="You" fill="#67e8f9" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="Enemy" fill="#f472b6" radius={[5, 5, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><div><CardTitle className="text-lg">Where the lane separated</CardTitle><CardDescription>The biggest gap was {widest.label.toLowerCase()}.</CardDescription></div><GitCompareArrows size={18} className="text-slate-500" /></CardHeader>
                <CardContent className="space-y-5">
                  {laneRows.map((row) => (
                    <div key={row.label}>
                      <div className="mb-2 flex items-end justify-between"><span className="text-sm text-slate-300">{row.label}</span><span className="text-xs text-slate-500">{formatNumber(row.yours)} vs <strong className="text-pink-300">{formatNumber(row.theirs)}</strong></span></div>
                      <Progress value={(row.yours / Math.max(row.yours, row.theirs, 1)) * 100} />
                    </div>
                  ))}
                  <div className="insight-callout"><Crosshair size={18} /><p><strong>{isSwiftplay ? "Swiftplay read:" : "Read:"}</strong> {sideLabel === "You" ? "you" : "your duo"} finished {Math.abs(insights.goldDiff).toLocaleString("en-US")} gold {laneWon ? "ahead of" : "behind"} {insights.laneLabel}{insights.levelDiff ? ` and ${Math.abs(insights.levelDiff)} level${Math.abs(insights.levelDiff) === 1 ? "" : "s"} ${insights.levelDiff > 0 ? "ahead" : "behind"}` : ""}.{isSwiftplay ? " CS is context here: nearby-minion gold softens missed last-hits." : ""}</p></div>
                </CardContent>
              </Card>
            </section>
          )}

          {deep.length > 0 && (
            <>
              <div id="spells" className="section-heading"><div><span className="eyebrow">Mechanics</span><h2>What the replay actually saw</h2></div><p>Confirmed packets are separated from inference and scoreboard-only context.</p></div>
              <SpellPanel analysis={analysis} champions={deep} />
            </>
          )}

          <div id="timeline" className="section-heading"><div><span className="eyebrow">Review timeline</span><h2>Where the game went right—or slipped</h2></div><p>Every marker opens what happened, why it mattered, and a better play. &quot;League&quot; jumps the open replay to that moment.</p></div>
          <TimelineOverview events={analysis.timeline ?? []} durationMs={analysis.replay.durationMs} />

          <div id="plan" className="section-heading"><div><span className="eyebrow">Next game</span><h2>Your priority stack</h2></div><p>Fix these in order. Do not try to change everything at once.</p></div>
          <section className="priority-grid">
            {insights.priorities.map((priority, index) => (
              <PriorityCard key={priority.id} number={String(index + 1).padStart(2, "0")} tone={PRIORITY_TONES[index % PRIORITY_TONES.length]} icon={PRIORITY_ICONS[priority.icon]} title={priority.title} description={priority.description} />
            ))}
          </section>
          {review && review.caveats.length > 0 && (
            <details className="ai-evidence-limits mt-5">
              <summary>What this review could not see</summary>
              <ul className="caveat-list">{review.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
            </details>
          )}

          <footer>
            <div className="flex items-center gap-2"><div className="brand-mark small"><BrainCircuit size={14} /></div><strong>RIFT//LENS</strong></div>
            <p>Local-first replay analysis · Optional ChatGPT-powered coaching · Uploaded copies are removed after processing</p>
            <Badge tone="neutral">Experimental decoder</Badge>
          </footer>
        </div>
      </main>
    </TooltipProvider>
  );
}
