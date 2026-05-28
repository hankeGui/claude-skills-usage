## 0.2.0 (2026-05-28)

* **Fix**: hook script copied to permanent location `~/.claude/skills-usage/bin/hookEvent.js` so settings.json no longer references npx cache paths that npm may garbage-collect (closes "hook didn't start after using npx")
* **Report**: new `Src` column distinguishes user / project / plugin skills; same skill name from different sources is grouped separately
* **Report**: new `--by-cwd` flag breaks down skills usage per working directory
* **DB**: schema adds `source` column (idempotent migration on existing DBs)
* **Tests**: vitest suite covering scan, db, hookInstall (23 tests)

## 0.1.0 (2026-05-28)

* Initial release
* Transcript scanner that extracts Skill invocations from `~/.claude/projects/*.jsonl`
* SQLite-backed report (`skills-usage report`) with per-skill calls, OK/Fail/?, avg/total duration, tokens, errors
* One-shot setup (`skills-usage setup`) — installs Pre/PostToolUse hooks for the Skill tool, ingests history, prints report
* Manual outcome labeling (`skills-usage mark`)
* CSV export (`skills-usage export-csv`)
* One-key uninstall (`skills-usage uninstall`) — removes hooks, deletes data dir, cleans backups
