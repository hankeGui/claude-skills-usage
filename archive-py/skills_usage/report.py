"""CLI report for Skill usage."""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from dataclasses import asdict

from .scan import scan_all, SkillCall, _parse_ts


def _fmt_dur(sec: float | None) -> str:
    if not sec:
        return "  -  "
    if sec < 60:
        return f"{sec:5.1f}s"
    if sec < 3600:
        return f"{sec/60:5.1f}m"
    return f"{sec/3600:5.1f}h"


def _fmt_tok(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1e6:.1f}M"
    if n >= 1_000:
        return f"{n/1e3:.1f}k"
    return str(n)


def _filter(calls: list[SkillCall], since_days: int | None, skill_filter: str | None) -> list[SkillCall]:
    if skill_filter:
        calls = [c for c in calls if skill_filter.lower() in c.skill.lower()]
    if since_days:
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
        out = []
        for c in calls:
            t = _parse_ts(c.started_at)
            if t and t >= cutoff:
                out.append(c)
        calls = out
    return calls


def report_summary(calls: list[SkillCall]) -> None:
    if not calls:
        print("No Skill calls found.")
        return

    by_skill: dict[str, list[SkillCall]] = defaultdict(list)
    for c in calls:
        by_skill[c.skill].append(c)

    rows = []
    for skill, group in by_skill.items():
        n = len(group)
        solved = sum(1 for c in group if c.outcome == "likely_solved")
        failed = sum(1 for c in group if c.outcome == "likely_failed")
        unknown = sum(1 for c in group if c.outcome == "unknown")
        durs = [c.duration_sec for c in group if c.duration_sec]
        avg_dur = sum(durs) / len(durs) if durs else 0.0
        total_dur = sum(durs)
        total_tok = sum(c.input_tokens + c.output_tokens for c in group)
        errors = sum(c.error_count for c in group)
        rows.append({
            "skill": skill, "n": n, "solved": solved, "failed": failed, "unknown": unknown,
            "avg_dur": avg_dur, "total_dur": total_dur, "total_tok": total_tok, "errors": errors,
        })

    rows.sort(key=lambda r: r["n"], reverse=True)

    total_n = sum(r["n"] for r in rows)
    total_solved = sum(r["solved"] for r in rows)
    total_failed = sum(r["failed"] for r in rows)

    print(f"\n{'='*98}")
    print(f"  Skills Usage Report  ({total_n} calls, {total_solved} solved, {total_failed} failed across {len(rows)} skills)")
    print(f"{'='*98}\n")
    print(f"{'Skill':<22} {'Calls':>5} {'OK':>4} {'Fail':>4} {'?':>4} {'Avg':>7} {'Total':>7} {'Tokens':>8} {'Err':>4}")
    print("-" * 98)
    for r in rows:
        print(
            f"{r['skill']:<22} {r['n']:>5d} {r['solved']:>4d} {r['failed']:>4d} {r['unknown']:>4d} "
            f"{_fmt_dur(r['avg_dur']):>7} {_fmt_dur(r['total_dur']):>7} {_fmt_tok(r['total_tok']):>8} {r['errors']:>4d}"
        )
    print()


def report_triggers(calls: list[SkillCall], top_n: int = 3) -> None:
    by_skill: dict[str, list[SkillCall]] = defaultdict(list)
    for c in calls:
        by_skill[c.skill].append(c)

    print(f"\n{'='*98}")
    print(f"  Top {top_n} triggering prompts per skill")
    print(f"{'='*98}\n")
    for skill in sorted(by_skill, key=lambda s: -len(by_skill[s])):
        group = by_skill[skill]
        print(f"▸ {skill} ({len(group)} calls)")
        # Use most recent first as a proxy for relevance; one-line each.
        seen = set()
        shown = 0
        for c in sorted(group, key=lambda x: x.started_at, reverse=True):
            msg = (c.triggering_user_msg or "").strip().replace("\n", " ")
            if not msg or msg in seen:
                continue
            seen.add(msg)
            short = msg[:120] + ("…" if len(msg) > 120 else "")
            tag = {"likely_solved": "✓", "likely_failed": "✗", "unknown": "·"}[c.outcome]
            print(f"    {tag}  {short}")
            shown += 1
            if shown >= top_n:
                break
        print()


def report_sessions(calls: list[SkillCall]) -> None:
    by_session: dict[str, list[SkillCall]] = defaultdict(list)
    for c in calls:
        by_session[c.session_id].append(c)

    print(f"\n{'='*98}")
    print(f"  Sessions ({len(by_session)} sessions with Skill use)")
    print(f"{'='*98}\n")
    rows = []
    for sid, group in by_session.items():
        skills = [c.skill for c in group]
        ok = sum(1 for c in group if c.outcome == "likely_solved")
        fail = sum(1 for c in group if c.outcome == "likely_failed")
        first_ts = min(c.started_at for c in group)
        cwd = group[0].cwd
        rows.append((first_ts, sid, len(group), ok, fail, cwd, skills))
    rows.sort(reverse=True)
    for ts, sid, n, ok, fail, cwd, skills in rows[:30]:
        date = ts[:10] if ts else "?"
        cwd_short = cwd.replace("/Users/I547149/", "~/")
        skills_str = ",".join(dict.fromkeys(skills))[:40]
        print(f"  {date}  {sid[:8]}  n={n:2d} ok={ok} fail={fail}  {cwd_short:<35}  [{skills_str}]")
    print()


def main() -> None:
    ap = argparse.ArgumentParser(prog="skills-usage")
    ap.add_argument("--since", type=int, default=None, metavar="DAYS", help="Only include calls from the last N days")
    ap.add_argument("--skill", type=str, default=None, help="Filter to a specific skill (substring match)")
    ap.add_argument("--top", type=int, default=3, help="How many triggering prompts to show per skill")
    ap.add_argument("--sessions", action="store_true", help="Also show recent sessions")
    ap.add_argument("--triggers", action="store_true", help="Show triggering prompts per skill")
    ap.add_argument("--json", action="store_true", help="Dump raw scan results as JSON")
    args = ap.parse_args()

    calls = list(scan_all())
    calls = _filter(calls, args.since, args.skill)

    if args.json:
        print(json.dumps([asdict(c) for c in calls], ensure_ascii=False, indent=2))
        return

    report_summary(calls)
    if args.triggers:
        report_triggers(calls, args.top)
    if args.sessions:
        report_sessions(calls)


if __name__ == "__main__":
    main()
