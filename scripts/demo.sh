#!/usr/bin/env bash
# One-command control of the whole demo.
#
#   scripts/demo.sh up        Docker cluster (Kafka + HDFS + YARN) + sink, driver, producer, dashboard
#   scripts/demo.sh start     only the Python services (cluster already running)
#   scripts/demo.sh stop      stop the Python services (driver finishes its current job first)
#   scripts/demo.sh down      stop everything, including the Docker cluster (HDFS is emptied)
#   scripts/demo.sh status    what is running + the dashboard's health verdict
#   scripts/demo.sh restart <service>   restart one service (dashboard | sink | driver | producer)
#   scripts/demo.sh logs [service]   follow logs (producer | sink | driver | dashboard | demo)
#   scripts/demo.sh replay    restart the producer from the top of the dataset (bursts replay;
#                             existing HDFS data is untouched and ages out of the window).
#                             REPLAY_FROM=0.27 starts just before the first burst (#worldcupfinal)
#   scripts/demo.sh local     no Docker: local simulation + dashboard
#   scripts/demo.sh reset-history   clear the dashboard's stored windows/runs/events (SQLite +
#                             leaderboard.json) for a clean demo; HDFS and Kafka are untouched
#
# Settings (environment): PORT=5050  DURATION=40 (minutes per pass of the dataset)
#                         RATE= (tweets/s, overrides DURATION)  TWEETS=60000  PYTHON=.venv/bin/python
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-$([ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)}"
PORT="${PORT:-5050}"
DURATION="${DURATION:-40}"
TWEETS="${TWEETS:-60000}"
LOGS="$ROOT/logs"
RUN="$ROOT/data/run"
mkdir -p "$LOGS" "$RUN"
HDFS_ARGS=(--backend hdfs --exec-prefix "docker exec -i namenode")

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

start_svc() {  # name, command...
  local name="$1"; shift
  if running "$name"; then say "$name already running (pid $(cat "$RUN/$name.pid"))"; return; fi
  printf '\n--- %s started %s ---\n' "$name" "$(date '+%F %T')" >> "$LOGS/$name.log"
  nohup "$@" >> "$LOGS/$name.log" 2>&1 &
  echo $! > "$RUN/$name.pid"
  say "$name started (pid $!, log logs/$name.log)"
}

stop_svc() {  # name [timeout seconds]
  local name="$1" wait_s="${2:-10}"
  running "$name" || { rm -f "$RUN/$name.pid"; return 0; }
  local pid; pid="$(cat "$RUN/$name.pid")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq "$wait_s"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then warn "$name did not stop in ${wait_s}s, killing"; kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$RUN/$name.pid"
  say "$name stopped"
}

ensure_data() {
  if [ ! -f data/tweets.jsonl ] || ! grep -q '"sentiment"' <(head -1 data/tweets.jsonl); then
    say "generating dataset ($TWEETS tweets)"
    "$PY" scripts/prepare_data.py --limit "$TWEETS"
  fi
}

ensure_frontend() {
  if [ ! -f dashboard/static/app/index.html ] && [ -d frontend ]; then
    if command -v npm >/dev/null; then
      say "building the dashboard frontend"
      (cd frontend && { [ -d node_modules ] || npm install --no-fund --no-audit; } && npm run build)
    else
      warn "npm not found: serving the classic dashboard (install Node.js to build the new one)"
    fi
  fi
}

wait_cluster() {
  say "waiting for Kafka, HDFS and YARN to report healthy"
  for _ in $(seq 60); do
    local ok=1
    for c in kafka namenode resourcemanager; do
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] || ok=0
    done
    if [ $ok = 1 ] && docker exec namenode hdfs dfsadmin -safemode get 2>/dev/null | grep -q OFF; then
      say "cluster ready"; return 0
    fi
    sleep 5
  done
  warn "cluster not healthy after 5 minutes; check: docker compose ps"; return 1
}

start_services() {
  ensure_data
  ensure_frontend
  local pace=(--duration "$DURATION"); [ -n "${RATE:-}" ] && pace=(--rate "$RATE")
  start_svc dashboard env PORT="$PORT" "$PY" dashboard/app.py
  start_svc sink "$PY" -u consumer/hdfs_sink.py "${HDFS_ARGS[@]}"
  start_svc driver "$PY" -u driver/sliding_window.py "${HDFS_ARGS[@]}"
  start_svc producer "$PY" -u producer/producer.py "${pace[@]}" --loop
  say "dashboard: http://localhost:$PORT   (HDFS http://localhost:9870, YARN http://localhost:8088)"
  say "the first window appears after the first MapReduce job (about 1-2 minutes)"
}

stop_services() {
  stop_svc producer
  stop_svc sink
  stop_svc demo
  stop_svc driver 240   # lets a running MapReduce job finish instead of orphaning it
  stop_svc dashboard
}

status() {
  for s in dashboard sink driver producer demo; do
    if running "$s"; then printf '  %-10s running (pid %s)\n' "$s" "$(cat "$RUN/$s.pid")"; else printf '  %-10s stopped\n' "$s"; fi
  done
  docker compose ps --format '  {{.Name}}: {{.Status}}' 2>/dev/null || true
  if command -v curl >/dev/null && curl -sf "http://localhost:$PORT/api/health" -o /tmp/pt_health.$$ 2>/dev/null; then
    "$PY" - "/tmp/pt_health.$$" <<'EOF'
import json, sys
h = json.load(open(sys.argv[1]))
print(f"  pipeline: {h['status'].upper()}  (data: {h['data_mode']}, source: {h['source']})")
for name, st in h["stages"].items():
    flag = "" if st["in_use"] else " [not used]"
    print(f"    {name:<10} {st['state']:<9} {st['summary']}{flag}")
EOF
    rm -f /tmp/pt_health.$$
  fi
}

case "${1:-help}" in
  up)
    say "starting the Docker cluster"
    docker compose up -d --build
    wait_cluster
    start_services ;;
  start) start_services ;;
  stop) stop_services ;;
  down) stop_services; say "stopping the Docker cluster"; docker compose down ;;
  status) status ;;
  restart)
    svc="${2:-}"
    case "$svc" in
      dashboard) stop_svc dashboard; start_svc dashboard env PORT="$PORT" "$PY" dashboard/app.py ;;
      sink) stop_svc sink; start_svc sink "$PY" -u consumer/hdfs_sink.py "${HDFS_ARGS[@]}" ;;
      driver) stop_svc driver 240; start_svc driver "$PY" -u driver/sliding_window.py "${HDFS_ARGS[@]}" ;;
      producer) "$0" replay ;;
      *) warn "usage: $0 restart dashboard|sink|driver|producer"; exit 1 ;;
    esac ;;
  logs) tail -n 50 -F "$LOGS/${2:-driver}.log" ;;
  replay)
    stop_svc producer
    local_pace=(--duration "$DURATION"); [ -n "${RATE:-}" ] && local_pace=(--rate "$RATE")
    start_svc producer "$PY" -u producer/producer.py "${local_pace[@]}" --loop --start-at "${REPLAY_FROM:-0}"
    say "producer restarted from the top of the dataset; injected bursts will replay" ;;
  local)
    running driver && { warn "the live driver is running and would overwrite the simulation; run: $0 stop"; exit 1; }
    ensure_data
    ensure_frontend
    start_svc dashboard env PORT="$PORT" "$PY" dashboard/app.py
    stop_svc demo
    start_svc demo "$PY" -u demo_local.py --delay "${DELAY:-4}"
    say "local simulation running: http://localhost:$PORT (no Kafka/HDFS/YARN involved)" ;;
  reset-history)
    "$PY" - <<'PYEOF'
import os, sys
sys.path.insert(0, os.getcwd())
from analytics.store import Store
s = Store()
for src in ("hadoop", "local", "local-sim"):
    s.clear_source(src)
with s._conn() as c:
    c.execute("DELETE FROM ingest_flushes")
    c.execute("DELETE FROM counters")
for f in ("dashboard/leaderboard.json",):
    if os.path.exists(f):
        os.remove(f)
print("dashboard history cleared; the next MapReduce window starts a fresh history")
PYEOF
    ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
