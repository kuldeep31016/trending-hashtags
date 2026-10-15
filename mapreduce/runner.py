"""Run the hashtag-count job over a list of minute directories.

run_local : simulates MapReduce with a pipe  (map -> sort -> reduce). Same mapper/reducer
            scripts, no cluster needed.
run_hadoop: submits a real Hadoop Streaming job (YARN) over the HDFS minute directories.
"""
import os
import re
import subprocess
import sys

JOB_PREFIX = "trending-hashtags-"


class JobFailed(RuntimeError):
    """A MapReduce run failed; the message carries the useful tail of Hadoop's stderr."""


class NoInput(RuntimeError):
    """None of the window's minute folders exist, so there is nothing to count."""


def _tail(raw, lines=12):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else (raw or "")
    keep = [ln for ln in text.splitlines() if " INFO " not in ln and ln.strip()]
    return "\n".join(keep[-lines:])

HERE = os.path.dirname(os.path.abspath(__file__))
MAPPER = os.path.join(HERE, "mapper.py")
REDUCER = os.path.join(HERE, "reducer.py")


def parse_output(raw):
    counts = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        key, _, val = line.partition("\t")
        if val.strip().isdigit():
            counts[key] = counts.get(key, 0) + int(val)
    return counts


def run_local(storage, keys):
    data = b"".join(storage.read(k) for k in keys)
    if not data:
        if not any(storage.exists(k) for k in keys):
            raise NoInput(f"no minute folders for {keys[0]}..{keys[-1]}")
        return {}
    mapped = subprocess.run([sys.executable, MAPPER], input=data,
                            capture_output=True, check=True).stdout
    shuffled = b"\n".join(sorted(mapped.splitlines())) + b"\n"  # the "shuffle & sort" phase
    reduced = subprocess.run([sys.executable, REDUCER], input=shuffled,
                             capture_output=True, check=True).stdout
    return parse_output(reduced)


def run_hadoop(storage, keys, streaming_jar, mr_dir, run_id, reducers=1, timeout=None):
    inputs = [storage.path(k) for k in keys if storage.exists(k)]
    if not inputs:
        raise NoInput(f"no minute folders for {keys[0]}..{keys[-1]}")
    out = f"{storage.root}/out/{run_id}"
    storage.run(["hdfs", "dfs", "-rm", "-r", "-skipTrash", out], check=False)  # leftover from a failed try
    cmd = ["hadoop", "jar", streaming_jar,
           "-D", f"mapreduce.job.name={JOB_PREFIX}{run_id}",
           "-D", f"mapreduce.job.reduces={reducers}",
           "-files", f"{mr_dir}/mapper.py,{mr_dir}/reducer.py",
           "-mapper", "python3 mapper.py",
           "-combiner", "python3 reducer.py",   # local pre-aggregation cuts shuffle traffic
           "-reducer", "python3 reducer.py"]
    for p in inputs:
        cmd += ["-input", p]
    cmd += ["-output", out]
    try:
        storage.run(cmd, timeout=timeout)
        raw = storage.run(["hdfs", "dfs", "-cat", out + "/part-*"], timeout=120).stdout
    except subprocess.CalledProcessError as e:
        raise JobFailed(f"exit {e.returncode}: {_tail(e.stderr) or 'no stderr'}") from e
    except subprocess.TimeoutExpired as e:
        kill_running_jobs(storage)  # the client was killed, the YARN app would keep running
        raise JobFailed(f"timed out after {e.timeout:.0f}s") from e
    finally:
        storage.run(["hdfs", "dfs", "-rm", "-r", "-skipTrash", out], check=False)
    return parse_output(raw)


def heal_nodemanager(storage, container="nodemanager"):
    """Restart the NodeManager container when YARN has no RUNNING node (e.g. marked LOST).

    Under amd64 emulation the NodeManager JVM sometimes freezes; jobs then wait in ACCEPTED
    forever. Only applies when Hadoop runs in Docker (exec prefix "docker exec ..."). Returns
    True if a restart was done.
    """
    if not storage.prefix or storage.prefix[0] != "docker":
        return False
    try:
        nodes = storage.run(["yarn", "node", "-list", "-all"], check=False, timeout=60).stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        nodes = ""
    if re.search(r"\sRUNNING\s", nodes):
        return False
    kill_running_jobs(storage)
    subprocess.run(["docker", "restart", container], capture_output=True, timeout=180, check=False)
    return True


def kill_running_jobs(storage):
    """Kill this project's YARN apps that are still running (e.g. left by a killed driver).

    A stopped driver does not stop its YARN application; an orphan holds NodeManager memory
    and starves the next job. Returns the killed application ids.
    """
    try:
        listing = storage.run(["yarn", "application", "-list", "-appStates", "RUNNING,ACCEPTED,SUBMITTED"],
                              check=False, timeout=60).stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return []
    ids = [m.group(1) for m in re.finditer(r"^(application_\d+_\d+)\s+" + re.escape(JOB_PREFIX), listing, re.M)]
    for app_id in ids:
        storage.run(["yarn", "application", "-kill", app_id], check=False, timeout=60)
    return ids
