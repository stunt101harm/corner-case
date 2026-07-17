/**
 * smoke.ts — end-to-end checks against real data, no mocks:
 *
 *  B) replay the committed England v Argentina semi recording at max speed
 *     through FixtureRegistry (the same state path live records take) and
 *     assert the final state: finalisedSeq 962, statusId 100, stats 1→1, 2→2
 *     (England 1–2 Argentina).
 *  C) hit the LIVE devnet stat-validation endpoint for that fixture at the
 *     finalised seq and assert the proven leaves match — values 1 and 2, both
 *     period 100 (the finality marker our on-chain check gate #2 requires).
 *
 * (Test A — auth + fixtures + live stream — lives in record.ts --smoke.)
 */

import { TxlineAuth } from "./auth";
import { TxlineClient } from "./txline";
import { FixtureRegistry } from "./state";
import { replayFile, DEFAULT_RECORDING } from "./replay";

const FIXTURE = 18241006; // England v Argentina, WC semi, finished 1–2
const FINAL_SEQ = 962;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: expected ${String(expected)}, got ${String(actual)}`);
}

async function testReplayThroughState(): Promise<void> {
  console.log("SMOKE B: replay recorded semi at max speed through FixtureRegistry");
  const registry = new FixtureRegistry(); // no persistence — pure state check
  registry.track(FIXTURE);
  const result = await replayFile(
    DEFAULT_RECORDING,
    { onRecord: (record) => void registry.applyRecord(record) },
    { speed: "max" },
  );
  console.log(`  replayed ${result.records} records`);
  const f = registry.get(FIXTURE);
  check("records delivered", result.records, 964);
  check("finalisedSeq", f?.finalisedSeq, FINAL_SEQ);
  check("statusId", f?.statusId, 100);
  check("stats[1] (England goals)", f?.stats?.["1"], 1);
  check("stats[2] (Argentina goals)", f?.stats?.["2"], 2);
}

async function testLiveStatValidation(): Promise<void> {
  console.log(`SMOKE C: live stat-validation for ${FIXTURE} seq=${FINAL_SEQ} keys=[1,2]`);
  const client = new TxlineClient(new TxlineAuth());
  const val = await client.statValidation(FIXTURE, FINAL_SEQ, [1, 2]);
  check("summary.fixtureId", val.summary.fixtureId, FIXTURE);
  check("statsToProve.length", val.statsToProve.length, 2);
  const k1 = val.statsToProve.find((s) => s.key === 1);
  const k2 = val.statsToProve.find((s) => s.key === 2);
  check("key 1 value", k1?.value, 1);
  check("key 1 period (final)", k1?.period, 100);
  check("key 2 value", k2?.value, 2);
  check("key 2 period (final)", k2?.period, 100);
  check("proof legs present", val.subTreeProof.length > 0 && val.mainTreeProof.length > 0, true);
}

(async () => {
  await testReplayThroughState();
  await testLiveStatValidation();
  console.log(failures === 0 ? "SMOKE B+C: ALL PASS" : `SMOKE B+C: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`smoke crashed: ${String(err)}`);
  process.exit(1);
});
