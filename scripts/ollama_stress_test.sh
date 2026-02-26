#!/usr/bin/env bash
set -euo pipefail

# Stress test Ollama server directly by sweeping concurrency.
# Leverages scripts/helpers/ollama_loadtest.ts (via Bun) and outputs:
#   - scripts/results/*.csv (CSV with metrics)
#
# Usage examples:
#   ./scripts/ollama_stress_test.sh
#   ./scripts/ollama_stress_test.sh --sweep 1,2,5,10,20 -n 25
#   ./scripts/ollama_stress_test.sh --endpoint chat --stream true -m "Hello"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Load .env for OLLAMA_HOST/PORT/MODEL if present
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

OLLAMA_HOST="${OLLAMA_HOST:-localhost}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
OLLAMA_URL="http://${OLLAMA_HOST}:${OLLAMA_PORT}"

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: 'bun' is required to run the Ollama stress test." >&2
  echo "Install Bun: https://bun.sh/" >&2
  exit 1
fi

# Defaults
ENDPOINT="chat"          # chat | generate
STREAM="false"           # true | false
REQUESTS=50               # requests per concurrency level
DURATION_MS=0             # if > 0, run for this many ms per level (overrides --requests)
SWEEP="1,2,5,10,15,20,30,40"  # concurrency levels to sweep
MESSAGE="Summarize this system in two sentences."
TIMEOUT=120000            # per-request timeout (ms)
WARMUP=0                  # warmup requests per worker before measuring
SLEEP_MS=0                # delay between requests per worker (ms)
CSV_PATH="scripts/results/ollama_results.csv"
REPORT="false"            # generate markdown report after run (default: false to keep only CSV)
REPORT_OUT="scripts/results/ollama_report.md"
ERR_THRESHOLD=2           # error threshold percent for stable peak in report

print_help() {
  cat <<EOF
Stress test the Ollama server by sweeping concurrency levels and capturing latency/throughput.

Options:
  --url URL              Override Ollama base URL (default from OLLAMA_HOST/PORT)
  --host HOST            Override Ollama host only
  --port PORT            Override Ollama port only
  --model NAME           Ollama model name (default: ${OLLAMA_MODEL})
  --endpoint NAME        'chat' or 'generate' (default: chat)
  --stream BOOL          true/false to use streaming (default: false)
  -n, --requests N       Requests per concurrency level (default: 50)
  --sweep CSV            Concurrency sweep CSV (default: $SWEEP)
  -m, --message TEXT     Prompt/message text (default shown)
  -t, --timeout MS       Per-request timeout in ms (default: 120000)
  -d, --duration MS      Duration per concurrency level in ms (overrides --requests)
  --warmup N             Warmup requests per worker before measuring (default: 0)
  --sleep MS             Delay between requests per worker in ms (default: 0)
  --csv PATH             CSV output path (default: scripts/results/ollama_results.csv)
  --report BOOL          Generate Markdown report true/false (default: true)
  --report-out PATH      Report output path (default: scripts/results/ollama_report.md)
  --err-threshold PCT    Error threshold percent for stability (default: 2)
  -h, --help             Show this help

Environment:
  OLLAMA_HOST            Defaults to 'localhost'
  OLLAMA_PORT            Defaults to 11434
  OLLAMA_MODEL           Defaults to 'llama3.2'

Examples:
  ./scripts/ollama_stress_test.sh
  ./scripts/ollama_stress_test.sh --sweep 1,2,5,10,20 -n 25
  ./scripts/ollama_stress_test.sh --endpoint generate --message "Hello" --timeout 180000
  # 60s at concurrency 10 (quick check)
  ./scripts/ollama_stress_test.sh --sweep 10 -d 60000
EOF
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      OLLAMA_URL="$2"; shift 2 ;;
    --host)
      OLLAMA_HOST="$2"; OLLAMA_URL="http://${OLLAMA_HOST}:${OLLAMA_PORT}"; shift 2 ;;
    --port)
      OLLAMA_PORT="$2"; OLLAMA_URL="http://${OLLAMA_HOST}:${OLLAMA_PORT}"; shift 2 ;;
    --model)
      OLLAMA_MODEL="$2"; shift 2 ;;
    --endpoint)
      ENDPOINT="$2"; shift 2 ;;
    --stream)
      STREAM="$2"; shift 2 ;;
    -n|--requests)
      REQUESTS="$2"; shift 2 ;;
    -d|--duration)
      DURATION_MS="$2"; shift 2 ;;
    --sweep)
      SWEEP="$2"; shift 2 ;;
    -m|--message)
      MESSAGE="$2"; shift 2 ;;
    -t|--timeout)
      TIMEOUT="$2"; shift 2 ;;
    --warmup)
      WARMUP="$2"; shift 2 ;;
    --sleep)
      SLEEP_MS="$2"; shift 2 ;;
    --csv)
      CSV_PATH="$2"; shift 2 ;;
    --report)
      REPORT="$2"; shift 2 ;;
    --report-out)
      REPORT_OUT="$2"; shift 2 ;;
    --err-threshold)
      ERR_THRESHOLD="$2"; shift 2 ;;
    -h|--help)
      print_help; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      print_help; exit 1 ;;
  esac
done

echo "Target OLLAMA_URL=$OLLAMA_URL"
echo "Runner Host=$(hostname)"
if [[ "$DURATION_MS" != "0" ]]; then
  echo "Model=$OLLAMA_MODEL | Endpoint=$ENDPOINT | Stream=$STREAM | Sweep=$SWEEP | Duration per level=${DURATION_MS}ms"
else
  echo "Model=$OLLAMA_MODEL | Endpoint=$ENDPOINT | Stream=$STREAM | Sweep=$SWEEP | Requests per level=$REQUESTS"
fi

# Run the TypeScript load tester via Bun
# Ensure results directory exists
mkdir -p "$(dirname "$CSV_PATH")"

# Build optional duration flag array safely under `set -u`
# Unset first so we can use guarded expansion later without errors on older bash
unset DURATION_ARGS || true
if [[ "$DURATION_MS" != "0" ]]; then
  DURATION_ARGS=(--duration "$DURATION_MS")
fi

OLLAMA_MODEL="$OLLAMA_MODEL" bun run scripts/helpers/ollama_loadtest.ts \
  --url "$OLLAMA_URL" \
  --model "$OLLAMA_MODEL" \
  --endpoint "$ENDPOINT" \
  --stream "$STREAM" \
  --sweep "$SWEEP" \
  ${DURATION_ARGS+"${DURATION_ARGS[@]}"} \
  --requests "$REQUESTS" \
  --message "$MESSAGE" \
  --timeout "$TIMEOUT" \
  --warmup "$WARMUP" \
  --sleep "$SLEEP_MS" \
  --csv "$CSV_PATH"

echo
echo "CSV metrics written to $CSV_PATH"

# Optionally generate the Markdown report
if [[ "$REPORT" == "true" || "$REPORT" == "1" || "$REPORT" == "yes" ]]; then
  if [[ ! -f "$CSV_PATH" ]]; then
    echo "Warning: CSV not found at $CSV_PATH. Skipping report generation." >&2
    exit 0
  fi
  echo "Generating Markdown report at $REPORT_OUT ..."
  # Ensure report directory exists
  mkdir -p "$(dirname "$REPORT_OUT")"
  bun run scripts/helpers/ollama_report.ts \
    --csv "$CSV_PATH" \
    --out "$REPORT_OUT" \
    --err-threshold "$ERR_THRESHOLD" || {
      echo "Warning: report generation failed" >&2
      exit 1
    }
  echo "Report written to $REPORT_OUT"
fi
