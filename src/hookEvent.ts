#!/usr/bin/env node
// Hook handler invoked by Claude Code on PreToolUse/PostToolUse for the Skill tool.
// Reads hook JSON from stdin, appends one line to ~/.claude/skills-usage/hook-events.jsonl.
// Always exits 0 — observability hooks must not interfere with normal tool flow.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_PATH = join(homedir(), ".claude", "skills-usage", "hook-events.jsonl");

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

(async () => {
  let raw = "";
  try { raw = await readStdin(); } catch { process.exit(0); }
  if (!raw.trim()) process.exit(0);

  let payload: any;
  try { payload = JSON.parse(raw); } catch (e) {
    process.stderr.write(`skills-usage hook: parse error: ${e}\n`);
    process.exit(0);
  }

  if (payload?.tool_name !== "Skill") process.exit(0);

  const record = {
    received_at: new Date().toISOString(),
    hook_event_name: payload.hook_event_name,
    tool_use_id: payload.tool_use_id,
    session_id: payload.session_id,
    cwd: payload.cwd,
    transcript_path: payload.transcript_path,
    skill: payload.tool_input?.skill,
    args: payload.tool_input?.args,
    duration_ms: payload.duration_ms,
    tool_response: payload.tool_response,
  };

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    process.stderr.write(`skills-usage hook: write error: ${e}\n`);
  }
  process.exit(0);
})();
