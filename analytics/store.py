"""SQLite store for snapshots, job runs, trend events, ingest metrics and heartbeats.

It is a supporting store for the dashboard, never an analytics engine: every count in it
comes from a finished MapReduce window. Several processes write to it (driver, sink,
producer) while Flask reads, so it runs in WAL mode with a busy timeout.
"""
import json
import os
import sqlite3
import time

from common import ROOT

DEFAULT_DB = os.environ.get("DB_PATH", os.path.join(ROOT, "data", "pulsetrend.db"))
STORE_TOP_TAGS = 200  # tags kept per snapshot (enough for history, explorer and velocity)

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id             INTEGER PRIMARY KEY,
    source         TEXT NOT NULL,               -- 'hadoop' | 'local-sim'
    end_ts         REAL NOT NULL,
    generated_at   REAL NOT NULL,
    window_minutes INTEGER NOT NULL,
    window_start   REAL NOT NULL,
    total_tweets   INTEGER NOT NULL,
    distinct_tags  INTEGER NOT NULL,
    tag_mentions   INTEGER NOT NULL,
    job_seconds    REAL,
    sentiment      TEXT,                        -- JSON {positive, neutral, negative, unlabeled} or NULL
    UNIQUE (source, end_ts)
);
CREATE TABLE IF NOT EXISTS snapshot_tags (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    count       INTEGER NOT NULL,
    rank        INTEGER NOT NULL,
    positive    INTEGER, neutral INTEGER, negative INTEGER,
    PRIMARY KEY (snapshot_id, tag)
);
CREATE INDEX IF NOT EXISTS ix_snapshot_tags_tag ON snapshot_tags(tag);
CREATE INDEX IF NOT EXISTS ix_snapshots_source_end ON snapshots(source, end_ts);
CREATE TABLE IF NOT EXISTS runs (
    id             INTEGER PRIMARY KEY,
    source         TEXT NOT NULL,
    started_at     REAL NOT NULL,
    finished_at    REAL,
    end_ts         REAL,
    status         TEXT NOT NULL,               -- 'success' | 'failed'
    attempts       INTEGER NOT NULL DEFAULT 1,
    job_seconds    REAL,
    schedule_delay REAL,
    input_minutes  INTEGER,
    error          TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY,
    source  TEXT NOT NULL,
    end_ts  REAL NOT NULL,                      -- window end that produced the event
    created REAL NOT NULL,
    tag     TEXT,
    kind    TEXT NOT NULL,                      -- new_leader | entered_top | left_top | surge
    detail  TEXT                                -- JSON
);
CREATE INDEX IF NOT EXISTS ix_events_end ON events(source, end_ts);
CREATE TABLE IF NOT EXISTS ingest_flushes (
    ts            REAL NOT NULL,
    written       INTEGER NOT NULL,
    minutes       INTEGER NOT NULL,
    lag_avg       REAL,
    lag_max       REAL,
    write_seconds REAL
);
CREATE INDEX IF NOT EXISTS ix_ingest_ts ON ingest_flushes(ts);
CREATE TABLE IF NOT EXISTS counters (
    name       TEXT PRIMARY KEY,
    value      REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeats (
    component TEXT PRIMARY KEY,
    ts        REAL NOT NULL,
    status    TEXT NOT NULL,
    detail    TEXT                              -- JSON
);
"""


class Store:
    def __init__(self, path=DEFAULT_DB):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=10000")
        return _Closing(c)

    # ---- writes -------------------------------------------------------------------------

    def save_snapshot(self, source, snap, counts, tag_sentiment=None):
        tag_sentiment = tag_sentiment or {}
        tags = sorted(((t, n) for t, n in counts.items() if not t.startswith("__")),
                      key=lambda x: (-x[1], x[0]))
        with self._conn() as c:
            c.execute("DELETE FROM snapshots WHERE source=? AND end_ts=?", (source, snap["window_end"]))
            cur = c.execute(
                "INSERT INTO snapshots (source, end_ts, generated_at, window_minutes, window_start,"
                " total_tweets, distinct_tags, tag_mentions, job_seconds, sentiment)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (source, snap["window_end"], time.time(), snap["window_minutes"], snap["window_start"],
                 snap["total_tweets"], len(tags), sum(n for _, n in tags), snap.get("job_seconds"),
                 json.dumps(snap["sentiment"]) if snap.get("sentiment") else None))
            sid = cur.lastrowid
            rows = []
            for rank, (t, n) in enumerate(tags[:STORE_TOP_TAGS], start=1):
                s = tag_sentiment.get(t) or {}
                rows.append((sid, t, n, rank, s.get("positive"), s.get("neutral"), s.get("negative")))
            c.executemany("INSERT INTO snapshot_tags VALUES (?,?,?,?,?,?,?)", rows)
        return sid

    def record_run(self, source, started_at, status, attempts, job_seconds=None, end_ts=None,
                   schedule_delay=None, input_minutes=None, error=None):
        with self._conn() as c:
            c.execute("INSERT INTO runs (source, started_at, finished_at, end_ts, status, attempts,"
                      " job_seconds, schedule_delay, input_minutes, error) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (source, started_at, time.time(), end_ts, status, attempts, job_seconds,
                       schedule_delay, input_minutes, (error or "")[:4000] or None))

    def add_events(self, source, end_ts, events):
        if not events:
            return
        now = time.time()
        with self._conn() as c:
            c.executemany("INSERT INTO events (source, end_ts, created, tag, kind, detail) VALUES (?,?,?,?,?,?)",
                          [(source, end_ts, now, e.get("tag"), e["kind"], json.dumps(e.get("detail") or {}))
                           for e in events])

    def record_flush(self, written, minutes, lag_avg, lag_max, write_seconds):
        with self._conn() as c:
            c.execute("INSERT INTO ingest_flushes VALUES (?,?,?,?,?,?)",
                      (time.time(), written, minutes, lag_avg, lag_max, write_seconds))

    def incr(self, name, by=1):
        with self._conn() as c:
            c.execute("INSERT INTO counters VALUES (?,?,?) ON CONFLICT(name) DO UPDATE"
                      " SET value=value+excluded.value, updated_at=excluded.updated_at",
                      (name, by, time.time()))

    def set_counter(self, name, value):
        with self._conn() as c:
            c.execute("INSERT INTO counters VALUES (?,?,?) ON CONFLICT(name) DO UPDATE"
                      " SET value=excluded.value, updated_at=excluded.updated_at", (name, value, time.time()))

    def heartbeat(self, component, status, **detail):
        with self._conn() as c:
            c.execute("INSERT INTO heartbeats VALUES (?,?,?,?) ON CONFLICT(component) DO UPDATE"
                      " SET ts=excluded.ts, status=excluded.status, detail=excluded.detail",
                      (component, time.time(), status, json.dumps(detail)))

    def clear_source(self, source):
        """Remove one source's data (used when the local demo replays from scratch)."""
        with self._conn() as c:
            c.execute("DELETE FROM snapshots WHERE source=?", (source,))
            c.execute("DELETE FROM runs WHERE source=?", (source,))
            c.execute("DELETE FROM events WHERE source=?", (source,))

    def prune(self, keep_days=7, keep_ingest_hours=24):
        now = time.time()
        with self._conn() as c:
            c.execute("DELETE FROM snapshots WHERE generated_at < ?", (now - keep_days * 86400,))
            c.execute("DELETE FROM runs WHERE started_at < ?", (now - keep_days * 86400,))
            c.execute("DELETE FROM events WHERE created < ?", (now - keep_days * 86400,))
            c.execute("DELETE FROM ingest_flushes WHERE ts < ?", (now - keep_ingest_hours * 3600,))

    # ---- reads --------------------------------------------------------------------------

    def snapshots(self, source, since=None, until=None, limit=500):
        q, args = "SELECT * FROM snapshots WHERE source=?", [source]
        if since is not None:
            q += " AND end_ts >= ?"
            args.append(since)
        if until is not None:
            q += " AND end_ts <= ?"
            args.append(until)
        q += " ORDER BY end_ts DESC LIMIT ?"
        args.append(limit)
        with self._conn() as c:
            rows = [_snap_row(r) for r in c.execute(q, args)]
        return rows[::-1]  # oldest first

    def bounds(self, source):
        with self._conn() as c:
            r = c.execute("SELECT MIN(end_ts) AS oldest, MAX(end_ts) AS newest, COUNT(*) AS n"
                          " FROM snapshots WHERE source=?", (source,)).fetchone()
        return dict(r)

    def snapshot_tags(self, snapshot_id, limit=50):
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT tag, count, rank, positive, neutral, negative FROM snapshot_tags"
                " WHERE snapshot_id=? ORDER BY rank LIMIT ?", (snapshot_id, limit))]

    def tag_series(self, source, tags, since=None, until=None, limit=500):
        """{tag: [(end_ts, count, rank or None)]} over the snapshots in range (0 when absent)."""
        snaps = self.snapshots(source, since, until, limit)
        if not snaps or not tags:
            return snaps, {t: [] for t in tags}
        ids = [s["id"] for s in snaps]
        marks = ",".join("?" * len(ids))
        tmarks = ",".join("?" * len(tags))
        with self._conn() as c:
            found = {(r["snapshot_id"], r["tag"]): (r["count"], r["rank"]) for r in c.execute(
                f"SELECT snapshot_id, tag, count, rank FROM snapshot_tags WHERE snapshot_id IN ({marks})"
                f" AND tag IN ({tmarks})", ids + list(tags))}
        series = {t: [(s["end_ts"], *found.get((s["id"], t), (0, None))) for s in snaps] for t in tags}
        return snaps, series

    def tag_overview(self, source, tag):
        with self._conn() as c:
            r = c.execute(
                "SELECT MIN(s.end_ts) AS first_seen, MAX(s.end_ts) AS last_seen, COUNT(*) AS windows,"
                " MAX(t.count) AS peak_count, MIN(t.rank) AS best_rank,"
                " SUM(t.positive) AS positive, SUM(t.neutral) AS neutral, SUM(t.negative) AS negative"
                " FROM snapshot_tags t JOIN snapshots s ON s.id=t.snapshot_id"
                " WHERE s.source=? AND t.tag=?", (source, tag)).fetchone()
        return dict(r) if r and r["windows"] else None

    def search_tags(self, source, q, limit=20):
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT t.tag, MAX(t.count) AS peak_count, MAX(s.end_ts) AS last_seen"
                " FROM snapshot_tags t JOIN snapshots s ON s.id=t.snapshot_id"
                " WHERE s.source=? AND t.tag LIKE ? ESCAPE '\\'"
                " GROUP BY t.tag ORDER BY peak_count DESC, t.tag LIMIT ?",
                (source, "%" + _like(q.lower()) + "%", limit))]

    def runs(self, source=None, since=None, limit=100):
        q, args = "SELECT * FROM runs WHERE 1=1", []
        if source:
            q += " AND source=?"
            args.append(source)
        if since is not None:
            q += " AND started_at >= ?"
            args.append(since)
        q += " ORDER BY started_at DESC LIMIT ?"
        args.append(limit)
        with self._conn() as c:
            return [dict(r) for r in c.execute(q, args)][::-1]

    def run_stats(self, source):
        with self._conn() as c:
            r = c.execute("SELECT SUM(status='success') AS ok, SUM(status='failed') AS failed,"
                          " AVG(CASE WHEN status='success' THEN job_seconds END) AS avg_job,"
                          " MAX(CASE WHEN status='success' THEN job_seconds END) AS max_job,"
                          " AVG(schedule_delay) AS avg_delay FROM runs WHERE source=?", (source,)).fetchone()
        return dict(r)

    def events(self, source, since=None, until=None, limit=100, tag=None):
        q, args = "SELECT * FROM events WHERE source=?", [source]
        if since is not None:
            q += " AND end_ts >= ?"
            args.append(since)
        if until is not None:
            q += " AND end_ts <= ?"
            args.append(until)
        if tag:
            q += " AND tag=?"
            args.append(tag)
        q += " ORDER BY end_ts DESC, id DESC LIMIT ?"
        args.append(limit)
        with self._conn() as c:
            return [{**dict(r), "detail": json.loads(r["detail"] or "{}")} for r in c.execute(q, args)]

    def ingest(self, since):
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT * FROM ingest_flushes WHERE ts >= ? ORDER BY ts", (since,))]

    def counters(self):
        with self._conn() as c:
            return {r["name"]: {"value": r["value"], "updated_at": r["updated_at"]}
                    for r in c.execute("SELECT * FROM counters")}

    def heartbeats(self):
        with self._conn() as c:
            return {r["component"]: {"ts": r["ts"], "status": r["status"],
                                     "detail": json.loads(r["detail"] or "{}")}
                    for r in c.execute("SELECT * FROM heartbeats")}


class _Closing:
    """sqlite3's own context manager commits but never closes; this does both."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, exc_type, *_):
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            self.conn.close()


def _snap_row(r):
    d = dict(r)
    d["sentiment"] = json.loads(d["sentiment"]) if d["sentiment"] else None
    return d


def _like(s):
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
