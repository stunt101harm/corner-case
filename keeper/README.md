# Corner Case keeper — TxLINE auth, recorder & replay

Self-contained TypeScript package (own `node_modules`, zero runtime deps —
native `fetch` only). Everything runs with `tsx` on Node 20+.

```bash
cd keeper
npm install          # dev deps only: tsx, typescript, @types/node
```

Credentials come from the repo root `.env` (`TXLINE_API_TOKEN`, optional
`TXLINE_API_BASE` / `TXLINE_JWT_URL` overrides); real environment variables
win over the file. Guest JWTs are acquired and renewed automatically.

## Record mode — tomorrow's matches

One long-running process records all remaining fixtures (it survives stream
drops, 503 outages, JWT expiry and laptop sleep/wake — reconnect loops with
jittered backoff, nothing crashes on an unhandled rejection):

```bash
cd keeper
npx tsx src/record.ts 18143850 18257865 18257739
```

| Fixture | Match | Kickoff (UTC) |
|---|---|---|
| `18143850` | Vietnam v Myanmar (friendly — early live test) | Jul 18 12:00 |
| `18257865` | France v England (3rd place) | Jul 18 21:00 |
| `18257739` | Spain v Argentina (FINAL) | Jul 19 19:00 |

Equivalent: `npx tsx src/record.ts 18143850 --competition 72` (competition 72
resolves both World Cup fixtures from the fixtures snapshot).

Start it ~30 min before the first kickoff and leave it running across both
days; Ctrl-C stops it cleanly (flushes state + in-flight file writes). If it
dies or the laptop reboots, just rerun the same command — `keeper/state.json`
remembers every tracked fixture (including which ones already finalised, so
side effects never re-fire) and an interrupted proof fetch resumes. Delete
`keeper/state.json` only if you want a genuinely fresh start.

Per fixture it writes to `recordings/raw/` (gitignored):

| File | Contents |
|---|---|
| `<id>.sse` | every raw SSE block for the fixture, verbatim, append-only — same format as the committed semi recording, so it replays directly |
| `<id>.snapshots.jsonl` | 60s polls of `/scores/snapshot/<id>` (state-based finalisation detection — a missed SSE event can never strand a fixture) |
| `<id>.proofs.json` | stat-validation Merkle proofs at the finalised seq for key sets `[1,2]`, `[7,8]`, `[1001,1002]`, `[3005,3006]`, `[3,4]` |
| `<id>.timing.json` | timestamps: finalisation event vs first successful proof fetch (measures TxLINE's proof-availability lag) |

A heartbeat log line prints once a minute; goals/cards/corners/finalisations
are logged as they happen.

## Replay

CLI smoke test (ticker of action / minute / score):

```bash
npx tsx src/replay.ts                                   # committed semi, 30x (capped to fit 5 min)
npx tsx src/replay.ts --speed max                       # as fast as possible
npx tsx src/replay.ts ../recordings/raw/18257865.sse --speed 60
```

Speed is a wall-clock compression of the recorded `Ts` deltas; the effective
speed is floored so the whole file plays in ≤ 5 minutes (recordings contain
pre-match records from days earlier, so an uncapped 30x would idle for hours).

As a library — this is the interface the settlement engine, relay and judge
demo mode consume; it is the **same `StreamHandlers` contract as the live
stream**, so replayed matches exercise identical code paths:

```ts
import { replayFile } from "./src/replay";
import { FixtureRegistry } from "./src/state";

const registry = new FixtureRegistry();
registry.track(18241006);
await replayFile("../recordings/18241006-england-argentina-semi.sse", {
  onRecord: (record) => registry.applyRecord(record),
  onStatus: (s) => console.log(s.type),
}, { speed: 30 }); // or "max"
```

## Smoke tests (real devnet API, no mocks)

```bash
npx tsx src/record.ts --smoke   # auth + fixtures snapshot + 20s live stream
npx tsx src/smoke.ts            # replay semi through state → assert final state;
                                # live stat-validation at seq 962 → assert leaves
npm run smoke                   # both
```

## Module layout

| Module | Role |
|---|---|
| `src/auth.ts` | `TxlineAuth`: `.env` loading, guest-JWT lifecycle (single-flight renewal on 401), `authedFetch` with 2s/8s/30s backoff on 5xx/network errors |
| `src/txline.ts` | typed API client (`fixturesSnapshot`, `scoresSnapshot` + `summariseSnapshot`, `historicalScores`, `statValidation`, `streamScores`), incremental SSE parser shared by live/historical/replay, idle-watchdog reconnect loop |
| `src/state.ts` | `FixtureRegistry`: tracked-fixture state fed identically by live and replay; throttled atomic persistence to `keeper/state.json` |
| `src/recorder.ts` | unattended capture: verbatim raw SSE, snapshot polling, finalisation → proof fetch with retry, timing measurements |
| `src/record.ts` | CLI for record mode and `--smoke` |
| `src/replay.ts` | replay harness (library + ticker CLI) |
| `src/smoke.ts` | end-to-end assertions (replay-through-state + live stat-validation) |

API facts this package relies on are documented in `../spike/NOTES.md`
(ground truth where it and PLAN.md differ).
