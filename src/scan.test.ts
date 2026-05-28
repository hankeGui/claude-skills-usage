import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscript, listTranscripts, scanAllToArray } from "./scan.js";

interface JEntry { [k: string]: unknown }

function jsonl(entries: JEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

function userMsg(text: string, ts = "2026-05-28T10:00:00Z"): JEntry {
  return { type: "user", timestamp: ts, sessionId: "s1", cwd: "/tmp", message: { role: "user", content: text } };
}

function skillToolUse(id: string, skill: string, ts: string, args = ""): JEntry {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: "s1",
    cwd: "/tmp",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Skill", input: { skill, args } }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    },
  };
}

function toolResult(toolUseId: string, ts: string, isError = false): JEntry {
  return {
    type: "user",
    timestamp: ts,
    sessionId: "s1",
    cwd: "/tmp",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok", is_error: isError }],
    },
  };
}

function assistantText(text: string, ts: string): JEntry {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: "s1",
    cwd: "/tmp",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 20, output_tokens: 10 },
    },
  };
}

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "scan-test-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeTranscript(name: string, entries: JEntry[]): string {
  const path = join(workDir, name);
  writeFileSync(path, jsonl(entries));
  return path;
}

describe("scanTranscript", () => {
  it("extracts a single skill call with the triggering user message", () => {
    const path = writeTranscript("t1.jsonl", [
      userMsg("please run my skill"),
      skillToolUse("toolu_1", "demo-skill", "2026-05-28T10:00:01Z"),
      toolResult("toolu_1", "2026-05-28T10:00:02Z"),
      assistantText("done", "2026-05-28T10:00:03Z"),
      userMsg("thanks", "2026-05-28T10:00:10Z"),
    ]);
    const calls = scanTranscript(path);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.skill).toBe("demo-skill");
    expect(c.tool_use_id).toBe("toolu_1");
    expect(c.triggering_user_msg).toBe("please run my skill");
    expect(c.user_followup).toBe("thanks");
    expect(c.outcome).toBe("likely_solved");
    expect(c.error_count).toBe(0);
    expect(c.input_tokens).toBeGreaterThan(0);
  });

  it("classifies likely_failed when followup contains a correction word", () => {
    const path = writeTranscript("t2.jsonl", [
      userMsg("do it"),
      skillToolUse("toolu_2", "demo-skill", "2026-05-28T10:00:01Z"),
      assistantText("done", "2026-05-28T10:00:02Z"),
      userMsg("不对，重来"),
    ]);
    const calls = scanTranscript(path);
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe("likely_failed");
    expect(calls[0].user_followup_correction).toBe(true);
  });

  it("classifies likely_failed when interrupted text appears in flow", () => {
    const path = writeTranscript("t3.jsonl", [
      userMsg("go"),
      skillToolUse("toolu_3", "demo-skill", "2026-05-28T10:00:01Z"),
      assistantText("[Request interrupted by user]", "2026-05-28T10:00:02Z"),
    ]);
    const calls = scanTranscript(path);
    expect(calls[0].interrupted).toBe(true);
    expect(calls[0].outcome).toBe("likely_failed");
  });

  it("classifies unknown when no followup user message exists", () => {
    const path = writeTranscript("t4.jsonl", [
      userMsg("go"),
      skillToolUse("toolu_4", "demo-skill", "2026-05-28T10:00:01Z"),
      toolResult("toolu_4", "2026-05-28T10:00:02Z"),
      assistantText("done", "2026-05-28T10:00:03Z"),
    ]);
    const calls = scanTranscript(path);
    expect(calls[0].user_followup).toBe("");
    expect(calls[0].outcome).toBe("unknown");
  });

  it("ignores SKILL.md injection messages as user followup", () => {
    const injection = "Base directory for this skill: /home/u/.claude/skills/demo\nbody";
    const path = writeTranscript("t5.jsonl", [
      userMsg("go"),
      skillToolUse("toolu_5", "demo-skill", "2026-05-28T10:00:01Z"),
      // SKILL.md injection looks like a user msg but must be filtered
      userMsg(injection, "2026-05-28T10:00:02Z"),
      assistantText("answer", "2026-05-28T10:00:03Z"),
    ]);
    const calls = scanTranscript(path);
    // No real followup, so outcome stays unknown — not 'solved'
    expect(calls[0].user_followup).toBe("");
    expect(calls[0].outcome).toBe("unknown");
  });

  it("counts >=3 errors with no followup as likely_failed", () => {
    const path = writeTranscript("t6.jsonl", [
      userMsg("go"),
      skillToolUse("toolu_6", "demo-skill", "2026-05-28T10:00:01Z"),
      toolResult("toolu_6", "2026-05-28T10:00:02Z", true),
      toolResult("toolu_6", "2026-05-28T10:00:03Z", true),
      toolResult("toolu_6", "2026-05-28T10:00:04Z", true),
      assistantText("giving up", "2026-05-28T10:00:05Z"),
    ]);
    const calls = scanTranscript(path);
    expect(calls[0].error_count).toBeGreaterThanOrEqual(3);
    expect(calls[0].outcome).toBe("likely_failed");
  });

  it("returns empty array on a missing file", () => {
    expect(scanTranscript(join(workDir, "missing.jsonl"))).toEqual([]);
  });

  it("caps duration at 30 minutes for stale resumed sessions", () => {
    const path = writeTranscript("t7.jsonl", [
      userMsg("go"),
      skillToolUse("toolu_7", "demo-skill", "2026-05-28T10:00:00Z"),
      // 4 days later — a session resumed long after
      assistantText("late reply", "2026-06-01T10:00:00Z"),
    ]);
    const calls = scanTranscript(path);
    expect(calls[0].duration_sec).toBeLessThanOrEqual(30 * 60);
    expect(calls[0].duration_sec).toBeGreaterThan(0);
  });
});

describe("listTranscripts + scanAllToArray", () => {
  it("walks projects/*/*.jsonl and reports progress", () => {
    // Build a projects-shaped fake dir: workDir/projects/<proj>/file.jsonl
    const projectsRoot = join(workDir, "projects");
    const proj = join(projectsRoot, "proj-a");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, "session.jsonl"),
      jsonl([
        userMsg("go"),
        skillToolUse("toolu_a", "demo-skill", "2026-05-28T10:00:01Z"),
        userMsg("thanks"),
      ]),
    );

    const files = listTranscripts(projectsRoot);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/session\.jsonl$/);

    const seen: { index: number; total: number }[] = [];
    const calls = scanAllToArray(projectsRoot, (info) => seen.push(info));
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([{ index: 1, total: 1, file: files[0] }]);
  });
});
