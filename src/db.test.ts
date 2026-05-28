import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "./db.js";
import type { SkillCall } from "./scan.js";

let dataDir: string;
let dbPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "db-test-"));
  dbPath = join(dataDir, "test.sqlite");
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeCall(overrides: Partial<SkillCall> = {}): SkillCall {
  return {
    skill: "demo-skill",
    args: "",
    session_id: "s1",
    cwd: "/tmp",
    transcript_path: "/tmp/t.jsonl",
    tool_use_id: "toolu_x",
    started_at: "2026-05-28T10:00:00Z",
    ended_at: "2026-05-28T10:00:30Z",
    duration_sec: 30,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    error_count: 0,
    interrupted: false,
    user_followup: "thanks",
    user_followup_correction: false,
    outcome: "likely_solved",
    triggering_user_msg: "go",
    ...overrides,
  };
}

describe("db.upsertCalls", () => {
  it("inserts new rows the first time and updates them the second time", () => {
    const call = makeCall();
    const r1 = db.upsertCalls([call], dbPath);
    expect(r1).toEqual({ inserted: 1, updated: 0 });

    const r2 = db.upsertCalls([call], dbPath);
    expect(r2).toEqual({ inserted: 0, updated: 1 });

    const rows = db.fetchAll({}, dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].skill).toBe("demo-skill");
    expect(rows[0].interrupted).toBe(0);
    expect(rows[0].outcome).toBe("likely_solved");
  });

  it("upsert overwrites changed fields on conflict", () => {
    db.upsertCalls([makeCall({ outcome: "unknown", error_count: 0 })], dbPath);
    db.upsertCalls([makeCall({ outcome: "likely_failed", error_count: 5 })], dbPath);
    const rows = db.fetchAll({}, dbPath);
    expect(rows[0].outcome).toBe("likely_failed");
    expect(rows[0].error_count).toBe(5);
  });

  it("respects the skill filter in fetchAll", () => {
    db.upsertCalls(
      [
        makeCall({ tool_use_id: "a", skill: "alpha" }),
        makeCall({ tool_use_id: "b", skill: "beta" }),
      ],
      dbPath,
    );
    expect(db.fetchAll({ skill: "alpha" }, dbPath).map((r) => r.skill)).toEqual(["alpha"]);
  });
});

describe("db.setLabel + fetchUnlabeled", () => {
  it("labels a row and removes it from unlabeled set", () => {
    db.upsertCalls([makeCall()], dbPath);
    expect(db.fetchUnlabeled(undefined, dbPath)).toHaveLength(1);

    const ok = db.setLabel("toolu_x", "solved", "looked good", dbPath);
    expect(ok).toBe(true);
    expect(db.fetchUnlabeled(undefined, dbPath)).toHaveLength(0);

    const rows = db.fetchAll({}, dbPath);
    expect(rows[0].label).toBe("solved");
    expect(rows[0].label_note).toBe("looked good");
  });

  it("returns false for an unknown tool_use_id", () => {
    expect(db.setLabel("does-not-exist", "solved", "", dbPath)).toBe(false);
  });
});

describe("db.exportCsv", () => {
  it("writes a header row and one record per call", () => {
    db.upsertCalls([makeCall(), makeCall({ tool_use_id: "y", skill: "other" })], dbPath);
    const out = join(dataDir, "out.csv");
    const n = db.exportCsv(out, dbPath);
    expect(n).toBe(2);

    const text = readFileSync(out, "utf-8").trim().split("\n");
    expect(text).toHaveLength(3);
    expect(text[0]).toContain("tool_use_id");
    expect(text[0]).toContain("skill");
  });

  it("writes empty file when DB has no rows", () => {
    const out = join(dataDir, "empty.csv");
    const n = db.exportCsv(out, dbPath);
    expect(n).toBe(0);
    expect(readFileSync(out, "utf-8")).toBe("");
  });
});

describe("db.updateHookTiming", () => {
  it("attaches hook timing to an existing row", () => {
    db.upsertCalls([makeCall()], dbPath);
    const ok = db.updateHookTiming("toolu_x", "2026-05-28T10:00:00Z", "2026-05-28T10:00:02Z", 2, dbPath);
    expect(ok).toBe(true);
    const rows = db.fetchAll({}, dbPath);
    expect(rows[0].hook_duration_sec).toBe(2);
    expect(rows[0].hook_started_at).toBe("2026-05-28T10:00:00Z");
  });
});
