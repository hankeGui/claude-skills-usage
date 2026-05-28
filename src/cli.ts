#!/usr/bin/env node
import { Command } from "commander";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

import { scanAllToArray, type SkillCall, type ScanProgress } from "./scan.js";
import * as db from "./db.js";
import * as hookInstall from "./hookInstall.js";
import { ingestHookEvents, HOOK_EVENTS_PATH } from "./hooksIngest.js";

// Read package.json for version (resolves at runtime relative to this file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let pkgVersion = "0.0.0";
try {
  pkgVersion = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
} catch {}

// ─── formatting helpers ───────────────────────────────────────────────────────

function fmtDur(sec: number | null | undefined): string {
  if (!sec) return "  -  ";
  if (sec < 60) return sec.toFixed(1).padStart(5) + "s";
  if (sec < 3600) return (sec / 60).toFixed(1).padStart(5) + "m";
  return (sec / 3600).toFixed(1).padStart(5) + "h";
}

function fmtTok(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function pad(s: string | number, n: number, right = false): string {
  const v = String(s);
  if (v.length >= n) return v;
  const padding = " ".repeat(n - v.length);
  return right ? padding + v : v + padding;
}

function rowOutcome(r: db.SkillRow): string {
  return r.label ?? r.outcome ?? "unknown";
}

// Tty-aware in-place progress writer. When stdout isn't a TTY (piped, CI),
// fall back to one line per N files so logs stay readable.
function makeProgressReporter(): { onProgress: ScanProgress; done: () => void } {
  const isTty = !!process.stdout.isTTY;
  let lastLen = 0;
  const onProgress: ScanProgress = ({ index, total, file }) => {
    const short = basename(file);
    const line = `  [${index}/${total}] ${short}`;
    if (isTty) {
      const padded = line.length < lastLen ? line + " ".repeat(lastLen - line.length) : line;
      process.stdout.write("\r" + padded);
      lastLen = line.length;
    } else if (index === total || index % 10 === 0 || index === 1) {
      process.stdout.write(line + "\n");
    }
  };
  const done = () => {
    if (isTty && lastLen > 0) {
      process.stdout.write("\r" + " ".repeat(lastLen) + "\r");
      lastLen = 0;
    }
  };
  return { onProgress, done };
}

// ─── reporting ────────────────────────────────────────────────────────────────

function reportSummary(rows: db.SkillRow[]): void {
  if (!rows.length) {
    console.log("No Skill calls found yet. Run `skills-usage setup` to ingest, install hooks, and report.");
    return;
  }

  const bySkill = new Map<string, db.SkillRow[]>();
  for (const r of rows) {
    const key = r.skill ?? "?";
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key)!.push(r);
  }

  type Row = { skill: string; n: number; ok: number; fail: number; unk: number; avg: number; tot: number; tok: number; err: number };
  const out: Row[] = [];
  for (const [skill, group] of bySkill) {
    const n = group.length;
    const ok = group.filter((r) => ["likely_solved", "solved"].includes(rowOutcome(r))).length;
    const fail = group.filter((r) => ["likely_failed", "failed"].includes(rowOutcome(r))).length;
    const unk = n - ok - fail;
    const durs = group.map((r) => r.duration_sec ?? 0).filter((d) => d > 0);
    const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
    const tot = durs.reduce((a, b) => a + b, 0);
    const tok = group.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
    const err = group.reduce((a, r) => a + (r.error_count ?? 0), 0);
    out.push({ skill, n, ok, fail, unk, avg, tot, tok, err });
  }
  out.sort((a, b) => b.n - a.n);

  const totalN = out.reduce((a, r) => a + r.n, 0);
  const totalOk = out.reduce((a, r) => a + r.ok, 0);
  const totalFail = out.reduce((a, r) => a + r.fail, 0);
  const labeled = rows.filter((r) => r.label).length;
  const matched = rows.filter((r) =>
    r.label &&
    ((r.label === "solved" && r.outcome === "likely_solved") ||
      (r.label === "failed" && r.outcome === "likely_failed") ||
      (r.label === "unknown" && r.outcome === "unknown")),
  ).length;

  const sep = "=".repeat(100);
  console.log("\n" + sep);
  let title = `  Skills Usage Report  (${totalN} calls, ${totalOk} solved, ${totalFail} failed across ${out.length} skills`;
  if (labeled) {
    const acc = (matched / labeled) * 100;
    title += `, ${labeled} human-labeled, heuristic agrees ${matched}/${labeled} = ${acc.toFixed(0)}%`;
  }
  title += ")";
  console.log(title);
  console.log(sep + "\n");
  console.log(
    pad("Skill", 22) + pad("Calls", 6, true) + pad("OK", 5, true) + pad("Fail", 5, true) +
    pad("?", 5, true) + pad("Avg", 8, true) + pad("Total", 8, true) +
    pad("Tokens", 9, true) + pad("Err", 5, true),
  );
  console.log("-".repeat(100));
  for (const r of out) {
    console.log(
      pad(r.skill, 22) + pad(r.n, 6, true) + pad(r.ok, 5, true) + pad(r.fail, 5, true) +
      pad(r.unk, 5, true) + pad(fmtDur(r.avg), 8, true) + pad(fmtDur(r.tot), 8, true) +
      pad(fmtTok(r.tok), 9, true) + pad(r.err, 5, true),
    );
  }
  console.log();
}

function reportTriggers(rows: db.SkillRow[], topN: number): void {
  const bySkill = new Map<string, db.SkillRow[]>();
  for (const r of rows) {
    const key = r.skill ?? "?";
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key)!.push(r);
  }
  const sep = "=".repeat(100);
  console.log("\n" + sep);
  console.log(`  Top ${topN} triggering prompts per skill`);
  console.log(sep + "\n");
  const skills = [...bySkill.keys()].sort((a, b) => bySkill.get(b)!.length - bySkill.get(a)!.length);
  for (const skill of skills) {
    const group = [...bySkill.get(skill)!].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
    console.log(`▸ ${skill} (${group.length} calls)`);
    const seen = new Set<string>();
    let shown = 0;
    for (const r of group) {
      const msg = (r.triggering_user_msg ?? "").trim().replace(/\n/g, " ");
      if (!msg || seen.has(msg)) continue;
      seen.add(msg);
      const short = msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
      const oc = rowOutcome(r);
      const tag = oc === "likely_solved" || oc === "solved" ? "✓" : oc === "likely_failed" || oc === "failed" ? "✗" : "·";
      console.log(`    ${tag}  ${short}`);
      shown += 1;
      if (shown >= topN) break;
    }
    console.log();
  }
}

// ─── core flows ───────────────────────────────────────────────────────────────

function doIngest(showProgress: boolean): { count: number } {
  console.log(`▸ Scanning transcripts in ~/.claude/projects ...`);
  const reporter = showProgress ? makeProgressReporter() : null;
  const t0 = Date.now();
  const calls: SkillCall[] = scanAllToArray(undefined, reporter?.onProgress);
  reporter?.done();
  const { inserted, updated } = db.upsertCalls(calls);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ✓ ${calls.length} skill calls (${inserted} new, ${updated} updated) in ${elapsed}s`);
  console.log(`    DB: ${db.DB_PATH}`);
  const { events, updated: u, skipped } = ingestHookEvents();
  if (events) {
    console.log(`  ✓ Hook events: ${events} read, ${u} calls enriched, ${skipped} no-match`);
  }
  return { count: calls.length };
}

function ynSync(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} ${suffix} `, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

// ─── subcommands ──────────────────────────────────────────────────────────────

function cmdIngest(): void {
  doIngest(true);
}

function cmdReport(opts: { since?: string; skill?: string; triggers?: boolean; top?: string }): void {
  const rows = db.fetchAll({
    sinceDays: opts.since ? parseInt(opts.since, 10) : undefined,
    skill: opts.skill,
  });
  reportSummary(rows);
  if (opts.triggers) reportTriggers(rows, opts.top ? parseInt(opts.top, 10) : 3);
}

async function cmdSetup(opts: { scope?: hookInstall.Scope; noHook?: boolean }): Promise<void> {
  const scope = opts.scope ?? "user";
  console.log("\n  Setting up claude-skills-usage\n");

  // 1) hook
  if (opts.noHook) {
    console.log("▸ Skipping hook install (--no-hook)");
  } else {
    console.log("▸ Installing Skill hooks (idempotent, with backup)");
    try {
      hookInstall.install(scope);
    } catch (e: any) {
      console.error(`  ! hook install failed: ${e?.message ?? e}`);
    }
  }

  // 2) ingest
  console.log();
  doIngest(true);

  // 3) report
  const rows = db.fetchAll({});
  reportSummary(rows);

  // 4) next-steps hint
  console.log("Next steps:");
  console.log("  skills-usage              → re-run scan + show report");
  console.log("  skills-usage report --triggers   → see what prompts trigger each skill");
  console.log("  skills-usage mark         → human-label outcomes");
  console.log("  skills-usage disable-hook → keep DB but remove hooks");
  console.log("  skills-usage uninstall    → wipe everything\n");
}

function cmdExport(out: string): void {
  const n = db.exportCsv(out);
  console.log(`Wrote ${n} rows → ${out}`);
}

async function cmdMark(opts: { id?: string; label?: string; note?: string; limit?: string }): Promise<void> {
  if (opts.id && opts.label) {
    const ok = db.setLabel(opts.id, opts.label, opts.note ?? "");
    console.log(`${ok ? "Updated" : "Not found"}: ${opts.id}`);
    return;
  }

  const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
  const rows = db.fetchUnlabeled(limit);
  if (!rows.length) {
    console.log("Nothing left to label.");
    return;
  }
  console.log(`Labeling ${rows.length} unlabeled calls. Type s=solved / f=failed / u=unknown / x=skip / q=quit\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  for (const r of rows) {
    console.log("─".repeat(80));
    console.log(`  ${r.skill}  (${r.started_at})  heuristic=${r.outcome}`);
    console.log(`  cwd: ${r.cwd}`);
    console.log(`  trigger: ${(r.triggering_user_msg ?? "").slice(0, 200)}`);
    console.log(`  args:    ${(r.args ?? "").slice(0, 200)}`);
    console.log(`  errors=${r.error_count} interrupted=${!!r.interrupted} dur=${fmtDur(r.duration_sec)}`);
    const followup = (r.user_followup ?? "").trim();
    if (followup) console.log(`  followup: ${followup.slice(0, 200)}`);
    let ans: string;
    try { ans = (await ask("  → ")).trim().toLowerCase(); }
    catch { rl.close(); return; }
    if (ans === "q") { rl.close(); return; }
    if (ans === "x" || ans === "") continue;
    const label = (({ s: "solved", f: "failed", u: "unknown" } as Record<string, string>)[ans]);
    if (!label) { console.log("  ?? skipped"); continue; }
    db.setLabel(r.tool_use_id, label);
  }
  rl.close();
}

function cmdEnableHook(opts: { scope?: hookInstall.Scope }): void {
  hookInstall.install(opts.scope ?? "user");
}

function cmdDisableHook(opts: { scope?: hookInstall.Scope }): void {
  hookInstall.uninstall(opts.scope ?? "user");
}

function cmdHookStatus(opts: { scope?: hookInstall.Scope }): void {
  hookInstall.status(opts.scope ?? "user");
}

// ─── uninstall ────────────────────────────────────────────────────────────────

const HOOK_BACKUP_RE = /\.bak\.\d{8}-\d{6}$/;

function findOurBackups(claudeDir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(claudeDir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith("settings.json") &&
        (HOOK_BACKUP_RE.test(name) || name === "settings.json.pre-skills-usage.bak")) {
      out.push(join(claudeDir, name));
    }
    if (name.startsWith("settings.local.json") && HOOK_BACKUP_RE.test(name)) {
      out.push(join(claudeDir, name));
    }
  }
  // also check project-local .claude/ in cwd
  return out;
}

async function cmdUninstall(opts: { yes?: boolean; scope?: hookInstall.Scope }): Promise<void> {
  const scope = opts.scope ?? "user";
  const home = homedir();
  const claudeDir = join(home, ".claude");
  const dataDir = join(claudeDir, "skills-usage");

  console.log("\n  Uninstall plan\n");

  // 1) hooks
  console.log(`  • Remove Skill hooks from settings.json (scope: ${scope})`);

  // 2) data dir
  let dataExists = false;
  let dataSize = 0;
  try {
    dataExists = statSync(dataDir).isDirectory();
    if (dataExists) {
      for (const f of readdirSync(dataDir)) {
        try { dataSize += statSync(join(dataDir, f)).size; } catch {}
      }
    }
  } catch {}
  if (dataExists) {
    console.log(`  • Delete ${dataDir} (${(dataSize / 1024).toFixed(1)} kB)`);
  } else {
    console.log(`  • ${dataDir} (none)`);
  }

  // 3) backups
  const backups = findOurBackups(claudeDir);
  if (backups.length) {
    console.log(`  • Delete ${backups.length} skills-usage backup file(s):`);
    for (const b of backups) console.log(`      ${b}`);
  } else {
    console.log(`  • Backups (none found)`);
  }

  console.log();
  if (!opts.yes) {
    const ok = await ynSync("Proceed?", false);
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // Execute
  console.log();
  try {
    hookInstall.uninstall(scope);
  } catch (e: any) {
    console.error(`  ! hook uninstall: ${e?.message ?? e}`);
  }

  if (dataExists) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      console.log(`✓ Removed ${dataDir}`);
    } catch (e: any) {
      console.error(`  ! could not delete ${dataDir}: ${e?.message ?? e}`);
    }
  }

  for (const b of backups) {
    try {
      unlinkSync(b);
      console.log(`✓ Removed ${b}`);
    } catch (e: any) {
      console.error(`  ! could not delete ${b}: ${e?.message ?? e}`);
    }
  }

  console.log();
  console.log("All skills-usage data removed. To remove the CLI itself, run one of:");
  console.log("  npm uninstall -g claude-skills-usage   (if installed via npm install -g)");
  console.log("  npm unlink -g claude-skills-usage      (if installed via npm link)");
  console.log();
}

// ─── default action: ingest + report ──────────────────────────────────────────

async function cmdDefault(): Promise<void> {
  const dbExists = existsSync(db.DB_PATH);
  if (!dbExists) {
    console.log("No data yet. Run `skills-usage setup` to install hooks, ingest transcripts, and see the report.");
    console.log("Or `skills-usage setup --no-hook` to skip the hook install.");
    return;
  }
  doIngest(true);
  const rows = db.fetchAll({});
  reportSummary(rows);
}

// ─── argparse ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("skills-usage")
  .description("Track and analyze Claude Code Skill invocations")
  .version(pkgVersion)
  .action(cmdDefault);

program.command("setup")
  .description("One-shot install: enable hooks + ingest transcripts + show report")
  .option("--scope <scope>", "user | project | local", "user")
  .option("--no-hook", "skip hook install (only ingest + report)")
  .action(cmdSetup);

program.command("ingest")
  .description("Scan ~/.claude/projects and upsert into DB")
  .action(cmdIngest);

program.command("report")
  .description("Print summary report from DB")
  .option("--since <days>", "only include calls from the last N days")
  .option("--skill <name>", "filter to a specific skill (substring match)")
  .option("--triggers", "show triggering prompts per skill")
  .option("--top <n>", "how many triggering prompts per skill", "3")
  .action(cmdReport);

program.command("export-csv")
  .description("Export DB to CSV")
  .argument("<out>", "path to output CSV")
  .action(cmdExport);

program.command("mark")
  .description("Human-label call outcomes (interactive or with --id/--label)")
  .option("--id <toolUseId>", "tool_use_id to label (use with --label)")
  .option("--label <label>", "solved | failed | unknown")
  .option("--note <text>", "optional note")
  .option("--limit <n>", "interactive batch size", "20")
  .action(cmdMark);

program.command("enable-hook")
  .description("Install Pre/PostToolUse hooks for the Skill tool")
  .option("--scope <scope>", "user | project | local", "user")
  .action(cmdEnableHook);

program.command("disable-hook")
  .description("Remove our Skill hooks from settings (keep DB)")
  .option("--scope <scope>", "user | project | local", "user")
  .action(cmdDisableHook);

program.command("hook-status")
  .description("Show whether hooks are installed in the chosen scope")
  .option("--scope <scope>", "user | project | local", "user")
  .action(cmdHookStatus);

program.command("uninstall")
  .description("Remove hooks, delete DB, clean up all backups (CLI binary stays)")
  .option("-y, --yes", "skip confirmation")
  .option("--scope <scope>", "user | project | local", "user")
  .action(cmdUninstall);

program.parseAsync().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
