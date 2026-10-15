"""Pipeline health checks.

Cluster checks (Kafka, HDFS, YARN) run in ONE background thread every REFRESH_S seconds
with short timeouts, so a browser request never waits on the cluster. Request handlers
combine that cached result with cheap local reads (heartbeats, run history, snapshot age).

States: healthy | degraded | down | unknown. A component is only "healthy" when a check
actually succeeded recently; an old leaderboard file on its own proves nothing.
"""
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request

REFRESH_S = 10
HTTP_TIMEOUT = 3

KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:9092")
KAFKA_TOPIC = os.environ.get("KAFKA_TOPIC", "tweets")
KAFKA_GROUP = os.environ.get("KAFKA_GROUP", "hdfs-sink")
HDFS_HTTP = os.environ.get("HDFS_HTTP", "http://localhost:9870")
HDFS_ROOT = os.environ.get("HDFS_ROOT", "/tweets-data")
YARN_HTTP = os.environ.get("YARN_HTTP", "http://localhost:8088")
JOB_PREFIX = "trending-hashtags-"


def _get_json(url):
    with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _err(e):
    return f"{type(e).__name__}: {e}"[:300]


def check_kafka():
    host, _, port = KAFKA_BOOTSTRAP.partition(":")
    t0 = time.time()
    try:
        with socket.create_connection((host, int(port or 9092)), timeout=2):
            pass
    except OSError as e:
        return {"state": "down", "reachable": False, "error": _err(e), "bootstrap": KAFKA_BOOTSTRAP}
    out = {"state": "healthy", "reachable": True, "bootstrap": KAFKA_BOOTSTRAP, "topic": KAFKA_TOPIC,
           "connect_ms": round((time.time() - t0) * 1000, 1)}
    try:  # topic + consumer lag; kafka-python is optional for health, so import lazily
        from kafka import KafkaConsumer, TopicPartition
        # group_id only lets committed() read the sink's offsets; this consumer never
        # subscribes, so it does not join the group or trigger a rebalance
        consumer = KafkaConsumer(bootstrap_servers=KAFKA_BOOTSTRAP, group_id=KAFKA_GROUP,
                                 enable_auto_commit=False, request_timeout_ms=5000)
        try:
            parts = consumer.partitions_for_topic(KAFKA_TOPIC)
            if not parts:
                out.update(state="degraded", topic_exists=False, error=f"topic '{KAFKA_TOPIC}' not found")
                return out
            tps = [TopicPartition(KAFKA_TOPIC, p) for p in sorted(parts)]
            ends = consumer.end_offsets(tps)
            out.update(topic_exists=True, partitions=len(parts), end_offset_total=sum(ends.values()))
            done = {tp: consumer.committed(tp) for tp in tps}
            if any(v is not None for v in done.values()):
                out["consumer_group"] = KAFKA_GROUP
                out["consumer_lag"] = sum(max(ends[tp] - (done[tp] or 0), 0) for tp in tps)
        finally:
            consumer.close()
    except Exception as e:  # noqa: BLE001 - any client failure is a diagnostic, not a crash
        out.update(state="degraded", error=_err(e))
    return out


def check_hdfs():
    out = {"web": HDFS_HTTP}
    try:
        beans = _get_json(f"{HDFS_HTTP}/jmx?qry=Hadoop:service=NameNode,name=FSNamesystemState")["beans"]
        b = beans[0] if beans else {}
        out.update(reachable=True, fs_state=b.get("FSState"), live_datanodes=b.get("NumLiveDataNodes"),
                   dead_datanodes=b.get("NumDeadDataNodes"),
                   capacity_used_pct=_pct(b.get("CapacityUsed"), b.get("CapacityTotal")))
    except (OSError, ValueError, KeyError, IndexError) as e:
        return {**out, "state": "down", "reachable": False, "error": _err(e)}
    try:
        base = f"{HDFS_HTTP}/webhdfs/v1{HDFS_ROOT}/tweets"
        days = _list_dirs(base)
        if days:
            minutes = _list_dirs(f"{base}/{days[-1]['pathSuffix']}")
            if minutes:
                latest = minutes[-1]
                out["latest_minute_folder"] = f"{days[-1]['pathSuffix']}/{latest['pathSuffix']}"
                out["last_write"] = latest["modificationTime"] / 1000
                out["day_folders"] = len(days)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            out["error"] = _err(e)
    except (OSError, ValueError, KeyError) as e:
        out["error"] = _err(e)
    if not out.get("live_datanodes"):
        out["state"] = "down" if out.get("live_datanodes") == 0 else "degraded"
        out.setdefault("error", "no live DataNodes")
    elif out.get("fs_state") not in (None, "Operational"):
        out["state"] = "degraded"
    else:
        out["state"] = "healthy"
    return out


def check_yarn():
    out = {"web": YARN_HTTP}
    try:
        info = _get_json(f"{YARN_HTTP}/ws/v1/cluster/info")["clusterInfo"]
        m = _get_json(f"{YARN_HTTP}/ws/v1/cluster/metrics")["clusterMetrics"]
    except (OSError, ValueError, KeyError) as e:
        return {**out, "state": "down", "reachable": False, "error": _err(e)}
    out.update(reachable=True, rm_state=info.get("state"), hadoop_version=info.get("hadoopVersion"),
               active_nodes=m.get("activeNodes"), apps_running=m.get("appsRunning"),
               apps_failed=m.get("appsFailed"), available_mb=m.get("availableMB"),
               allocated_mb=m.get("allocatedMB"))
    try:
        apps = (_get_json(f"{YARN_HTTP}/ws/v1/cluster/apps?applicationTypes=MAPREDUCE").get("apps") or {}).get("app") or []
        ours = sorted((a for a in apps if a.get("name", "").startswith(JOB_PREFIX)),
                      key=lambda a: a.get("startedTime", 0), reverse=True)
        out["recent_apps"] = [{"id": a["id"], "name": a["name"], "state": a.get("state"),
                               "final_status": a.get("finalStatus"), "progress": a.get("progress"),
                               "started": a.get("startedTime", 0) / 1000,
                               "elapsed_s": round(a.get("elapsedTime", 0) / 1000, 1)} for a in ours[:10]]
    except (OSError, ValueError, KeyError) as e:
        out["apps_error"] = _err(e)
    if out["rm_state"] != "STARTED" or not out["active_nodes"]:
        out["state"] = "down" if out["rm_state"] != "STARTED" else "degraded"
        out["error"] = "no active NodeManagers" if out["rm_state"] == "STARTED" else f"RM state {out['rm_state']}"
    else:
        out["state"] = "healthy"
    return out


def _list_dirs(url):
    st = _get_json(f"{url}?op=LISTSTATUS&user.name=hadoop")["FileStatuses"]["FileStatus"]
    return sorted((s for s in st if s["type"] == "DIRECTORY"), key=lambda s: s["pathSuffix"])


def _pct(a, b):
    return round(100.0 * a / b, 1) if a is not None and b else None


class HealthMonitor:
    def __init__(self):
        self._lock = threading.Lock()
        self._result = {"kafka": None, "hdfs": None, "yarn": None, "checked_at": None}
        self._started = False

    def start(self):
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._loop, daemon=True, name="health").start()

    def _loop(self):
        while True:
            res = {}
            for name, fn in (("kafka", check_kafka), ("hdfs", check_hdfs), ("yarn", check_yarn)):
                t0 = time.time()
                try:
                    r = fn()
                except Exception as e:  # noqa: BLE001 - keep the monitor alive whatever happens
                    r = {"state": "unknown", "error": _err(e)}
                r["checked_at"] = time.time()
                r["check_ms"] = round((r["checked_at"] - t0) * 1000, 1)
                res[name] = r
            res["checked_at"] = time.time()
            with self._lock:
                self._result = res
            time.sleep(REFRESH_S)

    def snapshot(self):
        with self._lock:
            return dict(self._result)
