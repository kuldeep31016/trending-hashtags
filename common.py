"""Shared helpers: minute bucketing and storage backends (local folder or HDFS).

Tweets are stored in one directory per minute, keyed by EVENT time:

    <root>/tweets/YYYYMMDD/HHMM/part-<id>.jsonl

A 5-minute window is therefore just "the last 5 minute directories", which makes
the sliding window cheap to compute and easy to explain.
"""
import datetime as dt
import logging
import os
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class _LogfmtFormatter(logging.Formatter):
    """`ts=... level=... component=... msg="..." key=value` lines: greppable and parseable."""

    def format(self, record):
        parts = [f"ts={self.formatTime(record, '%Y-%m-%dT%H:%M:%S')}", f"level={record.levelname.lower()}",
                 f"component={record.name}", f"msg={_q(record.getMessage())}"]
        for k, v in (getattr(record, "kv", None) or {}).items():
            parts.append(f"{k}={_q(v)}")
        if record.exc_info:
            parts.append(f"exc={_q(self.formatException(record.exc_info))}")
        return " ".join(parts)


def _q(v):
    s = str(v)
    return '"' + s.replace('"', "'").replace("\n", " | ") + '"' if (not s or any(c in s for c in ' ="\n')) else s


def get_logger(component):
    log = logging.getLogger(component)
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(_LogfmtFormatter())
        log.addHandler(h)
        log.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
        log.propagate = False
    return log


def kv(**fields):
    """log.info("flushed", extra=kv(tweets=10))"""
    return {"kv": fields}


def minute_key(ts):
    """Epoch seconds -> 'YYYYMMDD/HHMM' (UTC) for the minute containing ts."""
    d = dt.datetime.fromtimestamp(int(ts // 60) * 60, dt.timezone.utc)
    return d.strftime("%Y%m%d/%H%M")


def window_keys(end_ts, minutes=5):
    """Minute keys of the sliding window ending at end_ts (oldest first).

    The window = the current (possibly partial) minute + the previous minutes-1.
    """
    end_min = int(end_ts // 60)
    return [minute_key((end_min - i) * 60) for i in range(minutes - 1, -1, -1)]


class LocalStorage:
    """Folder on disk that mimics the HDFS layout (for demos and tests)."""

    kind = "local"

    def __init__(self, root):
        self.root = os.path.abspath(root)

    def dir(self, key):
        return os.path.join(self.root, "tweets", *key.split("/"))

    def put(self, key, filename, data):
        d = self.dir(key)
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, "_" + filename + ".tmp")  # '_' files are ignored by readers
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(d, filename))  # atomic publish

    def exists(self, key):
        return os.path.isdir(self.dir(key))

    def read(self, key):
        d = self.dir(key)
        if not os.path.isdir(d):
            return b""
        out = []
        for name in sorted(os.listdir(d)):
            if name.startswith(("_", ".")):
                continue
            with open(os.path.join(d, name), "rb") as f:
                chunk = f.read()
            if chunk and not chunk.endswith(b"\n"):
                chunk += b"\n"
            out.append(chunk)
        return b"".join(out)


class HdfsStorage:
    """HDFS through the `hdfs` CLI.

    exec_prefix lets the CLI run somewhere else, e.g.
    ['docker', 'exec', '-i', 'namenode'] when Hadoop lives in Docker.
    """

    kind = "hdfs"

    def __init__(self, root="/tweets-data", exec_prefix=None):
        self.root = root.rstrip("/")
        self.prefix = list(exec_prefix or [])

    def path(self, key):
        return f"{self.root}/tweets/{key}"

    def run(self, args, data=None, check=True, timeout=None):
        return subprocess.run(self.prefix + args, input=data, capture_output=True, check=check,
                              timeout=timeout)

    def put(self, key, filename, data):
        d = self.path(key)
        self.run(["hdfs", "dfs", "-mkdir", "-p", d])
        tmp = f"{d}/_{filename}.tmp"  # Hadoop ignores files starting with '_' or '.'
        self.run(["hdfs", "dfs", "-put", "-f", "-", tmp], data=data)
        self.run(["hdfs", "dfs", "-mv", tmp, f"{d}/{filename}"])

    def exists(self, key):
        """True/False for a reachable HDFS; raises OSError when HDFS itself cannot be asked.

        `-test -d` exits 1 silently for a missing path. Any stderr (connection refused, a stopped
        container, ...) means "unknown", which must not be mistaken for "no data".
        """
        r = self.run(["hdfs", "dfs", "-test", "-d", self.path(key)], check=False, timeout=120)
        if r.returncode == 0:
            return True
        err = r.stderr.decode("utf-8", "replace").strip()
        if err:
            raise OSError(f"HDFS unavailable: {err.splitlines()[-1][:200]}")
        return False


def add_storage_args(ap):
    ap.add_argument("--backend", choices=["local", "hdfs"], default="local")
    ap.add_argument("--local-root", default=os.path.join(ROOT, "data", "hdfs_local"))
    ap.add_argument("--hdfs-root", default="/tweets-data")
    ap.add_argument("--exec-prefix", default="",
                    help='run hdfs/hadoop through this prefix, e.g. "docker exec -i namenode"')


def make_storage(a):
    if a.backend == "hdfs":
        return HdfsStorage(a.hdfs_root, shlex.split(a.exec_prefix))
    return LocalStorage(a.local_root)
