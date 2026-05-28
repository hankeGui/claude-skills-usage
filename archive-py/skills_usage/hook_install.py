"""Install/uninstall the Skill PreToolUse + PostToolUse hooks in ~/.claude/settings.json.

Idempotent. Each operation:
1. Backs up the current settings.json with a timestamped suffix (and updates
   ~/.claude/settings.json.pre-skills-usage.bak if missing).
2. Edits the JSON in-memory.
3. Atomically replaces settings.json via a temp-file + os.replace.

Honors --scope user|project|local. The CLI passes scope=user by default.
"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

HOOK_SCRIPT = Path(__file__).resolve().parent.parent / "hooks" / "skill_event.py"
PRISTINE_BACKUP = Path.home() / ".claude" / "settings.json.pre-skills-usage.bak"

# Marker so we can recognize and remove our own hooks unambiguously.
HOOK_MARKER = "skills-usage:skill-events"


@dataclass
class Scope:
    name: str       # "user" | "project" | "local"
    path: Path
    label: str


def resolve_scope(scope: str, project_dir: Path | None = None) -> Scope:
    home = Path.home()
    if scope == "user":
        return Scope("user", home / ".claude" / "settings.json", "~/.claude/settings.json")
    pd = project_dir or Path.cwd()
    if scope == "project":
        return Scope("project", pd / ".claude" / "settings.json", str(pd / ".claude/settings.json"))
    if scope == "local":
        return Scope("local", pd / ".claude" / "settings.local.json", str(pd / ".claude/settings.local.json"))
    raise ValueError(f"Unknown scope: {scope}")


def _build_hook_entry() -> dict:
    return {
        "matcher": "Skill",
        "hooks": [
            {
                "type": "command",
                "command": str(HOOK_SCRIPT),
                "async": True,
                "timeout": 5,
                # Custom marker — Claude Code ignores unknown keys, but they let us
                # find our entry on uninstall without depending on the path matching.
                "_id": HOOK_MARKER,
            }
        ],
    }


def _read_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"refusing to edit malformed settings file {path}: {e}")


def _write_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _backup(path: Path) -> Path | None:
    """Make a timestamped backup. Also keep the pristine backup if absent."""
    if not path.exists():
        return None
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    ts_backup = path.with_name(path.name + f".bak.{ts}")
    shutil.copy2(path, ts_backup)
    # First-time pristine backup (only for the user-scope file)
    if path == Path.home() / ".claude" / "settings.json" and not PRISTINE_BACKUP.exists():
        shutil.copy2(path, PRISTINE_BACKUP)
    return ts_backup


def _has_our_hook(entries: list, command: str) -> bool:
    for matcher_block in entries or []:
        if not isinstance(matcher_block, dict):
            continue
        if matcher_block.get("matcher") != "Skill":
            continue
        for h in matcher_block.get("hooks") or []:
            if isinstance(h, dict) and (h.get("_id") == HOOK_MARKER or h.get("command") == command):
                return True
    return False


def _strip_our_hook(entries: list, command: str) -> list:
    out = []
    for matcher_block in entries or []:
        if not isinstance(matcher_block, dict) or matcher_block.get("matcher") != "Skill":
            out.append(matcher_block)
            continue
        kept = [
            h for h in matcher_block.get("hooks") or []
            if not (isinstance(h, dict) and (h.get("_id") == HOOK_MARKER or h.get("command") == command))
        ]
        if kept:
            new_block = dict(matcher_block)
            new_block["hooks"] = kept
            out.append(new_block)
        # else: drop empty matcher block entirely
    return out


def install(scope: str = "user", project_dir: Path | None = None) -> None:
    if not HOOK_SCRIPT.exists():
        raise SystemExit(f"hook script not found: {HOOK_SCRIPT}")
    if not os.access(HOOK_SCRIPT, os.X_OK):
        # Best-effort: make it executable
        os.chmod(HOOK_SCRIPT, 0o755)

    s = resolve_scope(scope, project_dir)
    settings = _read_settings(s.path)
    hooks = settings.setdefault("hooks", {})
    entry = _build_hook_entry()

    actions = []
    for event in ("PreToolUse", "PostToolUse"):
        existing = hooks.setdefault(event, [])
        if _has_our_hook(existing, str(HOOK_SCRIPT)):
            actions.append(f"  {event}: already present")
            continue
        existing.append(entry)
        actions.append(f"  {event}: added")

    backup = _backup(s.path)
    _write_atomic(s.path, settings)

    print(f"✓ Hooks installed in {s.label} (scope: {s.name})")
    for line in actions:
        print(line)
    if backup:
        print(f"  Backup: {backup}")
    print(f"\n  Hook script: {HOOK_SCRIPT}")
    print(f"  Events log:  ~/.claude/skills-usage/hook-events.jsonl")
    print(f"\nDisable with: skills-usage disable-hook --scope {s.name}")


def uninstall(scope: str = "user", project_dir: Path | None = None) -> None:
    s = resolve_scope(scope, project_dir)
    if not s.path.exists():
        print(f"No settings file at {s.label}; nothing to remove.")
        return

    settings = _read_settings(s.path)
    hooks = settings.get("hooks") or {}
    if not hooks:
        print(f"No hooks block in {s.label}; nothing to remove.")
        return

    changed = False
    for event in ("PreToolUse", "PostToolUse"):
        before = hooks.get(event) or []
        after = _strip_our_hook(before, str(HOOK_SCRIPT))
        if after != before:
            changed = True
            if after:
                hooks[event] = after
            else:
                hooks.pop(event, None)

    if not changed:
        print(f"skills-usage hooks not found in {s.label}; nothing to remove.")
        return

    if not hooks:
        settings.pop("hooks", None)

    backup = _backup(s.path)
    _write_atomic(s.path, settings)
    print(f"✓ Hooks removed from {s.label}")
    if backup:
        print(f"  Backup: {backup}")


def status(scope: str = "user", project_dir: Path | None = None) -> None:
    s = resolve_scope(scope, project_dir)
    if not s.path.exists():
        print(f"{s.label}: file does not exist (no hook installed)")
        return
    settings = _read_settings(s.path)
    hooks = settings.get("hooks") or {}
    pre = _has_our_hook(hooks.get("PreToolUse") or [], str(HOOK_SCRIPT))
    post = _has_our_hook(hooks.get("PostToolUse") or [], str(HOOK_SCRIPT))
    state = "enabled" if (pre and post) else ("partial" if (pre or post) else "disabled")
    print(f"{s.label}: {state}")
    print(f"  PreToolUse:  {'✓' if pre else '·'}")
    print(f"  PostToolUse: {'✓' if post else '·'}")
    print(f"  Hook script: {HOOK_SCRIPT} ({'exists' if HOOK_SCRIPT.exists() else 'MISSING'})")
