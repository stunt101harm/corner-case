#!/usr/bin/env node
/**
 * sync_settlements.mjs — push the laptop's settlement journal to the deployed
 * relay Worker. The Worker serves GET /api/settlements from KV; this script is
 * how the KV copy tracks keeper/settlements.jsonl (run it after each local
 * settlement, or whenever the journal changes).
 *
 *   node scripts/sync_settlements.mjs
 *
 * Reads RELAY_SYNC_TOKEN from the repo root .env (written at Worker deploy
 * time; must match the Worker's SYNC_TOKEN secret). Override the target with
 * RELAY_SYNC_URL if the Worker ever moves.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JOURNAL = path.join(ROOT, "keeper", "settlements.jsonl");
const DEFAULT_URL = "https://corner-case-relay.h-dhaliwal2250.workers.dev/api/settlements";

// Minimal .env loader (same contract as keeper/src/auth.ts loadRepoEnv).
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const token = process.env.RELAY_SYNC_TOKEN;
if (!token) {
  console.error("RELAY_SYNC_TOKEN is not set — add it to the repo root .env");
  process.exit(1);
}

let text = "";
try {
  text = fs.readFileSync(JOURNAL, "utf8");
} catch {
  // No journal yet — sync an empty array so the Worker returns [] not stale data.
}
const entries = [];
for (const line of text.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    entries.push(JSON.parse(line));
  } catch {
    // Half-written trailing line — skip, same as the local relay's reader.
  }
}

const url = process.env.RELAY_SYNC_URL ?? DEFAULT_URL;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Sync-Token": token },
  body: JSON.stringify(entries),
});
const body = await res.text();
if (!res.ok) {
  console.error(`sync failed: HTTP ${res.status} ${body}`);
  process.exit(1);
}
console.log(`synced ${entries.length} settlement(s) → ${url}: ${body}`);
