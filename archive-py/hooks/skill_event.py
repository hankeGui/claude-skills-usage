#!/usr/bin/env python3
"""Hook handler for Skill PreToolUse/PostToolUse events.

Reads hook JSON from stdin and appends one line to ~/.claude/skills-usage/hook-events.jsonl.
Designed to be invoked as `async: true` so it never blocks the agent.

Always exits 0 — observability hooks must not interfere with normal tool flow.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = Path.home() / ".claude" / "skills-usage" / "hook-events.jsonl"


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return 0
        payload = json.loads(raw)
    except Exception as e:
        sys.stderr.write(f"skills-usage hook: parse error: {e}\n")
        return 0

    # Only care about Skill tool
    if payload.get("tool_name") != "Skill":
        return 0

    record = {
        "received_at": datetime.now(timezone.utc).isoformat(),
        "hook_event_name": payload.get("hook_event_name"),
        "tool_use_id": payload.get("tool_use_id"),
        "session_id": payload.get("session_id"),
        "cwd": payload.get("cwd"),
        "transcript_path": payload.get("transcript_path"),
        "skill": (payload.get("tool_input") or {}).get("skill"),
        "args": (payload.get("tool_input") or {}).get("args"),
        "duration_ms": payload.get("duration_ms"),
        "tool_response": payload.get("tool_response"),
    }

    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        sys.stderr.write(f"skills-usage hook: write error: {e}\n")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
