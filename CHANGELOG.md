## 0.1.0 (2026-05-28)

* Initial release
* Transcript scanner that extracts Skill invocations from `~/.claude/projects/*.jsonl`
* SQLite-backed report (`skills-usage report`) with per-skill calls, OK/Fail/?, avg/total duration, tokens, errors
* One-shot setup (`skills-usage setup`) — installs Pre/PostToolUse hooks for the Skill tool, ingests history, prints report
* Manual outcome labeling (`skills-usage mark`)
* CSV export (`skills-usage export-csv`)
* One-key uninstall (`skills-usage uninstall`) — removes hooks, deletes data dir, cleans backups
