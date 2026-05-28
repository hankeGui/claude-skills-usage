"""Scan ~/.claude/projects/*.jsonl and extract Skill invocations with metrics."""
from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Iterator

PROJECTS_DIR = Path.home() / ".claude" / "projects"

CORRECTION_MARKERS = (
    "不对", "错了", "不是这样", "重来", "重新", "再试", "再来", "撤销",
    "stop", "wrong", "no,", "no.", "not what", "undo", "revert",
    "[Request interrupted by user]",
)


@dataclass
class SkillCall:
    skill: str
    args: str
    session_id: str
    cwd: str
    transcript_path: str
    tool_use_id: str
    started_at: str
    ended_at: str | None = None
    duration_sec: float | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    error_count: int = 0
    interrupted: bool = False
    user_followup: str = ""
    user_followup_correction: bool = False
    outcome: str = "unknown"  # likely_solved | likely_failed | unknown
    triggering_user_msg: str = ""


def _extract_text(msg_content) -> str:
    if isinstance(msg_content, str):
        return msg_content
    if isinstance(msg_content, list):
        parts = []
        for c in msg_content:
            if isinstance(c, dict):
                if c.get("type") == "text":
                    parts.append(c.get("text", ""))
                elif c.get("type") == "tool_result":
                    inner = c.get("content")
                    if isinstance(inner, str):
                        parts.append(inner)
                    elif isinstance(inner, list):
                        for ic in inner:
                            if isinstance(ic, dict) and ic.get("type") == "text":
                                parts.append(ic.get("text", ""))
        return "\n".join(parts)
    return ""


SKILL_INJECTION_MARKERS = (
    "Base directory for this skill:",
    "<command-name>",
    "<system-reminder>",
    "<task-notification>",
    "<local-command-caveat>",
    "[Request interrupted by user for tool use]",
    "This session is being continued from a previous conversation",
    "Caveat: The messages below were generated",
)


def _is_real_user_msg(entry: dict) -> bool:
    """True if it's a user-typed message (not tool_result, not skill injection, not interrupt-only)."""
    if entry.get("type") != "user":
        return False
    msg = entry.get("message") or {}
    content = msg.get("content")
    text = ""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                return False
            if isinstance(c, dict) and c.get("type") == "text":
                text += c.get("text", "")
    else:
        return False
    stripped = text.strip()
    if not stripped:
        return False
    # Skill SKILL.md injection: appears as a "user" message but is system-generated
    if any(m in stripped[:200] for m in SKILL_INJECTION_MARKERS):
        return False
    # Pure interrupt notice
    if stripped == "[Request interrupted by user]":
        return False
    return True


def _parse_ts(s: str) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _find_triggering_user_msg(entries: list[dict], skill_idx: int) -> str:
    """Walk backwards from the Skill tool_use to find the most recent real user message."""
    for j in range(skill_idx - 1, -1, -1):
        if _is_real_user_msg(entries[j]):
            return _extract_text(entries[j].get("message", {}).get("content"))[:500]
    return ""


DURATION_CAP_SEC = 30 * 60  # idle gaps beyond 30 min don't count toward Skill duration


def _classify_outcome(call: SkillCall) -> str:
    # Hard fail signals
    if call.interrupted:
        return "likely_failed"
    if call.user_followup_correction:
        return "likely_failed"
    # Many errors with no recovery → failed
    if call.error_count >= 3 and not call.user_followup:
        return "likely_failed"
    # User moved on with a non-corrective message → solved (even if errors mid-flow)
    if call.user_followup:
        return "likely_solved"
    return "unknown"


def _has_correction_signal(text: str) -> bool:
    if not text:
        return False
    low = text.lower()
    return any(m.lower() in low for m in CORRECTION_MARKERS)


def scan_transcript(path: Path) -> list[SkillCall]:
    try:
        with open(path, encoding="utf-8") as f:
            entries = [json.loads(l) for l in f if l.strip()]
    except Exception:
        return []

    calls: list[SkillCall] = []

    for i, e in enumerate(entries):
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        content = msg.get("content") or []
        if not isinstance(content, list):
            continue
        usage = msg.get("usage") or {}
        for c in content:
            if not (isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill"):
                continue
            inp = c.get("input") or {}
            call = SkillCall(
                skill=inp.get("skill", ""),
                args=str(inp.get("args", ""))[:500],
                session_id=e.get("sessionId", ""),
                cwd=e.get("cwd", ""),
                transcript_path=str(path),
                tool_use_id=c.get("id", ""),
                started_at=e.get("timestamp", ""),
                input_tokens=usage.get("input_tokens", 0),
                output_tokens=usage.get("output_tokens", 0),
                cache_read_tokens=usage.get("cache_read_input_tokens", 0),
                cache_creation_tokens=usage.get("cache_creation_input_tokens", 0),
                triggering_user_msg=_find_triggering_user_msg(entries, i),
            )

            # Walk forward: find boundary = next real user msg OR next Skill tool_use
            end_idx = len(entries) - 1
            for j in range(i + 1, len(entries)):
                ne = entries[j]
                if _is_real_user_msg(ne):
                    end_idx = j
                    break
                # Check for next Skill call
                nmsg = ne.get("message") or {}
                ncontent = nmsg.get("content") or []
                if isinstance(ncontent, list):
                    for nc in ncontent:
                        if isinstance(nc, dict) and nc.get("type") == "tool_use" and nc.get("name") == "Skill" and nc.get("id") != call.tool_use_id:
                            end_idx = j - 1
                            break
                    else:
                        continue
                    break

            # Tally tokens / errors / interrupts in [i, end_idx]
            last_ts = call.started_at
            for j in range(i, end_idx + 1):
                ej = entries[j]
                ejmsg = ej.get("message") or {}
                # Count assistant token usage that's part of this skill's flow
                if ej.get("type") == "assistant" and j > i:
                    u = ejmsg.get("usage") or {}
                    call.input_tokens += u.get("input_tokens", 0)
                    call.output_tokens += u.get("output_tokens", 0)
                    call.cache_read_tokens += u.get("cache_read_input_tokens", 0)
                    call.cache_creation_tokens += u.get("cache_creation_input_tokens", 0)
                # Count tool errors
                ejcontent = ejmsg.get("content")
                if isinstance(ejcontent, list):
                    for cb in ejcontent:
                        if isinstance(cb, dict) and cb.get("type") == "tool_result" and cb.get("is_error"):
                            call.error_count += 1
                        if isinstance(cb, dict) and cb.get("type") == "text":
                            if "[Request interrupted by user]" in cb.get("text", ""):
                                call.interrupted = True
                if ts := ej.get("timestamp"):
                    last_ts = ts
            call.ended_at = last_ts

            # User followup correction detection
            if end_idx < len(entries) and _is_real_user_msg(entries[end_idx]):
                followup = _extract_text(entries[end_idx].get("message", {}).get("content"))[:500]
                call.user_followup = followup
                call.user_followup_correction = _has_correction_signal(followup)

            # Duration with idle-gap cap
            t0 = _parse_ts(call.started_at)
            t1 = _parse_ts(call.ended_at) if call.ended_at else None
            if t0 and t1:
                raw = (t1 - t0).total_seconds()
                call.duration_sec = min(raw, DURATION_CAP_SEC) if raw > 0 else 0.0

            call.outcome = _classify_outcome(call)
            calls.append(call)

    return calls


def scan_all(projects_dir: Path = PROJECTS_DIR) -> Iterator[SkillCall]:
    for path in sorted(projects_dir.glob("*/*.jsonl")):
        yield from scan_transcript(path)


if __name__ == "__main__":
    import sys
    calls = list(scan_all())
    print(f"Found {len(calls)} Skill calls across {len(set(c.transcript_path for c in calls))} transcripts")
    if "--dump" in sys.argv:
        for c in calls[:5]:
            print(json.dumps(asdict(c), indent=2, ensure_ascii=False))
