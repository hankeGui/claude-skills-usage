import Database from "better-sqlite3";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillCall } from "./scan.js";

export const DB_PATH = join(homedir(), ".claude", "skills-usage", "db.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_calls (
    tool_use_id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    args TEXT,
    session_id TEXT,
    cwd TEXT,
    transcript_path TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_sec REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    error_count INTEGER,
    interrupted INTEGER,
    user_followup TEXT,
    user_followup_correction INTEGER,
    outcome TEXT,
    triggering_user_msg TEXT,
    hook_started_at TEXT,
    hook_ended_at TEXT,
    hook_duration_sec REAL,
    label TEXT,
    label_note TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_skill ON skill_calls(skill);
CREATE INDEX IF NOT EXISTS idx_started ON skill_calls(started_at);
CREATE INDEX IF NOT EXISTS idx_session ON skill_calls(session_id);
`;

const SCAN_COLS = [
  "tool_use_id", "skill", "args", "session_id", "cwd", "transcript_path",
  "started_at", "ended_at", "duration_sec",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
  "error_count", "interrupted", "user_followup", "user_followup_correction",
  "outcome", "triggering_user_msg",
];

export interface SkillRow {
  tool_use_id: string;
  skill: string;
  args: string | null;
  session_id: string | null;
  cwd: string | null;
  transcript_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  error_count: number | null;
  interrupted: number | null;
  user_followup: string | null;
  user_followup_correction: number | null;
  outcome: string | null;
  triggering_user_msg: string | null;
  hook_started_at: string | null;
  hook_ended_at: string | null;
  hook_duration_sec: number | null;
  label: string | null;
  label_note: string | null;
  updated_at: string | null;
}

export function connect(dbPath: string = DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

export function upsertCalls(calls: SkillCall[], dbPath: string = DB_PATH): { inserted: number; updated: number } {
  const db = connect(dbPath);
  let inserted = 0;
  let updated = 0;
  try {
    const cols = SCAN_COLS;
    const placeholders = cols.map((c) => `@${c}`).join(",");
    const updates = cols.filter((c) => c !== "tool_use_id").map((c) => `${c}=excluded.${c}`).join(",");

    const existsStmt = db.prepare("SELECT 1 FROM skill_calls WHERE tool_use_id=?");
    const upsertStmt = db.prepare(
      `INSERT INTO skill_calls (${cols.join(",")}) VALUES (${placeholders}) ` +
      `ON CONFLICT(tool_use_id) DO UPDATE SET ${updates}, updated_at=CURRENT_TIMESTAMP`,
    );

    const tx = db.transaction((rows: SkillCall[]) => {
      for (const c of rows) {
        const row = {
          tool_use_id: c.tool_use_id,
          skill: c.skill,
          args: c.args,
          session_id: c.session_id,
          cwd: c.cwd,
          transcript_path: c.transcript_path,
          started_at: c.started_at,
          ended_at: c.ended_at,
          duration_sec: c.duration_sec,
          input_tokens: c.input_tokens,
          output_tokens: c.output_tokens,
          cache_read_tokens: c.cache_read_tokens,
          cache_creation_tokens: c.cache_creation_tokens,
          error_count: c.error_count,
          interrupted: c.interrupted ? 1 : 0,
          user_followup: c.user_followup,
          user_followup_correction: c.user_followup_correction ? 1 : 0,
          outcome: c.outcome,
          triggering_user_msg: c.triggering_user_msg,
        };
        const exists = existsStmt.get(c.tool_use_id);
        upsertStmt.run(row);
        if (exists) updated += 1;
        else inserted += 1;
      }
    });
    tx(calls);
  } finally {
    db.close();
  }
  return { inserted, updated };
}

export interface FetchOptions {
  sinceDays?: number;
  skill?: string;
}

export function fetchAll(opts: FetchOptions = {}, dbPath: string = DB_PATH): SkillRow[] {
  const db = connect(dbPath);
  try {
    let q = "SELECT * FROM skill_calls";
    const clauses: string[] = [];
    const params: any[] = [];
    if (opts.sinceDays) {
      clauses.push("started_at >= datetime('now', ?)");
      params.push(`-${opts.sinceDays} days`);
    }
    if (opts.skill) {
      clauses.push("skill LIKE ?");
      params.push(`%${opts.skill}%`);
    }
    if (clauses.length) q += " WHERE " + clauses.join(" AND ");
    q += " ORDER BY started_at DESC";
    return db.prepare(q).all(...params) as SkillRow[];
  } finally {
    db.close();
  }
}

export function fetchUnlabeled(limit?: number, dbPath: string = DB_PATH): SkillRow[] {
  const db = connect(dbPath);
  try {
    let q = "SELECT * FROM skill_calls WHERE label IS NULL ORDER BY started_at DESC";
    if (limit) q += ` LIMIT ${limit}`;
    return db.prepare(q).all() as SkillRow[];
  } finally {
    db.close();
  }
}

export function setLabel(toolUseId: string, label: string | null, note: string = "", dbPath: string = DB_PATH): boolean {
  const db = connect(dbPath);
  try {
    const res = db.prepare(
      "UPDATE skill_calls SET label=?, label_note=?, updated_at=CURRENT_TIMESTAMP WHERE tool_use_id=?",
    ).run(label, note, toolUseId);
    return res.changes > 0;
  } finally {
    db.close();
  }
}

function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,\"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportCsv(outPath: string, dbPath: string = DB_PATH): number {
  const rows = fetchAll({}, dbPath);
  if (!rows.length) {
    writeFileSync(outPath, "");
    return 0;
  }
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => csvField((r as any)[c])).join(","));
  }
  writeFileSync(outPath, lines.join("\n") + "\n");
  return rows.length;
}

export function updateHookTiming(
  toolUseId: string,
  preAt: string | null,
  postAt: string | null,
  durationSec: number | null,
  dbPath: string = DB_PATH,
): boolean {
  const db = connect(dbPath);
  try {
    const res = db.prepare(
      "UPDATE skill_calls SET hook_started_at=?, hook_ended_at=?, hook_duration_sec=?, " +
      "updated_at=CURRENT_TIMESTAMP WHERE tool_use_id=?",
    ).run(preAt, postAt, durationSec, toolUseId);
    return res.changes > 0;
  } finally {
    db.close();
  }
}
