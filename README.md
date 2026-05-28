# claude-skills-usage

Track and analyze [Claude Code](https://docs.claude.com/en/docs/claude-code) Skill invocations: frequency, latency, token cost, triggering prompts, and success/failure outcome.

```
$ npx claude-skills-usage report

  Skills Usage Report  (88 calls, 55 solved, 15 failed across 26 skills)

Skill                  Calls   OK Fail    ?     Avg   Total   Tokens  Err
sap-jira                  15   12    0    3   10.9m    2.5h    57.4M   16
sap-loki                  12    9    3    0   11.9m    2.4h    41.3M   15
sap-msteams               12    5    4    3   10.5m    2.1h    22.4M   21
playwright-cli             6    5    1    0   21.5m    2.2h     3.0M    5
...
```

## Install

```bash
# one-shot run, no install
npx claude-skills-usage report

# global install
npm install -g claude-skills-usage
skills-usage report
```

Both `skills-usage` and `claude-skills-usage` are exposed as commands.

## Quick start

```bash
# scan ~/.claude/projects/*.jsonl into ~/.claude/skills-usage/db.sqlite
skills-usage ingest

# print summary
skills-usage report
skills-usage report --since 30 --triggers --top 5

# export to spreadsheet
skills-usage export-csv ~/skills.csv

# label outcomes by hand (sharpens the heuristic)
skills-usage mark
skills-usage mark --id toolu_bdrk_XYZ --label solved

# install live hooks for precise timing (optional)
skills-usage enable-hook
skills-usage hook-status
skills-usage disable-hook
```

## What it captures

For every Skill invocation found in your transcripts:

- **Skill name + args** the agent passed
- **Triggering user prompt** (the most recent real user message before the call)
- **Wall-clock duration** (capped at 30min so idle gaps don't skew totals)
- **Tokens** input/output/cache-read/cache-creation, summed across the entire flow
- **Errors** count of `is_error: true` tool results during the flow
- **Interrupted** whether the user typed Esc / interrupted the agent
- **User followup** the next real user message after the flow ended
- **Outcome** heuristic: `likely_solved` / `likely_failed` / `unknown`

The heuristic is intentionally simple:

| Signal | Outcome |
|---|---|
| User interrupted, OR followup contains correction words ("不对", "stop", "wrong", …) | `likely_failed` |
| ≥3 errors in the flow with no followup | `likely_failed` |
| Any non-corrective followup | `likely_solved` |
| No followup at all (session ended) | `unknown` |

Use `skills-usage mark` to override with ground truth — labels always win in the report, and the report also shows heuristic-vs-truth agreement to gauge accuracy.

## Live hooks (optional, more precise)

`skills-usage enable-hook` adds `PreToolUse` + `PostToolUse` hooks to `~/.claude/settings.json` matching only the `Skill` tool. They append one line per event to `~/.claude/skills-usage/hook-events.jsonl`, which `ingest` joins into the DB to give precise per-call duration that the transcript can't (transcripts only carry timestamps for assistant turns).

The installer:

- Backs up your settings file with a timestamped `.bak.YYYYMMDD-HHMMSS` suffix on every run
- Keeps a permanent pristine snapshot at `~/.claude/settings.json.pre-skills-usage.bak`
- Is **idempotent** — running it twice doesn't duplicate hooks
- Uses `async: true` so the hook never blocks Claude
- Removes only its own entries on `disable-hook` (identified by an `_id` marker)

`--scope user` (default) writes to `~/.claude/settings.json` (all sessions).
`--scope project` writes to `./.claude/settings.json` (committed).
`--scope local` writes to `./.claude/settings.local.json` (gitignored).

## Data lives at

| Path | What |
|---|---|
| `~/.claude/skills-usage/db.sqlite` | All ingested call records |
| `~/.claude/skills-usage/hook-events.jsonl` | Raw hook log (only with hooks enabled) |
| `~/.claude/settings.json.pre-skills-usage.bak` | First pristine backup of your settings |
| `~/.claude/settings.json.bak.<TIMESTAMP>` | Per-edit backups |

Wipe the lot with `rm -rf ~/.claude/skills-usage`.

## Requirements

Node ≥ 18. The package depends on `better-sqlite3` (precompiled binaries via npm).

## License

MIT
