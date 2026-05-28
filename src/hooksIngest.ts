import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as db from "./db.js";

export const HOOK_EVENTS_PATH = join(homedir(), ".claude", "skills-usage", "hook-events.jsonl");

interface HookEvent {
  received_at?: string;
  hook_event_name?: string;
  tool_use_id?: string;
  duration_ms?: number;
}

export function ingestHookEvents(
  path: string = HOOK_EVENTS_PATH,
  dbPath: string = db.DB_PATH,
): { events: number; updated: number; skipped: number } {
  if (!existsSync(path)) return { events: 0, updated: 0, skipped: 0 };

  const preAt: Record<string, string> = {};
  const postAt: Record<string, string> = {};
  const durations: Record<string, number> = {};

  const raw = readFileSync(path, "utf-8");
  let events = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: HookEvent;
    try { e = JSON.parse(line); } catch { continue; }
    events += 1;
    const tid = e.tool_use_id;
    if (!tid) continue;
    if (e.hook_event_name === "PreToolUse") {
      const ra = e.received_at ?? "";
      if (!(tid in preAt) || ra < preAt[tid]) preAt[tid] = ra;
    } else if (e.hook_event_name === "PostToolUse") {
      const ra = e.received_at ?? "";
      if (!(tid in postAt) || ra > postAt[tid]) postAt[tid] = ra;
      if (typeof e.duration_ms === "number") durations[tid] = e.duration_ms;
    }
  }

  let updated = 0;
  let skipped = 0;
  const allIds = new Set([...Object.keys(preAt), ...Object.keys(postAt)]);
  for (const tid of allIds) {
    const t0 = preAt[tid] ?? null;
    const t1 = postAt[tid] ?? null;
    let durSec: number | null = null;
    if (tid in durations) {
      durSec = durations[tid] / 1000;
    } else if (t0 && t1) {
      const p0 = Date.parse(t0);
      const p1 = Date.parse(t1);
      if (!Number.isNaN(p0) && !Number.isNaN(p1)) durSec = (p1 - p0) / 1000;
    }
    if (db.updateHookTiming(tid, t0, t1, durSec, dbPath)) updated += 1;
    else skipped += 1;
  }

  return { events, updated, skipped };
}
