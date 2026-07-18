/**
 * record.ts — CLI entry for record mode (and the --smoke self-check).
 *
 *   npx tsx keeper/src/record.ts 18257865 18257739        # explicit fixtures
 *   npx tsx keeper/src/record.ts --competition 72         # every WC fixture
 *   npx tsx keeper/src/record.ts --smoke                  # auth + snapshot + 20s stream
 *
 * Runs until Ctrl-C. Designed to be left alone for hours during live matches:
 * unhandled rejections/exceptions are logged and swallowed (a recorder that
 * dies at minute 87 because one promise slipped through is strictly worse
 * than one that logs an error and keeps capturing).
 */

import { fileURLToPath } from "node:url";
import { TxlineAuth, sleep } from "./auth";
import { TxlineClient } from "./txline";
import { FixtureRegistry } from "./state";
import { Recorder, scoreline } from "./recorder";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_OUT_DIR = fileURLToPath(new URL("../../recordings/raw", import.meta.url));
const STATE_PATH = fileURLToPath(new URL("../state.json", import.meta.url));

interface CliArgs {
  fixtureIds: number[];
  competitionId?: number;
  smoke: boolean;
  snapshotIntervalMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { fixtureIds: [], smoke: false, snapshotIntervalMs: 60_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") args.smoke = true;
    else if (a === "--competition") args.competitionId = Number(argv[++i]);
    else if (a === "--snapshot-interval") args.snapshotIntervalMs = Number(argv[++i]) * 1_000;
    else if (/^\d+$/.test(a)) args.fixtureIds.push(Number(a));
    else {
      console.error(`unknown argument: ${a}`);
      console.error(
        "usage: record.ts [fixtureId...] [--competition <id>] [--snapshot-interval <s>] [--smoke]",
      );
      process.exit(2);
    }
  }
  return args;
}

const ts = (): string => new Date().toISOString();
const log = (msg: string): void => console.log(`${ts()} ${msg}`);

/**
 * --smoke: prove the full chain works before trusting it with a real match.
 * 1) auth (API token + fresh guest JWT), 2) fixtures snapshot, 3) live stream
 * open for 20s (quiet outside match hours — that is fine, connecting is the
 * test), then exit 0.
 */
async function smoke(): Promise<void> {
  log("SMOKE 1/3: auth — loading TXLINE_API_TOKEN and acquiring guest JWT");
  const auth = new TxlineAuth();
  const jwt = await auth.getJwt();
  log(`SMOKE 1/3: OK — JWT acquired (${jwt.length} chars), api base ${auth.apiBase}`);

  const client = new TxlineClient(auth);
  log("SMOKE 2/3: fixtures snapshot");
  const fixtures = await client.fixturesSnapshot();
  log(`SMOKE 2/3: OK — ${fixtures.length} fixtures`);
  for (const f of fixtures) {
    log(
      `  ${f.FixtureId} ${f.Participant1} v ${f.Participant2} ` +
        `(${f.Competition} ${f.CompetitionId}) kickoff ${new Date(f.StartTime).toISOString()}`,
    );
  }

  log("SMOKE 3/3: opening live SSE stream for 20s");
  let records = 0;
  let opened = false;
  const stream = client.streamScores({
    onRecord: (record) => {
      records++;
      if (records <= 5) {
        log(`  record: fixture=${record.FixtureId} seq=${record.Seq} ${record.Action} ${scoreline(record)}`);
      }
    },
    onStatus: (s) => {
      if (s.type === "open") opened = true;
      log(`  stream ${s.type}${s.detail ? ` (${s.detail})` : ""}`);
    },
  });
  await sleep(20_000);
  stream.stop();
  await stream.done;
  log(`SMOKE 3/3: ${opened ? "OK" : "FAILED"} — stream opened=${opened}, records seen=${records} (0 is normal outside match hours)`);
  if (!opened) {
    log("SMOKE: FAIL");
    process.exit(1);
  }
  log("SMOKE: PASS");
  process.exit(0);
}

async function record(args: CliArgs): Promise<void> {
  const auth = new TxlineAuth();
  const client = new TxlineClient(auth);
  const registry = new FixtureRegistry({ persistPath: STATE_PATH });
  const recorder = new Recorder({
    client,
    registry,
    fixtureIds: args.fixtureIds,
    competitionId: args.competitionId,
    outDir: DEFAULT_OUT_DIR,
    snapshotIntervalMs: args.snapshotIntervalMs,
    log,
  });

  log(`record mode starting (repo root ${REPO_ROOT.replace(/\/$/, "")})`);
  log(`output dir: ${DEFAULT_OUT_DIR} (gitignored)`);
  await recorder.start();

  // Heartbeat: one status line per minute so a glance at the terminal (or a
  // log tail over ssh) shows the recorder is alive and what it believes.
  const heartbeat = setInterval(() => {
    const states = registry
      .all()
      .map(
        (f) =>
          `${f.fixtureId}:seq=${f.lastSeq}${f.statusId !== undefined ? ` status=${f.statusId}` : ""}` +
          `${f.finalisedSeq !== undefined ? ` FINAL@${f.finalisedSeq}` : ""}`,
      )
      .join(" | ");
    log(
      `[heartbeat] records=${recorder.counters.records} snapshots=${recorder.counters.snapshots} ` +
        `streamDrops=${recorder.counters.streamDrops} odds=${recorder.counters.oddsRecords} ` +
        `oddsDrops=${recorder.counters.oddsStreamDrops} :: ${states}`,
    );
  }, 60_000);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // second Ctrl-C: let the default handler kill us
    shuttingDown = true;
    log(`${signal} received — flushing and stopping (Ctrl-C again to force)`);
    clearInterval(heartbeat);
    void recorder
      .stop()
      .catch((err) => log(`shutdown error: ${String(err)}`))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Last-resort guards. Everything is wrapped in try/catch already; these exist
// because "unattended during a real match" means even a bug may not stop the
// capture — log loudly, keep the process alive.
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED REJECTION (recorder continues): ${String(reason)}`);
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION (recorder continues): ${err.stack ?? String(err)}`);
});

const args = parseArgs(process.argv.slice(2));
if (args.smoke) {
  smoke().catch((err) => {
    log(`SMOKE: FAIL — ${String(err)}`);
    process.exit(1);
  });
} else {
  record(args).catch((err) => {
    log(`fatal during startup: ${String(err)}`);
    process.exit(1);
  });
}
