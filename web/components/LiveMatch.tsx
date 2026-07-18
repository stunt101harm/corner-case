"use client";

/**
 * LiveMatch.tsx — scoreboard, event ticker and live condition tracker, fed by
 * SSE from the relay. `mode: "live"` consumes the fan-out of TxLINE's real
 * stream; `mode: "replay"` consumes the recorded demo match through the SAME
 * event format — this component cannot tell the difference, which is the
 * point of the demo being honest.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { oddsStreamUrl, replayUrl, streamUrl } from "@/lib/relay";
import {
  extractMatchOdds,
  fmtProb,
  normalizeOdds,
  periodLabel,
  type MatchOdds,
  type NormalizedMarket,
} from "@/lib/odds";
import { CMP, OP, evaluatePredicate, type DecodedPredicate } from "@/lib/strategy";
import { matchMinute } from "@/lib/format";
import type { ScoreRecord } from "@/lib/types";

const FEED_META: Record<string, { icon: string; label: string }> = {
  kickoff: { icon: "▶", label: "Kickoff" },
  goal: { icon: "⚽", label: "GOAL" },
  corner: { icon: "🚩", label: "Corner" },
  yellow_card: { icon: "🟨", label: "Yellow card" },
  red_card: { icon: "🟥", label: "Red card" },
  penalty: { icon: "⚽", label: "Penalty" },
  var: { icon: "🖥", label: "VAR check" },
  substitution: { icon: "🔁", label: "Substitution" },
  halftime_finalised: { icon: "⏸", label: "Half-time" },
  game_finalised: { icon: "🏁", label: "Full time — stats finalised" },
};

/** How a feed row renders: goals get a highlight row, half/full time get
 *  banner rows, everything else is a plain line. */
type FeedKind = "goal" | "halftime" | "fulltime" | "normal";

interface FeedItem {
  seq: number;
  minute: string;
  icon: string;
  label: string;
  score: string;
  kind: FeedKind;
}

function feedKind(action: string): FeedKind {
  if (action === "goal") return "goal";
  if (action === "halftime_finalised") return "halftime";
  if (action === "game_finalised") return "fulltime";
  return "normal";
}

export interface TrackerSpec {
  decoded: DecodedPredicate;
  statKeys: number[];
  description: string;
}

/** One point of 1X2 consensus history — feeds the sparklines. */
interface ConsensusPoint {
  ts: number;
  p1: number;
  draw: number;
  p2: number;
}

/** Rolling cap on consensus history: plenty for a sparkline, bounded forever. */
const CONSENSUS_HISTORY_MAX = 120;

type Phase = "idle" | "connecting" | "playing" | "done";

export function LiveMatch({
  fixtureId,
  home,
  away,
  mode,
  replaySpeed = 30,
  autoStart = false,
  tracker = null,
  onFinalised,
}: {
  fixtureId: number;
  home: string;
  away: string;
  mode: "live" | "replay";
  replaySpeed?: number;
  autoStart?: boolean;
  tracker?: TrackerSpec | null;
  onFinalised?: (seq: number) => void;
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>("idle");
  const [score, setScore] = useState<[number, number]>([0, 0]);
  // Increments on every score change; keying the scoreboard number on it
  // restarts the CSS pop animation for each goal.
  const [scorePulse, setScorePulse] = useState(0);
  const [minute, setMinute] = useState("");
  const [stats, setStats] = useState<Record<string, number> | undefined>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [finalSeq, setFinalSeq] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Live-mode odds are a SECOND EventSource (/api/odds-stream); replay-mode
  // odds ride the replay connection as tagged `odds` events. Either way they
  // are pure decoration: every failure path below ends in "no line", never
  // in a broken ticker.
  const oddsEsRef = useRef<EventSource | null>(null);
  // Rolling per-market book (same identity key as the relay's odds cache) so
  // a half=1 update can never masquerade as the full-match consensus.
  const oddsBookRef = useRef<Map<string, NormalizedMarket>>(new Map());
  const [consensus, setConsensus] = useState<MatchOdds | null>(null);
  const [consensusHistory, setConsensusHistory] = useState<ConsensusPoint[]>([]);
  // Score is also kept in a ref: feed items need the score *at delivery time*
  // and React state updaters are not synchronous.
  const scoreRef = useRef<[number, number]>([0, 0]);
  const onFinalisedRef = useRef(onFinalised);
  onFinalisedRef.current = onFinalised;

  /** Fold one odds SSE payload into the consensus line. Total: bad JSON,
   *  foreign fixtures and non-1X2 markets all fall through silently. */
  const ingestOdds = useCallback(
    (data: string): void => {
      try {
        const entry = JSON.parse(data) as { FixtureId?: unknown };
        if (entry?.FixtureId !== fixtureId) return;
        // Reuse the exact snapshot normalization on the single update.
        for (const m of normalizeOdds([entry])) {
          const key = `${m.marketType}|${m.period ?? ""}|${m.parameters ?? ""}`;
          const prev = oddsBookRef.current.get(key);
          if (!prev || m.ts >= prev.ts) oddsBookRef.current.set(key, m);
        }
        const next = extractMatchOdds([...oddsBookRef.current.values()]);
        if (!next) return;
        setConsensus(next);
        setConsensusHistory((prevPoints) => {
          const lastPoint = prevPoints[prevPoints.length - 1];
          if (lastPoint && lastPoint.ts === next.ts) return prevPoints; // same quote re-derived
          return [
            ...prevPoints.slice(-(CONSENSUS_HISTORY_MAX - 1)),
            { ts: next.ts, p1: next.p1.impliedProb, draw: next.draw.impliedProb, p2: next.p2.impliedProb },
          ];
        });
      } catch {
        // odds are decoration — swallow everything
      }
    },
    [fixtureId],
  );

  const stop = useCallback((): void => {
    esRef.current?.close();
    esRef.current = null;
    oddsEsRef.current?.close();
    oddsEsRef.current = null;
  }, []);

  const start = useCallback((): void => {
    stop();
    setFeed([]);
    scoreRef.current = [0, 0];
    setScore([0, 0]);
    setScorePulse(0);
    setStats(undefined);
    setMinute("");
    setFinalSeq(null);
    oddsBookRef.current = new Map();
    setConsensus(null);
    setConsensusHistory([]);
    setPhase("connecting");

    const url = mode === "replay" ? replayUrl(fixtureId, replaySpeed) : streamUrl();
    const es = new EventSource(url);
    esRef.current = es;

    if (mode === "replay") {
      // Recorded odds interleave into the replay as named `odds` events —
      // absent recording, no events, no line.
      es.addEventListener("odds", (e: MessageEvent<string>) => ingestOdds(e.data));
    } else {
      // Live: the relay fans TxLINE's /odds/stream out verbatim (unnamed
      // events → onmessage). Errors self-heal via EventSource reconnect.
      try {
        const oddsEs = new EventSource(oddsStreamUrl());
        oddsEs.onmessage = (e: MessageEvent<string>) => ingestOdds(e.data);
        oddsEsRef.current = oddsEs;
      } catch {
        // no odds stream → no consensus line, ticker unaffected
      }
    }

    es.onopen = () => setPhase("playing");
    es.onmessage = (e: MessageEvent<string>) => {
      let rec: ScoreRecord;
      try {
        rec = JSON.parse(e.data) as ScoreRecord;
      } catch {
        return;
      }
      // The live stream carries every fixture; replays carry only ours — the
      // same filter serves both.
      if (rec.FixtureId !== fixtureId) return;

      if (rec.Clock) setMinute(matchMinute(rec.Clock.Seconds));
      if (rec.Score) {
        const next: [number, number] = [
          rec.Score.Participant1?.Total?.Goals ?? 0,
          rec.Score.Participant2?.Total?.Goals ?? 0,
        ];
        // A changed scoreline pulses the scoreboard — goal choreography.
        if (next[0] !== scoreRef.current[0] || next[1] !== scoreRef.current[1]) {
          setScorePulse((n) => n + 1);
        }
        scoreRef.current = next;
        setScore(next);
      }
      const scoreStr = `${scoreRef.current[0]}–${scoreRef.current[1]}`;
      if (rec.Stats && Object.keys(rec.Stats).length > 0) setStats(rec.Stats);

      const meta = FEED_META[rec.Action];
      if (meta) {
        setFeed((prev) =>
          [
            {
              seq: rec.Seq,
              minute: matchMinute(rec.Clock?.Seconds),
              icon: meta.icon,
              label: meta.label,
              score: scoreStr,
              kind: feedKind(rec.Action),
            },
            ...prev,
          ].slice(0, 60),
        );
      }
      if (rec.StatusId === 100 || rec.Action === "game_finalised") {
        setFinalSeq((prev) => {
          if (prev !== null) return prev;
          onFinalisedRef.current?.(rec.Seq);
          return rec.Seq;
        });
      }
    };
    // Server signals replay completion explicitly; without closing here the
    // EventSource would auto-reconnect and replay the match forever.
    es.addEventListener("replay_done", () => {
      stop();
      setPhase("done");
    });
    es.onerror = () => {
      // Live mode: EventSource reconnects on its own; nothing to do.
      // Replay mode: an error after the server closed mid-replay — restarting
      // silently would confuse; just stop.
      if (mode === "replay" && esRef.current?.readyState === EventSource.CLOSED) {
        setPhase("idle");
      }
    };
  }, [fixtureId, mode, replaySpeed, stop, ingestOdds]);

  useEffect(() => {
    if (autoStart) start();
    return stop;
  }, [autoStart, start, stop]);

  const condition = tracker ? evaluatePredicate(tracker.decoded, tracker.statKeys, stats) : null;

  // Condition state, upgraded from "leading" to a FINAL verdict as soon as
  // it is mathematically decided:
  //  - counting stats only ever go up, so a Single or Add predicate that has
  //    crossed a GreaterThan threshold is irreversibly MET, and one that has
  //    crossed a LessThan threshold is irreversibly LOST;
  //  - a Subtract predicate (e.g. goal difference) can swing back, so it only
  //    finalises at the whistle;
  //  - once the match finalises, every predicate is decided.
  type CondState = "met" | "lost" | "yes" | "no";
  let condState: CondState | null = null;
  if (condition && tracker) {
    const p = tracker.decoded;
    const monotonic = p.kind === "single" || p.op === OP.add;
    const decided =
      finalSeq !== null ||
      (monotonic && p.cmp === CMP.gt && condition.verdict) ||
      (monotonic && p.cmp === CMP.lt && !condition.verdict);
    condState = decided ? (condition.verdict ? "met" : "lost") : condition.verdict ? "yes" : "no";
  }
  const condFinal = condState === "met" || condState === "lost";

  return (
    <div className="card p-0">
      {/* Scoreboard */}
      <div className="flex items-center justify-between gap-4 border-b border-pitch-600/60 bg-pitch-800/60 px-5 py-4">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold text-chalk">{home}</span>
          {/* Keyed on the pulse counter so each goal restarts the pop. */}
          <span
            key={scorePulse}
            className={`font-mono text-2xl font-bold text-turf-300 ${scorePulse > 0 ? "score-pop" : ""}`}
          >
            {score[0]}–{score[1]}
          </span>
          <span className="text-lg font-bold text-chalk">{away}</span>
        </div>
        <div className="flex items-center gap-3">
          {finalSeq !== null ? (
            <span className="rounded-full border border-turf-500/60 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-turf-300">
              FT · finalised seq {finalSeq}
            </span>
          ) : (
            phase === "playing" && (
              <span className="font-mono text-sm text-chalk/70">{minute || "—"}</span>
            )
          )}
          {phase === "idle" || phase === "done" ? (
            <button className="btn-primary h-8 text-xs" onClick={start}>
              {phase === "done" ? "Replay again" : mode === "replay" ? `▶ Run replay ${replaySpeed}×` : "▶ Watch live"}
            </button>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-chalk/60">
              <span className={`h-2 w-2 rounded-full ${phase === "playing" ? "animate-pulse bg-card-red" : "bg-chalk/40"}`} />
              {phase === "connecting" ? "connecting…" : mode === "replay" ? `replaying ${replaySpeed}×` : "live"}
            </span>
          )}
        </div>
      </div>

      {/* Live consensus line — only when odds events actually arrived. */}
      {consensus && (
        <ConsensusLine home={home} away={away} odds={consensus} history={consensusHistory} />
      )}

      {/* Condition tracker */}
      {tracker && (
        <div className="border-b border-pitch-600/60 px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs text-chalk/70">{tracker.description}</p>
            {condition && condState ? (
              // Keyed on the state so the flip to MET/LOST replays the pop.
              <span
                key={condState}
                className={`badge-pop rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                  condState === "met"
                    ? "border border-turf-500/60 bg-turf-600/20 text-turf-300 shadow-glow"
                    : condState === "lost"
                      ? "border border-card-red/50 bg-card-red/15 text-card-red"
                      : condState === "yes"
                        ? "bg-turf-600/20 text-turf-300"
                        : "bg-card-red/15 text-card-red"
                }`}
              >
                {condState === "met"
                  ? "✓ Condition met"
                  : condState === "lost"
                    ? "✕ Condition lost"
                    : condState === "yes"
                      ? "YES leading"
                      : "NO leading"}
              </span>
            ) : (
              <span className="text-[11px] uppercase tracking-wider text-chalk/40">waiting for stats</span>
            )}
          </div>
          {condition && (
            <div className="mt-2 flex items-center gap-3">
              {/* Keyed on the value so every relevant event visibly ticks. */}
              <span key={condition.value} className="badge-pop font-mono text-lg font-bold text-chalk">
                {condition.value}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-pitch-700">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    condState === "met"
                      ? "bg-turf-400 shadow-glow"
                      : condState === "lost"
                        ? "bg-card-red"
                        : condition.verdict
                          ? "bg-turf-500"
                          : "bg-card-red/80"
                  }`}
                  style={{
                    width: `${Math.min(100, (condition.value / Math.max(tracker.decoded.threshold + 1, 1)) * 100)}%`,
                  }}
                />
              </div>
              <span className="whitespace-nowrap font-mono text-xs text-chalk/50">
                {condFinal
                  ? condState === "met"
                    ? "settles YES"
                    : "settles NO"
                  : `needs ${["> ", "< ", "= "][tracker.decoded.cmp]}${tracker.decoded.threshold}`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Event feed */}
      <div className="max-h-72 overflow-y-auto px-5 py-3">
        {feed.length === 0 ? (
          <p className="py-4 text-center text-sm text-chalk/40">
            {phase === "playing"
              ? "Waiting for match events…"
              : mode === "replay"
                ? "Press play to replay the recorded match through the live pipeline."
                : "No events yet."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {feed.map((item) => {
              if (item.kind === "halftime" || item.kind === "fulltime") {
                // Period boundaries get full-width banner rows.
                const ft = item.kind === "fulltime";
                return (
                  <li
                    key={item.seq}
                    className={`-mx-2 flex items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest ${
                      ft
                        ? "border-turf-500/50 bg-turf-600/10 text-turf-300"
                        : "border-pitch-500/60 bg-pitch-800/80 text-chalk/70"
                    }`}
                  >
                    <span aria-hidden>{item.icon}</span>
                    <span>{ft ? "Full time — stats finalised" : "Half-time"}</span>
                    <span className="font-mono">{item.score}</span>
                  </li>
                );
              }
              if (item.kind === "goal") {
                // Goals get the highlight row: flash in, settle on a glow.
                return (
                  <li key={item.seq} className="goal-row -mx-2 flex items-center gap-3 px-2 py-1 text-sm">
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-chalk/60">
                      {item.minute || "—"}
                    </span>
                    <span className="w-5 text-center">{item.icon}</span>
                    <span className="font-bold uppercase tracking-wide text-turf-300">Goal</span>
                    <span className="ml-auto font-mono text-sm font-bold text-chalk">{item.score}</span>
                  </li>
                );
              }
              return (
                <li key={item.seq} className="flex items-center gap-3 px-0 text-sm">
                  <span className="w-10 shrink-0 text-right font-mono text-xs text-chalk/50">
                    {item.minute || "—"}
                  </span>
                  <span className="w-5 text-center">{item.icon}</span>
                  <span className="text-chalk/80">{item.label}</span>
                  <span className="ml-auto font-mono text-xs text-chalk/40">{item.score}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consensus line — "TxLINE consensus: France 51% ▁▂▃" as live odds arrive.
// Pure SVG sparklines; renders only when the parent has actual consensus.
// ---------------------------------------------------------------------------

function ConsensusLine({
  home,
  away,
  odds,
  history,
}: {
  home: string;
  away: string;
  odds: MatchOdds;
  history: ConsensusPoint[];
}): React.ReactNode {
  const period = periodLabel(odds.period);
  const cells: { name: string; prob: number; series: number[] }[] = [
    { name: home, prob: odds.p1.impliedProb, series: history.map((h) => h.p1) },
    { name: "Draw", prob: odds.draw.impliedProb, series: history.map((h) => h.draw) },
    { name: away, prob: odds.p2.impliedProb, series: history.map((h) => h.p2) },
  ];
  return (
    <div className="border-b border-pitch-600/60 px-5 py-2">
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-chalk/70"
        title="TXLINE StablePrice consensus (demargined), streamed live — implied % from decimal odds, set normalized to 100%"
      >
        <span className="label text-sky-300/80">TxLINE consensus</span>
        {period && <span className="label">· {period}</span>}
        {odds.inRunning && <span className="label text-card-red/80">· in-running</span>}
        {cells.map((c, i) => (
          <span key={c.name + i} className="flex items-center gap-1 whitespace-nowrap">
            {i > 0 && <span className="mr-1 text-chalk/30">·</span>}
            {c.name} <span className="font-semibold text-chalk">{fmtProb(c.prob)}</span>
            <Sparkline values={c.series} />
          </span>
        ))}
        <span className="ml-auto hidden h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300/70 sm:inline-block" aria-hidden />
      </p>
    </div>
  );
}

/** Tiny inline probability sparkline. Needs ≥2 points to say anything. */
function Sparkline({ values }: { values: number[] }): React.ReactNode {
  if (values.length < 2) return null;
  const w = 36;
  const h = 12;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Floor the span at 2pp so quote noise never renders as drama.
  const span = Math.max(max - min, 0.02);
  const mid = (min + max) / 2;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - (mid - span / 2)) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="inline-block text-sky-300/70"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
