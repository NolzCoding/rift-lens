"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, TriangleAlert } from "lucide-react";

import { AlertLog, AlertToasts, type AlertEntry } from "@/components/live/alerts";
import { BuildPanel } from "@/components/live/build-panel";
import { BuyCard } from "@/components/live/buy-card";
import { AskBox, CoachCard, type AskProps } from "@/components/live/coach-card";
import { CommandBar, VitalsAndStats } from "@/components/live/command-bar";
import { DeathView, LastDeathNote } from "@/components/live/death-coach";
import { DetailsDrawer, useDetailsOpen } from "@/components/live/details-drawer";
import { ChampSelectPanel } from "@/components/live/champ-select-panel";
import { EmptyState } from "@/components/live/empty-state";
import { EventsPanel, EvidencePanel } from "@/components/live/feed-panels";
import { GameOverView } from "@/components/live/game-over";
import { GamePlanCard } from "@/components/live/game-plan-card";
import { AiRead, HelpCard } from "@/components/live/help-coach";
import { MatchupPanel } from "@/components/live/matchup-panel";
import { MemoryCard, type FocusCheckpoint } from "@/components/live/memory-card";
import { NowRow } from "@/components/live/now-row";
import { PlanCard } from "@/components/live/plan-view";
import { SettingsMenu } from "@/components/live/settings-menu";
import type { Connection } from "@/components/live/shared";
import { ThreatGrid } from "@/components/live/threat-grid";
import { LiveTopBar } from "@/components/live/top-bar";
import { useAiRead } from "@/components/live/use-ai-read";
import { useItemCatalog } from "@/components/live/use-item-catalog";
import { useLiveHelp, type HelpSlot } from "@/components/live/use-live-help";
import { useLiveSettings, useVoice } from "@/components/live/use-live-settings";
import { deriveAlerts } from "@/lib/live-alerts";
import { coachVerdicts, trackCoach, type CoachTrack, type RecentAlert } from "@/lib/live-coach";
import { getLiveFixture, getLiveFixtureHelp, getLiveFixturePrev, type LiveFixtureName } from "@/lib/live-fixtures";
import type { LiveDeathMoment, LiveGameResponse, LiveGameSnapshot, LiveHelpEnvelope } from "@/lib/types";

const POLL_MS = 2500;
const PLAN_WINDOW_SECONDS = 90;
const LAST_DEATH_NOTE_SECONDS = 300;

export function LiveGameDashboard({ mock = null }: { mock?: LiveFixtureName | null }) {
  const [snapshot, setSnapshot] = useState<LiveGameSnapshot | null>(null);
  const [prevSnapshot, setPrevSnapshot] = useState<LiveGameSnapshot | null>(null);
  const [coachTrack, setCoachTrack] = useState<CoachTrack | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [reason, setReason] = useState("");
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [question, setQuestion] = useState("");
  const [toasts, setToasts] = useState<AlertEntry[]>([]);
  const [alertLog, setAlertLog] = useState<AlertEntry[]>([]);
  const [deaths, setDeaths] = useState<LiveDeathMoment[]>([]);
  const [dismissedDeath, setDismissedDeath] = useState<number | null>(null);
  const [checkpoint, setCheckpoint] = useState<FocusCheckpoint>(null);
  /** Canned AI answer for /live?mock=…&ai=1|stale — never calls a model. */
  const [mockHelp, setMockHelp] = useState<LiveHelpEnvelope | null>(null);
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();

  const { settings, update: updateSettings, ready: settingsReady } = useLiveSettings();
  const speak = useVoice(settings.voice);
  const manual = useLiveHelp();
  const deathHelp = useLiveHelp();
  const plan = useLiveHelp();
  const catalog = useItemCatalog(snapshot?.dataDragonVersion);

  const mounted = useRef(true);
  const prevRef = useRef<LiveGameSnapshot | null>(null);
  const trackRef = useRef<CoachTrack | null>(null);
  const gameRef = useRef<string | null>(null);
  const firedRef = useRef(new Set<string>());
  const autoRequested = useRef(new Set<string>());
  const catalogRef = useRef(catalog);
  const speakRef = useRef(speak);
  useEffect(() => { catalogRef.current = catalog; }, [catalog]);
  useEffect(() => { speakRef.current = speak; }, [speak]);

  const { reset: resetManual } = manual;
  const { reset: resetDeath, run: runDeath } = deathHelp;
  const { reset: resetPlan, run: runPlan } = plan;

  /** Apply one snapshot: per-game resets, alert diffing (deduped by id), death log, coach memory and the 10:00 checkpoint. */
  const ingest = useCallback((next: LiveGameSnapshot) => {
    if (gameRef.current !== next.gameId) {
      gameRef.current = next.gameId;
      prevRef.current = null;
      trackRef.current = null;
      firedRef.current = new Set();
      setToasts([]); setAlertLog([]); setDeaths([]); setCheckpoint(null); setDismissedDeath(null);
      resetManual(); resetDeath(); resetPlan();
    }
    const prev = prevRef.current;
    const fresh = deriveAlerts(prev, next, { itemCost: (id) => catalogRef.current?.costById.get(id) })
      .filter((alert) => !firedRef.current.has(alert.id))
      .sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1));
    if (fresh.length) {
      const now = Date.now();
      const entries = fresh.map((alert) => { firedRef.current.add(alert.id); return { alert, gameTime: next.game.time, at: now }; });
      // Only high-priority alerts interrupt as toasts; everything lands in the log (Details).
      const urgent = entries.filter((entry) => entry.alert.priority === "high");
      if (urgent.length) setToasts((current) => [...current, ...urgent].slice(-2));
      setAlertLog((current) => [...current, ...entries].slice(-30));
      fresh.slice(0, 2).forEach((alert) => speakRef.current(alert.speech, { priority: alert.priority }));
    }
    const moment = next.deathMoment;
    if (moment) setDeaths((list) => list.some((entry) => entry.diedAt === moment.diedAt) ? list : [...list, moment]);
    if (next.game.time >= 600 && (prev ? prev.game.time < 600 : next.game.time < 615)) {
      setCheckpoint({ cs: next.activePlayer.cs, deaths: next.activePlayer.deaths });
    }
    trackRef.current = trackCoach(trackRef.current ?? (prev ? trackCoach(null, prev) : null), next);
    setCoachTrack(trackRef.current);
    setPrevSnapshot(prev);
    prevRef.current = next;
    setSnapshot(next);
    setReceivedAt(Date.now());
  }, [resetManual, resetDeath, resetPlan]);

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/live-game", { cache: "no-store" });
      const data = await response.json() as LiveGameResponse;
      if (!mounted.current) return;
      setLastCheck(new Date());
      if (data.status === "live") {
        ingest(data);
        setConnection("live");
        setReason("");
      } else {
        setSnapshot(null);
        setConnection("offline");
        setReason(data.reason);
      }
    } catch (error) {
      if (!mounted.current) return;
      setConnection("error");
      setReason(error instanceof Error ? error.message : "Rift Lens could not reach its local route.");
    }
  }, [ingest]);

  useEffect(() => {
    mounted.current = true;
    if (mock) {
      // Fixture mode: no polling and no automatic AI calls.
      const fixture = getLiveFixture(mock);
      gameRef.current = fixture.gameId;
      prevRef.current = getLiveFixturePrev(mock);
      trackRef.current = null;
      ingest(fixture);
      const ai = new URLSearchParams(window.location.search).get("ai");
      setMockHelp(ai === "1" || ai === "stale" ? getLiveFixtureHelp(mock, ai === "stale") : null);
      setConnection("live");
      setLastCheck(new Date());
      return () => { mounted.current = false; };
    }
    void poll();
    const interval = window.setInterval(() => { void poll(); }, POLL_MS);
    return () => { mounted.current = false; window.clearInterval(interval); };
  }, [mock, poll, ingest]);

  const power = settings.power;

  const requestDeathRead = useCallback((snap: LiveGameSnapshot) => {
    const moment = snap.deathMoment;
    if (!moment) return;
    const key = `${snap.gameId}:${moment.diedAt}`;
    autoRequested.current.add(key);
    void runDeath(snap, "death", { key, power }).then((envelope) => {
      // Only speak if still dead from this same death.
      if (envelope && prevRef.current?.deathMoment?.diedAt === moment.diedAt) speakRef.current(envelope.review.urgentSummary, { urgent: true });
    });
  }, [runDeath, power]);

  const requestPlan = useCallback((snap: LiveGameSnapshot) => {
    const key = `plan:${snap.gameId}`;
    autoRequested.current.add(key);
    void runPlan(snap, "pregame", { key, power });
  }, [runPlan, power]);

  // Auto death coach: once per gameId + diedAt.
  useEffect(() => {
    if (mock || !settingsReady || !settings.autoDeathCoach || !snapshot?.deathMoment) return;
    if (autoRequested.current.has(`${snapshot.gameId}:${snapshot.deathMoment.diedAt}`)) return;
    requestDeathRead(snapshot);
  }, [mock, settingsReady, settings.autoDeathCoach, snapshot, requestDeathRead]);

  // Auto game plan: once per gameId, only in the first 90 seconds.
  useEffect(() => {
    if (mock || !settingsReady || !settings.autoGamePlan || !snapshot || snapshot.game.time >= PLAN_WINDOW_SECONDS) return;
    if (autoRequested.current.has(`plan:${snapshot.gameId}`)) return;
    requestPlan(snapshot);
  }, [mock, settingsReady, settings.autoGamePlan, snapshot, requestPlan]);

  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((entry) => entry.alert.id !== id)), []);

  const openBuildEditor = useCallback(() => {
    setDetailsOpen(true);
    window.setTimeout(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      document.getElementById("live-build-panel")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }, 60);
  }, [setDetailsOpen]);

  // The newest AI read of this game, whichever button or trigger produced it, drives the buy card + coach lines.
  const buildHelp = !snapshot ? null : mockHelp ?? [manual.slot, deathHelp.slot, plan.slot]
    .filter((slot) => slot.envelope && slot.key?.includes(snapshot.gameId))
    .sort((left, right) => (right.receivedAt ?? Date.parse(right.envelope!.generatedAt)) - (left.receivedAt ?? Date.parse(left.envelope!.generatedAt)))[0]?.envelope ?? null;
  const { read: aiRead, live: aiLive } = useAiRead(buildHelp, snapshot);

  if (!snapshot) return <EmptyState connection={connection} reason={reason} onRetry={() => void poll()} settings={<SettingsMenu settings={settings} onChange={updateSettings} />} champSelect={<ChampSelectPanel />} />;

  const moment = snapshot.deathMoment;
  const deathKey = moment ? `${snapshot.gameId}:${moment.diedAt}` : null;
  const lastDeath = !moment && deaths.length ? deaths[deaths.length - 1] : null;
  const showLastDeath = lastDeath && dismissedDeath !== lastDeath.diedAt && snapshot.game.time - lastDeath.diedAt < LAST_DEATH_NOTE_SECONDS;
  const lastDeathHelp = lastDeath && deathHelp.slot.key === `${snapshot.gameId}:${lastDeath.diedAt}` ? deathHelp.slot.envelope : null;
  const mockNote = mock ? "Mock mode — AI is never called automatically." : null;
  const mockSlot = (mode: LiveHelpEnvelope["mode"], key: string | null): HelpSlot | null => mockHelp && mockHelp.mode === mode
    ? { key, mode, envelope: mockHelp, loading: false, startedAt: null, receivedAt: null, error: null } : null;
  const deathSlot = mockSlot("death", deathKey) ?? (deathHelp.slot.key === deathKey ? deathHelp.slot : null);
  const planSlot = mockSlot("pregame", `plan:${snapshot.gameId}`) ?? plan.slot;
  const manualSlot = mockSlot("fast", snapshot.gameId) ?? mockSlot("deep", snapshot.gameId) ?? manual.slot;
  const manualHelp = manualSlot.envelope;
  const showPlanCard = Boolean(planSlot.loading || planSlot.envelope || planSlot.error || snapshot.game.time < PLAN_WINDOW_SECONDS);
  const askManual = (mode: "fast" | "deep", userFocus = question.trim()) => {
    if (!manual.slot.loading) void manual.run(snapshot, mode, { key: snapshot.gameId, userFocus, power });
  };
  const ask: AskProps = { slot: manualSlot, question, onQuestion: setQuestion, onAsk: () => askManual("fast") };

  const view = snapshot.gameResult ? "over" : moment ? "dead" : snapshot.game.time < PLAN_WINDOW_SECONDS ? "plan" : "alive";
  const verdicts = coachVerdicts(prevSnapshot, snapshot, coachTrack);
  const review = aiRead?.textLive ? aiRead.help.review : null;
  const aiSummary = review && aiRead?.help.mode !== "death" ? review.urgentSummary : null;
  const coachSays = review ? review.nextFiveMinutes[0] || review.fightPlan[0] || null : null;
  const recentAlerts: RecentAlert[] = alertLog.map(({ alert, gameTime }) => ({ kind: alert.kind, priority: alert.priority, text: alert.text, call: alert.call, gameTime }));

  return (
    <div className={`live-dashboard live-view-${view}`}>
      <LiveTopBar snapshot={snapshot} receivedAt={receivedAt} connection={connection} mock={mock} right={<SettingsMenu settings={settings} onChange={updateSettings} />} />

      <div className="live-main">
        {view === "dead" && moment ? (
          <DeathView
            snapshot={snapshot}
            moment={moment}
            receivedAt={receivedAt}
            help={deathSlot}
            ai={aiLive}
            autoNote={mockNote || (settings.autoDeathCoach ? null : "Auto coach on death is off.")}
            onRequest={() => requestDeathRead(snapshot)}
            ask={<AskBox {...ask} />}
          />
        ) : view === "over" ? (
          <GameOverView snapshot={snapshot} verdicts={verdicts} />
        ) : (
          <>
            <NowRow snapshot={snapshot} receivedAt={receivedAt} mock={Boolean(mock)} alerts={recentAlerts} aiSummary={aiSummary} />
            <section className="live-cards">
              <BuyCard snapshot={snapshot} ai={aiLive} onEditBuild={openBuildEditor} />
              {view === "plan"
                ? <PlanCard snapshot={snapshot} slot={planSlot} autoNote={mockNote || (settings.autoGamePlan ? null : "Auto game plan is off.")} onRequest={() => requestPlan(snapshot)} />
                : <CoachCard verdicts={verdicts} aiLine={coachSays} ask={ask} />}
            </section>
            {view === "plan" && <section className="live-ask-row"><AskBox {...ask} /></section>}
          </>
        )}
      </div>

      <DetailsDrawer open={detailsOpen} onToggle={() => setDetailsOpen((value) => !value)}>
        <section className="details-ask-grid">
          <HelpCard snapshot={snapshot} slot={manual.slot} question={question} onQuestion={setQuestion} onAsk={(mode) => askManual(mode)} />
          <MatchupPanel snapshot={snapshot} />
        </section>
        {manual.slot.error && <div className="live-error"><TriangleAlert size={15} />{manual.slot.error}</div>}
        {manualHelp && <AiRead help={manualHelp} />}

        <BuildPanel snapshot={snapshot} ai={aiRead} catalog={catalog} mock={Boolean(mock)} asking={manual.slot.loading} onAsk={() => askManual("fast", "")} />

        {showLastDeath && lastDeath && <LastDeathNote moment={lastDeath} help={lastDeathHelp} onDismiss={() => setDismissedDeath(lastDeath.diedAt)} />}

        <section className={`live-brief-grid ${showPlanCard ? "has-plan" : ""}`}>
          {showPlanCard && <GamePlanCard slot={planSlot} autoNote={mockNote || (settings.autoGamePlan ? null : "Auto game plan is off.")} onRequest={() => requestPlan(snapshot)} />}
          <MemoryCard snapshot={snapshot} catalog={catalog} checkpoint={checkpoint} deathGolds={deaths.map((death) => death.goldNow)} />
        </section>

        <CommandBar snapshot={snapshot} connection={connection} mock={mock} />
        <VitalsAndStats snapshot={snapshot} />

        <ThreatGrid snapshot={snapshot} />

        <section className="live-bottom-grid">
          <EventsPanel snapshot={snapshot} />
          <AlertLog entries={alertLog} />
          <EvidencePanel snapshot={snapshot} />
        </section>

        <footer className="live-footer">
          <span><Radio size={12} /> {mock ? "Mock fixture — not polling" : `Last local check ${lastCheck?.toLocaleTimeString() || "—"}`}</span>
          <span>Riot Live Client API only · no process memory reading</span>
        </footer>
      </DetailsDrawer>

      <AlertToasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
