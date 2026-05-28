"""Ingest hook-events.jsonl produced by hooks/skill_event.py and join into DB."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from . import db as dbmod

HOOK_EVENTS_PATH = Path.home() / ".claude" / "skills-usage" / "hook-events.jsonl"


def _parse_iso(s: str | None):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def ingest_hook_events(path: Path = HOOK_EVENTS_PATH, db_path: Path = dbmod.DB_PATH) -> tuple[int, int, int]:
    """Read hook-events.jsonl and update skill_calls with hook_started_at/ended_at/duration.

    Returns (events_read, calls_updated, calls_skipped_no_match).
    """
    if not path.exists():
        return 0, 0, 0

    # Group events by tool_use_id
    pre_at: dict[str, str] = {}
    post_at: dict[str, str] = {}
    durations: dict[str, int] = {}

    events = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            events += 1
            tid = e.get("tool_use_id")
            if not tid:
                continue
            ev = e.get("hook_event_name")
            if ev == "PreToolUse":
                # Earliest Pre wins
                if tid not in pre_at or e.get("received_at", "") < pre_at[tid]:
                    pre_at[tid] = e.get("received_at", "")
            elif ev == "PostToolUse":
                # Latest Post wins
                if tid not in post_at or e.get("received_at", "") > post_at[tid]:
                    post_at[tid] = e.get("received_at", "")
                if (d := e.get("duration_ms")) is not None:
                    durations[tid] = int(d)

    updated = skipped = 0
    conn = dbmod._connect(db_path)
    try:
        cur = conn.cursor()
        all_ids = set(pre_at) | set(post_at)
        for tid in all_ids:
            t0 = pre_at.get(tid)
            t1 = post_at.get(tid)
            dur_sec = None
            if tid in durations:
                dur_sec = durations[tid] / 1000.0
            elif t0 and t1:
                p0, p1 = _parse_iso(t0), _parse_iso(t1)
                if p0 and p1:
                    dur_sec = (p1 - p0).total_seconds()

            res = cur.execute(
                "UPDATE skill_calls SET hook_started_at=?, hook_ended_at=?, hook_duration_sec=?, updated_at=CURRENT_TIMESTAMP "
                "WHERE tool_use_id=?",
                (t0, t1, dur_sec, tid),
            )
            if res.rowcount > 0:
                updated += 1
            else:
                skipped += 1
        conn.commit()
    finally:
        conn.close()

    return events, updated, skipped


if __name__ == "__main__":
    e, u, s = ingest_hook_events()
    print(f"hook events: {e}, calls updated: {u}, skipped (no transcript yet): {s}")
