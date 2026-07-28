#!/usr/bin/env python3
"""scripts/memory.py — Python stdlib sqlite3 wrapper for Kilo memory.db.

Usage:
  python scripts/memory.py check
  python scripts/memory.py query "<SELECT-or-WITH>"
  python scripts/memory.py exec "<INSERT/UPDATE/DELETE>"
  python scripts/memory.py exec-file <path.sql>

Exit codes:
  0  OK
  1  DEGRADED: memory.db not found
  2  SQL or argument error

Environment:
  KILO_MEMORY_DB   overrides the default database path.
  --db <path>      overrides KILO_MEMORY_DB and the default path.

Design constraints: only Python stdlib (sqlite3, argparse, pathlib, os, sys).
"""

import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path

# Force UTF-8 on Windows console to avoid GBK encoding errors.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


DEFAULT_DB_PATH = Path.home() / ".config" / "kilo-data" / "memory.db"


def resolve_db_path(cli_db: str | None) -> Path:
    if cli_db:
        return Path(cli_db).expanduser().resolve()
    env_db = os.environ.get("KILO_MEMORY_DB")
    if env_db:
        return Path(env_db).expanduser().resolve()
    return DEFAULT_DB_PATH


def _is_query(sql: str) -> bool:
    stripped = sql.strip().upper()
    return stripped.startswith("SELECT") or stripped.startswith("WITH")


def cmd_check(db_path: Path) -> int:
    if not db_path.exists():
        sys.stderr.write(f"[DEGRADED] memory.db not found at {db_path}\n")
        return 1

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        tables = [row[0] for row in cur.fetchall()]
    except sqlite3.Error as exc:
        sys.stderr.write(f"[ERROR] {exc}\n")
        return 2
    finally:
        conn.close()

    print(f"[OK] memory.db at {db_path}")
    print("tables:")
    for name in tables:
        try:
            conn = sqlite3.connect(db_path)
            cur = conn.cursor()
            cur.execute(f'SELECT count(*) FROM "{name}"')
            count = cur.fetchone()[0]
        except sqlite3.Error:
            count = "?"
        finally:
            conn.close()
        print(f"  {name}\t{count}")
    return 0


def cmd_query(db_path: Path, sql: str) -> int:
    if not db_path.exists():
        sys.stderr.write(f"[DEGRADED] memory.db not found at {db_path}\n")
        return 1
    if not _is_query(sql):
        sys.stderr.write("[ERROR] query command only accepts SELECT/WITH statements\n")
        return 2

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute(sql)
        rows = cur.fetchall()
        if cur.description:
            writer = csv.writer(sys.stdout, delimiter="\t", lineterminator="\n")
            for row in rows:
                writer.writerow(row)
    except sqlite3.Error as exc:
        sys.stderr.write(f"[ERROR] {exc}\n")
        return 2
    finally:
        conn.close()
    return 0


def cmd_exec(db_path: Path, sql: str) -> int:
    if not db_path.exists():
        sys.stderr.write(f"[DEGRADED] memory.db not found at {db_path}\n")
        return 1
    if _is_query(sql):
        sys.stderr.write("[ERROR] exec command does not accept SELECT/WITH statements\n")
        return 2

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute(sql)
        conn.commit()
        affected = cur.rowcount if cur.rowcount >= 0 else 0
        print(f"rows_affected: {affected}")
    except sqlite3.Error as exc:
        sys.stderr.write(f"[ERROR] {exc}\n")
        return 2
    finally:
        conn.close()
    return 0


def cmd_exec_file(db_path: Path, file_path: Path) -> int:
    if not db_path.exists():
        sys.stderr.write(f"[DEGRADED] memory.db not found at {db_path}\n")
        return 1
    if not file_path.exists():
        sys.stderr.write(f"[ERROR] SQL file not found: {file_path}\n")
        return 2

    try:
        sql = file_path.read_text(encoding="utf-8")
    except OSError as exc:
        sys.stderr.write(f"[ERROR] failed to read SQL file: {exc}\n")
        return 2

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.executescript(sql)
        conn.commit()
        print("ok")
    except sqlite3.Error as exc:
        sys.stderr.write(f"[ERROR] {exc}\n")
        return 2
    finally:
        conn.close()
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Python stdlib sqlite3 wrapper for Kilo memory.db"
    )
    parser.add_argument("--db", dest="db", help="path to memory.db (overrides env var)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="health check: list tables and row counts")

    query_parser = subparsers.add_parser("query", help="run a SELECT/WITH and output TSV")
    query_parser.add_argument("sql", help="SQL SELECT/WITH statement")

    exec_parser = subparsers.add_parser("exec", help="run an INSERT/UPDATE/DELETE")
    exec_parser.add_argument("sql", help="SQL write statement")

    exec_file_parser = subparsers.add_parser("exec-file", help="run a SQL script file")
    exec_file_parser.add_argument("path", help="path to .sql file")

    args = parser.parse_args(argv)
    db_path = resolve_db_path(args.db)

    if args.command == "check":
        return cmd_check(db_path)
    if args.command == "query":
        return cmd_query(db_path, args.sql)
    if args.command == "exec":
        return cmd_exec(db_path, args.sql)
    if args.command == "exec-file":
        return cmd_exec_file(db_path, Path(args.path))
    # Should never reach here because required=True enforces a subcommand.
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
