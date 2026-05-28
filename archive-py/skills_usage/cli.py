"""CLI for skill-usage: ingest, report, export, mark."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from dataclasses import asdict
from pathlib import Path

from . import db as dbmod
from . import hook_install
from . import hooks_ingest
from .scan import scan_all, SkillCall, _parse_ts


# ─── formatting helpers ───────────────────────────────────────────────────────

def _fmt_dur(sec: float | None) -> str:
    if not sec:
        return "  -  "
    if sec < 60:
        return f"{sec:5.1f}s"
    if sec < 3600:
        return f"{sec/60:5.1f}m"
    return f"{sec/3600:5.1f}h"


def _fmt_tok(n: int) -> str:
    n = n or 0
    if n >= 1_000_000:
        return f"{n/1e6:.1f}M"
    if n >= 1_000:
        return f"{n/1e3:.1f}k"
    return str(n)


# ─── reporting (from DB rows) ─────────────────────────────────────────────────

def _row_outcome(r: sqlite3.Row) -> str:
    """Prefer human label over heuristic outcome."""
    return r["label"] if r["label"] else r["outcome"]


def report_summary(rows: list[sqlite3.Row]) -> None:
    if not rows:
        print("No Skill calls found. Run `skills-usage ingest` first.")
        return

    by_skill: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_skill[r["skill"]].append(r)

    out = []
    for skill, group in by_skill.items():
        n = len(group)
        solved = sum(1 for r in group if _row_outcome(r) in ("likely_solved", "solved"))
        failed = sum(1 for r in group if _row_outcome(r) in ("likely_failed", "failed"))
        unknown = n - solved - failed
        durs = [r["duration_sec"] for r in group if r["duration_sec"]]
        avg_dur = sum(durs) / len(durs) if durs else 0.0
        total_dur = sum(durs)
        total_tok = sum((r["input_tokens"] or 0) + (r["output_tokens"] or 0) for r in group)
        errors = sum(r["error_count"] or 0 for r in group)
        out.append((skill, n, solved, failed, unknown, avg_dur, total_dur, total_tok, errors))

    out.sort(key=lambda x: x[1], reverse=True)

    total_n = sum(x[1] for x in out)
    total_solved = sum(x[2] for x in out)
    total_failed = sum(x[3] for x in out)
    labeled = sum(1 for r in rows if r["label"])

    # Heuristic accuracy: among labeled rows, how often does the heuristic agree?
    matched = sum(
        1 for r in rows
        if r["label"] and (
            (r["label"] == "solved" and r["outcome"] == "likely_solved") or
            (r["label"] == "failed" and r["outcome"] == "likely_failed") or
            (r["label"] == "unknown" and r["outcome"] == "unknown")
        )
    )

    print(f"\n{'='*100}")
    title = f"  Skills Usage Report  ({total_n} calls, {total_solved} solved, {total_failed} failed across {len(out)} skills"
    if labeled:
        acc = (matched / labeled * 100) if labeled else 0
        title += f", {labeled} human-labeled, heuristic agrees {matched}/{labeled} = {acc:.0f}%"
    title += ")"
    print(title)
    print(f"{'='*100}\n")
    print(f"{'Skill':<22} {'Calls':>5} {'OK':>4} {'Fail':>4} {'?':>4} {'Avg':>7} {'Total':>7} {'Tokens':>8} {'Err':>4}")
    print("-" * 100)
    for skill, n, ok, fail, unk, avg, tot, tok, err in out:
        print(
            f"{skill:<22} {n:>5d} {ok:>4d} {fail:>4d} {unk:>4d} "
            f"{_fmt_dur(avg):>7} {_fmt_dur(tot):>7} {_fmt_tok(tok):>8} {err:>4d}"
        )
    print()


def report_triggers(rows: list[sqlite3.Row], top_n: int = 3) -> None:
    by_skill: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_skill[r["skill"]].append(r)

    print(f"\n{'='*100}")
    print(f"  Top {top_n} triggering prompts per skill")
    print(f"{'='*100}\n")
    for skill in sorted(by_skill, key=lambda s: -len(by_skill[s])):
        group = by_skill[skill]
        print(f"▸ {skill} ({len(group)} calls)")
        seen = set()
        shown = 0
        for r in sorted(group, key=lambda x: x["started_at"] or "", reverse=True):
            msg = (r["triggering_user_msg"] or "").strip().replace("\n", " ")
            if not msg or msg in seen:
                continue
            seen.add(msg)
            short = msg[:120] + ("…" if len(msg) > 120 else "")
            tag = {"likely_solved": "✓", "solved": "✓", "likely_failed": "✗", "failed": "✗"}.get(_row_outcome(r), "·")
            print(f"    {tag}  {short}")
            shown += 1
            if shown >= top_n:
                break
        print()


# ─── subcommands ──────────────────────────────────────────────────────────────

def cmd_ingest(args: argparse.Namespace) -> None:
    calls = list(scan_all())
    inserted, updated = dbmod.upsert_calls(calls)
    print(f"Ingested {len(calls)} calls → DB at {dbmod.DB_PATH}")
    print(f"  inserted: {inserted}, updated: {updated}")
    e, u, s = hooks_ingest.ingest_hook_events()
    if e or u or s:
        print(f"Hook events: {e} read, {u} calls enriched, {s} no-match (transcript may not be flushed yet)")


def cmd_report(args: argparse.Namespace) -> None:
    rows = dbmod.fetch_all(since_days=args.since, skill=args.skill)
    report_summary(rows)
    if args.triggers:
        report_triggers(rows, args.top)


def cmd_export(args: argparse.Namespace) -> None:
    out = Path(args.out)
    n = dbmod.export_csv(out)
    print(f"Wrote {n} rows → {out}")


def cmd_enable_hook(args: argparse.Namespace) -> None:
    hook_install.install(args.scope)


def cmd_disable_hook(args: argparse.Namespace) -> None:
    hook_install.uninstall(args.scope)


def cmd_hook_status(args: argparse.Namespace) -> None:
    hook_install.status(args.scope)


def cmd_mark(args: argparse.Namespace) -> None:
    if args.id and args.label:
        ok = dbmod.set_label(args.id, args.label, args.note or "")
        print(f"{'Updated' if ok else 'Not found'}: {args.id}")
        return

    rows = dbmod.fetch_unlabeled(limit=args.limit)
    if not rows:
        print("Nothing left to label.")
        return
    print(f"Labeling {len(rows)} unlabeled calls. Type s=solved / f=failed / u=unknown / x=skip / q=quit\n")
    for r in rows:
        print("─" * 80)
        print(f"  {r['skill']}  ({r['started_at']})  heuristic={r['outcome']}")
        print(f"  cwd: {r['cwd']}")
        print(f"  trigger: {(r['triggering_user_msg'] or '')[:200]}")
        print(f"  args:    {(r['args'] or '')[:200]}")
        print(f"  errors={r['error_count']} interrupted={bool(r['interrupted'])} dur={_fmt_dur(r['duration_sec'])}")
        followup = (r['user_followup'] or '').strip()
        if followup:
            print(f"  followup: {followup[:200]}")
        try:
            ans = input("  → ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nbye")
            return
        if ans == "q":
            return
        if ans == "x" or ans == "":
            continue
        label = {"s": "solved", "f": "failed", "u": "unknown"}.get(ans)
        if not label:
            print("  ?? skipped")
            continue
        dbmod.set_label(r["tool_use_id"], label)


# ─── argparse ─────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(prog="skills-usage")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest", help="Scan ~/.claude/projects and upsert into DB")
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("report", help="Print summary report from DB")
    p.add_argument("--since", type=int, default=None, metavar="DAYS")
    p.add_argument("--skill", type=str, default=None)
    p.add_argument("--triggers", action="store_true")
    p.add_argument("--top", type=int, default=3)
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("export-csv", help="Export DB to CSV")
    p.add_argument("out", help="Path to output CSV")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("enable-hook", help="Install Pre/PostToolUse hooks for the Skill tool")
    p.add_argument("--scope", choices=["user", "project", "local"], default="user",
                   help="user=~/.claude/settings.json (default), project=.claude/settings.json, local=.claude/settings.local.json")
    p.set_defaults(func=cmd_enable_hook)

    p = sub.add_parser("disable-hook", help="Remove our Skill hooks from settings")
    p.add_argument("--scope", choices=["user", "project", "local"], default="user")
    p.set_defaults(func=cmd_disable_hook)

    p = sub.add_parser("hook-status", help="Show whether hooks are installed in the chosen scope")
    p.add_argument("--scope", choices=["user", "project", "local"], default="user")
    p.set_defaults(func=cmd_hook_status)

    p = sub.add_parser("mark", help="Human-label call outcomes")
    p.add_argument("--id", help="tool_use_id to label (with --label)")
    p.add_argument("--label", choices=["solved", "failed", "unknown"])
    p.add_argument("--note", default="")
    p.add_argument("--limit", type=int, default=20, help="Interactive batch size")
    p.set_defaults(func=cmd_mark)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
