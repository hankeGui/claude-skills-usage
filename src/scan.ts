import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

const SKILL_INJECTION_MARKERS = [
  "Base directory for this skill:",
  "<command-name>",
  "<system-reminder>",
  "<task-notification>",
  "<local-command-caveat>",
  "[Request interrupted by user for tool use]",
  "This session is being continued from a previous conversation",
  "Caveat: The messages below were generated",
];

const CORRECTION_MARKERS = [
  "不对", "错了", "不是这样", "重来", "重新", "再试", "再来", "撤销",
  "stop", "wrong", "no,", "no.", "not what", "undo", "revert",
  "[Request interrupted by user]",
];

const DURATION_CAP_SEC = 30 * 60;

export type Outcome = "likely_solved" | "likely_failed" | "unknown";

export interface SkillCall {
  skill: string;
  args: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_use_id: string;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  error_count: number;
  interrupted: boolean;
  user_followup: string;
  user_followup_correction: boolean;
  outcome: Outcome;
  triggering_user_msg: string;
}

interface JsonlEntry {
  type?: string;
  message?: { role?: string; content?: unknown; usage?: Record<string, number> };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") parts.push(inner);
      else if (Array.isArray(inner)) {
        for (const ic of inner) {
          if (ic && typeof ic === "object" && (ic as any).type === "text") {
            parts.push((ic as any).text ?? "");
          }
        }
      }
    }
  }
  return parts.join("\n");
}

function isRealUserMsg(entry: JsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object") {
        const block = c as Record<string, unknown>;
        if (block.type === "tool_result") return false;
        if (block.type === "text" && typeof block.text === "string") text += block.text;
      }
    }
  } else {
    return false;
  }
  const stripped = text.trim();
  if (!stripped) return false;
  const head = stripped.slice(0, 200);
  if (SKILL_INJECTION_MARKERS.some((m) => head.includes(m))) return false;
  if (stripped === "[Request interrupted by user]") return false;
  return true;
}

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function findTriggeringUserMsg(entries: JsonlEntry[], skillIdx: number): string {
  for (let j = skillIdx - 1; j >= 0; j--) {
    if (isRealUserMsg(entries[j])) {
      return extractText(entries[j].message?.content).slice(0, 500);
    }
  }
  return "";
}

function hasCorrectionSignal(text: string): boolean {
  if (!text) return false;
  const low = text.toLowerCase();
  return CORRECTION_MARKERS.some((m) => low.includes(m.toLowerCase()));
}

function classifyOutcome(call: SkillCall): Outcome {
  if (call.interrupted) return "likely_failed";
  if (call.user_followup_correction) return "likely_failed";
  if (call.error_count >= 3 && !call.user_followup) return "likely_failed";
  if (call.user_followup) return "likely_solved";
  return "unknown";
}

export function scanTranscript(path: string): SkillCall[] {
  let entries: JsonlEntry[];
  try {
    const raw = readFileSync(path, "utf-8");
    entries = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as JsonlEntry; } catch { return null; }
      })
      .filter((e): e is JsonlEntry => e !== null);
  } catch {
    return [];
  }

  const calls: SkillCall[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const usage = e.message?.usage ?? {};

    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const block = c as Record<string, unknown>;
      if (block.type !== "tool_use" || block.name !== "Skill") continue;

      const input = (block.input as Record<string, unknown>) ?? {};
      const call: SkillCall = {
        skill: String(input.skill ?? ""),
        args: String(input.args ?? "").slice(0, 500),
        session_id: String(e.sessionId ?? ""),
        cwd: String(e.cwd ?? ""),
        transcript_path: path,
        tool_use_id: String(block.id ?? ""),
        started_at: String(e.timestamp ?? ""),
        ended_at: null,
        duration_sec: null,
        input_tokens: Number(usage.input_tokens ?? 0),
        output_tokens: Number(usage.output_tokens ?? 0),
        cache_read_tokens: Number(usage.cache_read_input_tokens ?? 0),
        cache_creation_tokens: Number(usage.cache_creation_input_tokens ?? 0),
        error_count: 0,
        interrupted: false,
        user_followup: "",
        user_followup_correction: false,
        outcome: "unknown",
        triggering_user_msg: findTriggeringUserMsg(entries, i),
      };

      // Find boundary: next real user msg OR next different Skill tool_use
      let endIdx = entries.length - 1;
      outer: for (let j = i + 1; j < entries.length; j++) {
        const ne = entries[j];
        if (isRealUserMsg(ne)) { endIdx = j; break; }
        const ncontent = ne.message?.content;
        if (Array.isArray(ncontent)) {
          for (const nc of ncontent) {
            if (
              nc && typeof nc === "object" &&
              (nc as any).type === "tool_use" && (nc as any).name === "Skill" &&
              (nc as any).id !== call.tool_use_id
            ) {
              endIdx = j - 1;
              break outer;
            }
          }
        }
      }

      let lastTs = call.started_at;
      for (let j = i; j <= endIdx; j++) {
        const ej = entries[j];
        const ejmsg = ej.message ?? {};
        if (ej.type === "assistant" && j > i) {
          const u = ejmsg.usage ?? {};
          call.input_tokens += Number(u.input_tokens ?? 0);
          call.output_tokens += Number(u.output_tokens ?? 0);
          call.cache_read_tokens += Number(u.cache_read_input_tokens ?? 0);
          call.cache_creation_tokens += Number(u.cache_creation_input_tokens ?? 0);
        }
        const ejcontent = ejmsg.content;
        if (Array.isArray(ejcontent)) {
          for (const cb of ejcontent) {
            if (!cb || typeof cb !== "object") continue;
            const blk = cb as Record<string, unknown>;
            if (blk.type === "tool_result" && blk.is_error) call.error_count += 1;
            if (blk.type === "text" && typeof blk.text === "string" &&
                blk.text.includes("[Request interrupted by user]")) {
              call.interrupted = true;
            }
          }
        }
        if (ej.timestamp) lastTs = ej.timestamp;
      }
      call.ended_at = lastTs;

      if (endIdx < entries.length && isRealUserMsg(entries[endIdx])) {
        const followup = extractText(entries[endIdx].message?.content).slice(0, 500);
        call.user_followup = followup;
        call.user_followup_correction = hasCorrectionSignal(followup);
      }

      const t0 = parseTs(call.started_at);
      const t1 = parseTs(call.ended_at);
      if (t0 !== null && t1 !== null) {
        const raw = (t1 - t0) / 1000;
        call.duration_sec = raw > 0 ? Math.min(raw, DURATION_CAP_SEC) : 0;
      }

      call.outcome = classifyOutcome(call);
      calls.push(call);
    }
  }

  return calls;
}

export function listTranscripts(projectsDir: string = PROJECTS_DIR): string[] {
  let projects: string[];
  try {
    projects = readdirSync(projectsDir).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const p of projects) {
    const dir = join(projectsDir, p);
    let stat;
    try { stat = statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { continue; }
    for (const f of files) out.push(join(dir, f));
  }
  return out;
}

export type ScanProgress = (info: { index: number; total: number; file: string }) => void;

export function scanAllToArray(
  projectsDir: string = PROJECTS_DIR,
  onProgress?: ScanProgress,
): SkillCall[] {
  const files = listTranscripts(projectsDir);
  const calls: SkillCall[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.({ index: i + 1, total: files.length, file: files[i] });
    for (const c of scanTranscript(files[i])) calls.push(c);
  }
  return calls;
}

export function* scanAll(projectsDir: string = PROJECTS_DIR): Generator<SkillCall> {
  for (const f of listTranscripts(projectsDir)) {
    yield* scanTranscript(f);
  }
}
