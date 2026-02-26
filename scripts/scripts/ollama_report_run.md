# Ollama Load Test Report

- Target: http://localhost:11434
- Model: llama3.2
- Endpoint: chat
- Duration per level: 60000ms
- Concurrency sweep: 10

## Key Findings
- No stable point found under 2% error rate.

## Metrics by Concurrency
| c | rps | err% | ok | total | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | wall (s) |
| -:| ---:| ----:| --:| ----:| -------:| -------:| -------:| -------:| -------:|
| 10 | 0.00 | 100.0% | 0 | 250968 | 0 | 0 | 0 | 0 | 60.00 |

## Throughput (RPS) vs Concurrency
 10 |  0.00 rps

## Latency p95 (ms) vs Concurrency
 10 |  0 ms

## Guidance
- Use the "Peak stable concurrency" as a safe upper bound for concurrent users under the tested prompt and model.
- If you require lower tail latency (e.g., p95 < 1000ms), choose a concurrency below the peak where p95 meets your target.
- Results depend on prompt length, model, and hardware; re-run after changes.

## Re-run
- Stress test: `./scripts/ollama_stress_test.sh --sweep 10 -d 60000`
- Report: `bun run scripts/ollama_report.ts --summary scripts/ollama_results_run.txt --csv scripts/ollama_results_run.csv --out scripts/ollama_report.md`