import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the compiled hookEvent.js — sibling of this file in dist/
export const HOOK_SCRIPT = resolve(__dirname, "hookEvent.js");
export const PRISTINE_BACKUP = join(homedir(), ".claude", "settings.json.pre-skills-usage.bak");
export const HOOK_MARKER = "skills-usage:skill-events";

export type Scope = "user" | "project" | "local";

interface ScopeInfo { name: Scope; path: string; label: string; }

export function resolveScope(scope: Scope, projectDir: string = process.cwd()): ScopeInfo {
  const home = homedir();
  if (scope === "user") {
    return { name: "user", path: join(home, ".claude", "settings.json"), label: "~/.claude/settings.json" };
  }
  if (scope === "project") {
    const p = join(projectDir, ".claude", "settings.json");
    return { name: "project", path: p, label: p };
  }
  if (scope === "local") {
    const p = join(projectDir, ".claude", "settings.local.json");
    return { name: "local", path: p, label: p };
  }
  throw new Error(`Unknown scope: ${scope}`);
}

interface HookCommand { type: string; command: string; async?: boolean; timeout?: number; _id?: string; [k: string]: unknown; }
interface MatcherBlock { matcher: string; hooks: HookCommand[]; }
interface HooksConfig { PreToolUse?: MatcherBlock[]; PostToolUse?: MatcherBlock[]; [k: string]: MatcherBlock[] | undefined; }

function buildEntry(): MatcherBlock {
  // Use absolute path to the installed Node script. Node hooks need to be invoked
  // by node — chmod +x on a .js file isn't enough on every system, so we run via node.
  const command = `node ${HOOK_SCRIPT}`;
  return {
    matcher: "Skill",
    hooks: [
      {
        type: "command",
        command,
        async: true,
        timeout: 5,
        _id: HOOK_MARKER,
      },
    ],
  };
}

function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`refusing to edit malformed settings file ${path}: ${e}`);
  }
}

function writeAtomic(path: string, data: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const tsBackup = `${path}.bak.${ts}`;
  copyFileSync(path, tsBackup);
  if (path === join(homedir(), ".claude", "settings.json") && !existsSync(PRISTINE_BACKUP)) {
    copyFileSync(path, PRISTINE_BACKUP);
  }
  return tsBackup;
}

function hasOurHook(entries: MatcherBlock[] | undefined, command: string): boolean {
  if (!entries) return false;
  for (const block of entries) {
    if (block?.matcher !== "Skill") continue;
    for (const h of block.hooks ?? []) {
      if (h?._id === HOOK_MARKER) return true;
      if (h?.command === command) return true;
    }
  }
  return false;
}

function stripOurHook(entries: MatcherBlock[] | undefined, command: string): MatcherBlock[] {
  if (!entries) return [];
  const out: MatcherBlock[] = [];
  for (const block of entries) {
    if (block?.matcher !== "Skill") {
      out.push(block);
      continue;
    }
    const kept = (block.hooks ?? []).filter((h) => h?._id !== HOOK_MARKER && h?.command !== command);
    if (kept.length) out.push({ ...block, hooks: kept });
  }
  return out;
}

export function install(scope: Scope = "user", projectDir?: string): void {
  if (!existsSync(HOOK_SCRIPT)) {
    throw new Error(`hook script not found: ${HOOK_SCRIPT}\n(did the package's dist/ install correctly?)`);
  }
  // Best-effort make readable+executable, doesn't matter for `node script.js` invocation
  try { chmodSync(HOOK_SCRIPT, 0o755); } catch {}

  const s = resolveScope(scope, projectDir);
  const settings = readSettings(s.path);
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as HooksConfig;
  const entry = buildEntry();
  const cmd = entry.hooks[0].command;

  const actions: string[] = [];
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    if (!hooks[event]) hooks[event] = [];
    if (hasOurHook(hooks[event], cmd)) {
      actions.push(`  ${event}: already present`);
      continue;
    }
    hooks[event]!.push(entry);
    actions.push(`  ${event}: added`);
  }

  const bk = backup(s.path);
  writeAtomic(s.path, settings);

  console.log(`✓ Hooks installed in ${s.label} (scope: ${s.name})`);
  for (const line of actions) console.log(line);
  if (bk) console.log(`  Backup: ${bk}`);
  console.log(`\n  Hook script: ${HOOK_SCRIPT}`);
  console.log(`  Events log:  ~/.claude/skills-usage/hook-events.jsonl`);
  console.log(`\nDisable with: skills-usage disable-hook --scope ${s.name}`);
}

export function uninstall(scope: Scope = "user", projectDir?: string): void {
  const s = resolveScope(scope, projectDir);
  if (!existsSync(s.path)) {
    console.log(`No settings file at ${s.label}; nothing to remove.`);
    return;
  }
  const settings = readSettings(s.path);
  const hooks = settings.hooks as HooksConfig | undefined;
  if (!hooks) {
    console.log(`No hooks block in ${s.label}; nothing to remove.`);
    return;
  }

  const cmd = `node ${HOOK_SCRIPT}`;
  let changed = false;
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const before = hooks[event] ?? [];
    const after = stripOurHook(before, cmd);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed = true;
      if (after.length) hooks[event] = after;
      else delete hooks[event];
    }
  }
  if (!changed) {
    console.log(`skills-usage hooks not found in ${s.label}; nothing to remove.`);
    return;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  const bk = backup(s.path);
  writeAtomic(s.path, settings);
  console.log(`✓ Hooks removed from ${s.label}`);
  if (bk) console.log(`  Backup: ${bk}`);
}

export function status(scope: Scope = "user", projectDir?: string): void {
  const s = resolveScope(scope, projectDir);
  if (!existsSync(s.path)) {
    console.log(`${s.label}: file does not exist (no hook installed)`);
    return;
  }
  const settings = readSettings(s.path);
  const hooks = (settings.hooks ?? {}) as HooksConfig;
  const cmd = `node ${HOOK_SCRIPT}`;
  const pre = hasOurHook(hooks.PreToolUse, cmd);
  const post = hasOurHook(hooks.PostToolUse, cmd);
  const state = pre && post ? "enabled" : pre || post ? "partial" : "disabled";
  console.log(`${s.label}: ${state}`);
  console.log(`  PreToolUse:  ${pre ? "✓" : "·"}`);
  console.log(`  PostToolUse: ${post ? "✓" : "·"}`);
  console.log(`  Hook script: ${HOOK_SCRIPT} (${existsSync(HOOK_SCRIPT) ? "exists" : "MISSING"})`);
}
