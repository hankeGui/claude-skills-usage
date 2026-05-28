import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
  closeSync, openSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hookInstall from "./hookInstall.js";

// hookInstall resolves HOOK_SCRIPT as a sibling of itself. In tests, vitest
// loads src/hookInstall.ts so HOOK_SCRIPT points to src/hookEvent.js — which
// doesn't exist. Touch a stub there to satisfy the existsSync() guard.
const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, "hookEvent.js");
let createdStub = false;

beforeAll(() => {
  if (!existsSync(STUB)) {
    closeSync(openSync(STUB, "w"));
    createdStub = true;
  }
});

afterAll(() => {
  if (createdStub) {
    try { unlinkSync(STUB); } catch {}
  }
});

let projectDir: string;
let settingsPath: string;

function settings(): any {
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hookinst-test-"));
  // .claude/settings.json gets written under projectDir for the "project" scope
  settingsPath = join(projectDir, ".claude", "settings.json");
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("hookInstall (project scope, isolated tmp dir)", () => {
  it("creates a settings.json with our Skill hooks under PreToolUse and PostToolUse", () => {
    hookInstall.install("project", projectDir);

    expect(existsSync(settingsPath)).toBe(true);
    const s = settings();

    expect(s.hooks.PreToolUse).toBeDefined();
    expect(s.hooks.PostToolUse).toBeDefined();
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const block = s.hooks[event].find((b: any) => b.matcher === "Skill");
      expect(block, `Skill block missing in ${event}`).toBeDefined();
      const hook = block.hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.async).toBe(true);
      expect(hook._id).toBe(hookInstall.HOOK_MARKER);
      expect(hook.command).toContain("hookEvent.js");
    }
  });

  it("is idempotent — installing twice does not duplicate", () => {
    hookInstall.install("project", projectDir);
    hookInstall.install("project", projectDir);
    const s = settings();
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const skillBlocks = s.hooks[event].filter((b: any) => b.matcher === "Skill");
      const ourHooks = skillBlocks.flatMap((b: any) => b.hooks).filter((h: any) => h._id === hookInstall.HOOK_MARKER);
      expect(ourHooks).toHaveLength(1);
    }
  });

  it("preserves pre-existing user hooks during install/uninstall", () => {
    // pre-seed an unrelated hook
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo pre-bash" }] },
          ],
        },
        otherSetting: "keep me",
      }),
    );

    hookInstall.install("project", projectDir);
    let s = settings();
    expect(s.otherSetting).toBe("keep me");
    // user's Bash hook still there
    const preBlocks = s.hooks.PreToolUse;
    expect(preBlocks.find((b: any) => b.matcher === "Bash")).toBeDefined();
    expect(preBlocks.find((b: any) => b.matcher === "Skill")).toBeDefined();

    // Uninstall removes ONLY our entries
    hookInstall.uninstall("project", projectDir);
    s = settings();
    expect(s.otherSetting).toBe("keep me");
    expect(s.hooks.PreToolUse.find((b: any) => b.matcher === "Bash")).toBeDefined();
    expect(s.hooks?.PreToolUse?.find((b: any) => b.matcher === "Skill")).toBeUndefined();
    expect(s.hooks?.PostToolUse?.find((b: any) => b.matcher === "Skill")).toBeUndefined();
  });

  it("creates a timestamped backup file on install when settings already existed", () => {
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ existing: true }));

    hookInstall.install("project", projectDir);

    const claudeDir = join(projectDir, ".claude");
    const backups = readdirSync(claudeDir).filter((f) => /^settings\.json\.bak\.\d{8}-\d{6}$/.test(f));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("uninstall on a fresh dir is a no-op (no settings.json present)", () => {
    expect(() => hookInstall.uninstall("project", projectDir)).not.toThrow();
    expect(existsSync(settingsPath)).toBe(false);
  });
});
