# Ollama Load Test Report

- Target: http://localhost:11434
- Model: llama3.2
- Host: Mac.spyderserve.local (darwin/arm64, 1 vCPU, 8.0 GB RAM)
- Endpoint: chat
- Duration per level: 1000ms
- Concurrency sweep: 1

## Key Findings
- No stable point found under 2% error rate.

## Metrics by Concurrency
| c | rps | err% | ok | total | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | wall (s) |
| -:| ---:| ----:| --:| ----:| -------:| -------:| -------:| -------:| -------:|
| 1 | 0.00 | 100.0% | 0 | 20457 | 0 | 0 | 0 | 0 | 0.99 |

## Throughput (RPS) vs Concurrency
  1 |  0.00 rps

## Latency p95 (ms) vs Concurrency
  1 |  0 ms

## Guidance
- Use the "Peak stable concurrency" as a safe upper bound for concurrent users under the tested prompt and model.
- If you require lower tail latency (e.g., p95 < 1000ms), choose a concurrency below the peak where p95 meets your target.
- Results depend on prompt length, model, and hardware; re-run after changes.

## What Was Run
```
bun run scripts/ollama_loadtest.ts --url http://localhost:11434 --model llama3.2 --endpoint chat --stream false --sweep 1 --duration 1000
```

## Re-run
- Stress test: `./scripts/ollama_stress_test.sh --sweep 10 -d 60000`
- Report: `bun run scripts/ollama_report.ts --summary scripts/quick3.txt --csv scripts/quick3.csv --out scripts/ollama_report.md`