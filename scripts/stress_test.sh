#!/usr/bin/env bash
set -euo pipefail

# Stress test wrapper that sweeps concurrency levels and writes results.
# It leverages scripts/helpers/loadtest.ts (via Bun) and outputs:
#   - scripts/results/*.csv (CSV with metrics)
#
# Usage examples:
#   ./scripts/stress_test.sh
#   ./scripts/stress_test.sh --sweep 1,2,5,10,20,40 -n 25
#   ./scripts/stress_test.sh --endpoint stream --message "Hello" --timeout 180000
#   BASE_URL=http://localhost:5555 ./scripts/stress_test.sh

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Load .env if present to get PORT/BASE_URL
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

PORT="${PORT:-5555}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: 'bun' is required to run the stress test (scripts/loadtest.ts)." >&2
  echo "Install Bun: https://bun.sh/" >&2
  exit 1
fi

# Defaults
ENDPOINT="chat"          # chat | stream
REQUESTS=50               # requests per concurrency level
SWEEP="1,2,5,10,15,20,30,40"  # concurrency levels to sweep
MESSAGE="What services do you offer?"
TIMEOUT=120000            # per-request timeout (ms)
WARMUP=0                  # warmup requests per worker before measuring
SLEEP_MS=0                # delay between requests per worker (ms)
CSV_PATH="scripts/results/results.csv"

print_help() {
  cat <<EOF
Stress test the server by sweeping concurrency levels and capturing latency/throughput.

Options:
  --base-url URL         Target base URL (default: \$BASE_URL)
  --endpoint NAME        'chat' or 'stream' (default: chat)
  -n, --requests N       Requests per concurrency level (default: 50)
  --sweep CSV            Concurrency sweep CSV (default: $SWEEP)
  -m, --message TEXT     Prompt message (default shown)
  -t, --timeout MS       Per-request timeout in ms (default: 120000)
  --warmup N             Warmup requests per worker before measuring (default: 0)
  --sleep MS             Delay between requests per worker in ms (default: 0)
  --csv PATH             CSV output path (default: scripts/results/results.csv)
  -h, --help             Show this help

Environment:
  BASE_URL               Overrides target URL (e.g., http://localhost:5555)
  PORT                   Used if BASE_URL not set (default: 5555)

Examples:
  ./scripts/stress_test.sh
  ./scripts/stress_test.sh --sweep 1,2,5,10,20,40 -n 25
  ./scripts/stress_test.sh --endpoint stream --message "Hello" --timeout 180000
EOF
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"; shift 2 ;;
    --endpoint)
      ENDPOINT="$2"; shift 2 ;;
    -n|--requests)
      REQUESTS="$2"; shift 2 ;;
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
    -h|--help)
      print_help; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      print_help; exit 1 ;;
  esac
done

echo "Target BASE_URL=$BASE_URL"
echo "Endpoint=$ENDPOINT | Sweep=$SWEEP | Requests per level=$REQUESTS"
mkdir -p "$(dirname "$CSV_PATH")"

# Run the TypeScript load tester via Bun
BASE_URL="$BASE_URL" bun run scripts/helpers/loadtest.ts \
  --endpoint "$ENDPOINT" \
  --sweep "$SWEEP" \
  --requests "$REQUESTS" \
  --message "$MESSAGE" \
  --timeout "$TIMEOUT" \
  --warmup "$WARMUP" \
  --sleep "$SLEEP_MS" \
  --csv "$CSV_PATH"

echo
echo "CSV metrics written to $CSV_PATH"
