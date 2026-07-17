"use client";

/**
 * LiveMatch.tsx — scoreboard, event ticker and live condition tracker, fed by
 * SSE from the relay. `mode: "live"` consumes the fan-out of TxLINE's real
 * stream; `mode: "replay"` consumes the recorded demo match through the SAME
 * event format — this component cannot tell the difference, which is the
 * point of the demo being honest.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { replayUrl, streamUrl } from "@/lib/relay";
import { evaluatePredicate, type DecodedPredicate } from "@/lib/strategy";
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

interface FeedItem {
  seq: number;
  minute: string;
  icon: string;
  label: string;
  score: string;
}

export interface TrackerSpec {
  decoded: DecodedPredicate;
  statKeys: number[];
  description: string;
}

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
  const [minute, setMinute] = useState("");
  const [stats, setStats] = useState<Record<string, number> | undefined>();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [finalSeq, setFinalSeq] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Score is also kept in a ref: feed items need the score *at delivery time*
  // and React state updaters are not synchronous.
  const scoreRef = useRef<[number, number]>([0, 0]);
  const onFinalisedRef = useRef(onFinalised);
  onFinalisedRef.current = onFinalised;

  const stop = useCallback((): void => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const start = useCallback((): void => {
    stop();
    setFeed([]);
    scoreRef.current = [0, 0];
    setScore([0, 0]);
    setStats(undefined);
    setMinute("");
    setFinalSeq(null);
    setPhase("connecting");

    const url = mode === "replay" ? replayUrl(fixtureId, replaySpeed) : streamUrl();
    const es = new EventSource(url);
    esRef.current = es;

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
        scoreRef.current = [
          rec.Score.Participant1?.Total?.Goals ?? 0,
          rec.Score.Participant2?.Total?.Goals ?? 0,
        ];
        setScore(scoreRef.current);
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
  }, [fixtureId, mode, replaySpeed, stop]);

  useEffect(() => {
    if (autoStart) start();
    return stop;
  }, [autoStart, start, stop]);

  const condition = tracker ? evaluatePredicate(tracker.decoded, tracker.statKeys, stats) : null;

  return (
    <div className="card p-0">
      {/* Scoreboard */}
      <div className="flex items-center justify-between gap-4 border-b border-pitch-600/60 bg-pitch-800/60 px-5 py-4">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold text-chalk">{home}</span>
          <span className="font-mono text-2xl font-bold text-turf-300">
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

      {/* Condition tracker */}
      {tracker && (
        <div className="border-b border-pitch-600/60 px-5 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-xs text-chalk/70">{tracker.description}</p>
            {condition ? (
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                  condition.verdict ? "bg-turf-600/20 text-turf-300" : "bg-card-red/15 text-card-red"
                }`}
              >
                {condition.verdict ? "YES leading" : "NO leading"}
              </span>
            ) : (
              <span className="text-[11px] uppercase tracking-wider text-chalk/40">waiting for stats</span>
            )}
          </div>
          {condition && (
            <div className="mt-2 flex items-center gap-3">
              <span className="font-mono text-lg font-bold text-chalk">{condition.value}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-pitch-700">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    condition.verdict ? "bg-turf-500" : "bg-card-red/80"
                  }`}
                  style={{
                    width: `${Math.min(100, (condition.value / Math.max(tracker.decoded.threshold + 1, 1)) * 100)}%`,
                  }}
                />
              </div>
              <span className="whitespace-nowrap font-mono text-xs text-chalk/50">
                needs {["> ", "< ", "= "][tracker.decoded.cmp]}
                {tracker.decoded.threshold}
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
            {feed.map((item) => (
              <li key={item.seq} className="flex items-center gap-3 text-sm">
                <span className="w-10 shrink-0 text-right font-mono text-xs text-chalk/50">
                  {item.minute || "—"}
                </span>
                <span className="w-5 text-center">{item.icon}</span>
                <span
                  className={
                    item.label === "GOAL" || item.label.startsWith("Full time")
                      ? "font-semibold text-turf-300"
                      : "text-chalk/80"
                  }
                >
                  {item.label}
                </span>
                <span className="ml-auto font-mono text-xs text-chalk/40">{item.score}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
