"""SQLite storage for skill call records."""
from __future__ import annotations

import csv
import sqlite3
from dataclasses import asdict, fields
from pathlib import Path

from .scan import SkillCall

DB_PATH = Path.home() / ".claude" / "skills-usage" / "db.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS skill_calls (
    tool_use_id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    args TEXT,
    session_id TEXT,
    cwd TEXT,
    transcript_path TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_sec REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    error_count INTEGER,
    interrupted INTEGER,
    user_followup TEXT,
    user_followup_correction INTEGER,
    outcome TEXT,
    triggering_user_msg TEXT,
    hook_started_at TEXT,
    hook_ended_at TEXT,
    hook_duration_sec REAL,
    label TEXT,
    label_note TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_skill ON skill_calls(skill);
CREATE INDEX IF NOT EXISTS idx_started ON skill_calls(started_at);
CREATE INDEX IF NOT EXISTS idx_session ON skill_calls(session_id);
"""

# Columns we ingest from SkillCall (exclude hook_*/label_* which come from elsewhere)
SCAN_COLS = [f.name for f in fields(SkillCall)]


def _connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def upsert_calls(calls: list[SkillCall], db_path: Path = DB_PATH) -> tuple[int, int]:
    """Insert or update calls keyed by tool_use_id. Returns (inserted, updated)."""
    conn = _connect(db_path)
    inserted = updated = 0
    try:
        cur = conn.cursor()
        for c in calls:
            d = asdict(c)
            # Booleans → ints
            d["interrupted"] = int(d["interrupted"])
            d["user_followup_correction"] = int(d["user_followup_correction"])

            cols = SCAN_COLS
            placeholders = ",".join("?" for _ in cols)
            updates = ",".join(f"{k}=excluded.{k}" for k in cols if k != "tool_use_id")

            existed = cur.execute(
                "SELECT 1 FROM skill_calls WHERE tool_use_id=?", (c.tool_use_id,)
            ).fetchone()

            cur.execute(
                f"INSERT INTO skill_calls ({','.join(cols)}) VALUES ({placeholders}) "
                f"ON CONFLICT(tool_use_id) DO UPDATE SET {updates}, updated_at=CURRENT_TIMESTAMP",
                tuple(d[k] for k in cols),
            )
            if existed:
                updated += 1
            else:
                inserted += 1
        conn.commit()
    finally:
        conn.close()
    return inserted, updated


def fetch_all(db_path: Path = DB_PATH, since_days: int | None = None, skill: str | None = None) -> list[sqlite3.Row]:
    conn = _connect(db_path)
    try:
        q = "SELECT * FROM skill_calls"
        clauses, params = [], []
        if since_days:
            clauses.append("started_at >= datetime('now', ?)")
            params.append(f"-{since_days} days")
        if skill:
            clauses.append("skill LIKE ?")
            params.append(f"%{skill}%")
        if clauses:
            q += " WHERE " + " AND ".join(clauses)
        q += " ORDER BY started_at DESC"
        return conn.execute(q, params).fetchall()
    finally:
        conn.close()


def export_csv(out_path: Path, db_path: Path = DB_PATH) -> int:
    rows = fetch_all(db_path)
    if not rows:
        return 0
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        for r in rows:
            writer.writerow(dict(r))
    return len(rows)


def set_label(tool_use_id: str, label: str, note: str = "", db_path: Path = DB_PATH) -> bool:
    conn = _connect(db_path)
    try:
        cur = conn.execute(
            "UPDATE skill_calls SET label=?, label_note=?, updated_at=CURRENT_TIMESTAMP WHERE tool_use_id=?",
            (label, note, tool_use_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def fetch_unlabeled(limit: int | None = None, db_path: Path = DB_PATH) -> list[sqlite3.Row]:
    conn = _connect(db_path)
    try:
        q = "SELECT * FROM skill_calls WHERE label IS NULL ORDER BY started_at DESC"
        if limit:
            q += f" LIMIT {int(limit)}"
        return conn.execute(q).fetchall()
    finally:
        conn.close()
