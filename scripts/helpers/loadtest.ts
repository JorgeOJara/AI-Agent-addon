/*
  Simple load tester for the Bun server.

  - Targets `/api/chat` or `/api/chat/stream`
  - Sweeps concurrency levels, measures latency & throughput
  - Writes a human-readable summary and optional CSV

  Environment:
    BASE_URL (e.g., http://localhost:5555)

  Example:
    bun run scripts/loadtest.ts \
      --endpoint chat \
      --sweep 1,2,5,10 \
      --requests 50 \
      --message "Hello" \
      --timeout 120000 \
      --out scripts/results.txt \
      --csv scripts/results.csv
*/

type Endpoint = "chat" | "stream";

interface Options {
  baseUrl: string;
  endpoint: Endpoint;
  sweep: number[];           // list of concurrency levels
  requests: number;          // total requests per concurrency level
  message: string;
  timeoutMs: number;         // per-request timeout
  warmup: number;            // per-worker warmup requests (not measured)
  sleepMs: number;           // delay between requests per worker
  outPath?: string;          // summary file path
  csvPath?: string;          // csv file path
}

interface LevelMetrics {
  concurrency: number;
  total: number;
  ok: number;
  fail: number;
  timeout: number;
  wallMs: number;            // total wall time for the level
  latencies: number[];       // ms for successful requests
}

function parseArgs(argv: string[]): Options {
  const envBase = process.env.BASE_URL || `http://localhost:${process.env.PORT || "5555"}`;

  const opts: Options = {
    baseUrl: envBase,
    endpoint: "chat",
    sweep: [1, 2, 5, 10, 15, 20, 30, 40],
    requests: 50,
    message: "What services do you offer?",
    timeoutMs: 120000,
    warmup: 0,
    sleepMs: 0,
    outPath: "scripts/results.txt",
    csvPath: "scripts/results.csv",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (def?: string) => (i + 1 < argv.length ? argv[++i] : def || "");
    switch (a) {
      case "--base-url":
        opts.baseUrl = next();
        break;
      case "--endpoint": {
        const v = next();
        if (v !== "chat" && v !== "stream") throw new Error(`Invalid --endpoint ${v}`);
        opts.endpoint = v;
        break;
      }
      case "--sweep":
        opts.sweep = next().split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n) && n > 0);
        if (!opts.sweep.length) throw new Error("--sweep must include at least one positive integer");
        break;
      case "--requests":
      case "-n":
        opts.requests = parseInt(next(), 10);
        if (!(opts.requests > 0)) throw new Error("--requests must be > 0");
        break;
      case "--message":
      case "-m":
        opts.message = next();
        break;
      case "--timeout":
      case "-t":
        opts.timeoutMs = parseInt(next(), 10);
        if (!(opts.timeoutMs > 0)) throw new Error("--timeout must be > 0");
        break;
      case "--warmup":
        opts.warmup = Math.max(0, parseInt(next(), 10));
        break;
      case "--sleep":
        opts.sleepMs = Math.max(0, parseInt(next(), 10));
        break;
      case "--out":
        opts.outPath = next();
        break;
      case "--csv":
        opts.csvPath = next();
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function doRequest(baseUrl: string, endpoint: Endpoint, message: string, timeoutMs: number): Promise<{ ok: boolean; ms: number; err?: string }>
{
  const url = endpoint === "chat" ? `${baseUrl}/api/chat` : `${baseUrl}/api/chat/stream`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // Drain body quickly to allow connection reuse
      try { await res.arrayBuffer(); } catch {}
      return { ok: false, ms: performance.now() - start, err: `HTTP ${res.status}` };
    }

    if (endpoint === "chat") {
      // Just read the JSON result
      try { await res.json(); } catch { await res.arrayBuffer(); }
    } else {
      // Read the streaming body fully
      if (!res.body) {
        return { ok: false, ms: performance.now() - start, err: "no-body" };
      }
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    return { ok: true, ms: performance.now() - start };
  } catch (e: any) {
    const ms = performance.now() - start;
    const msg = e?.name === "TimeoutError" || /aborted|timeout/i.test(String(e?.message)) ? "timeout" : (e?.message || "error");
    return { ok: false, ms, err: msg };
  }
}

async function runLevel(opts: Options, concurrency: number): Promise<LevelMetrics> {
  const total = opts.requests;
  const perWorker = Math.floor(total / concurrency);
  const remainder = total % concurrency;

  let ok = 0, fail = 0, timeout = 0;
  const latencies: number[] = [];

  const worker = async (count: number) => {
    // Warmup (not measured)
    for (let i = 0; i < opts.warmup; i++) {
      await doRequest(opts.baseUrl, opts.endpoint, opts.message, opts.timeoutMs);
      if (opts.sleepMs) await sleep(opts.sleepMs);
    }

    // Measured runs
    for (let i = 0; i < count; i++) {
      const r = await doRequest(opts.baseUrl, opts.endpoint, opts.message, opts.timeoutMs);
      if (r.ok) {
        ok++;
        latencies.push(r.ms);
      } else {
        if (r.err === "timeout") timeout++; else fail++;
      }
      if (opts.sleepMs) await sleep(opts.sleepMs);
    }
  };

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    const count = perWorker + (i < remainder ? 1 : 0);
    if (count > 0) tasks.push(worker(count));
  }

  const t0 = performance.now();
  await Promise.all(tasks);
  const wallMs = performance.now() - t0;

  return { concurrency, total, ok, fail, timeout, wallMs, latencies };
}

function renderSummaryRow(m: LevelMetrics) {
  const lat = m.latencies;
  const avg = lat.length ? (lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  const min = lat.length ? Math.min(...lat) : 0;
  const max = lat.length ? Math.max(...lat) : 0;
  const p50 = percentile(lat, 50);
  const p90 = percentile(lat, 90);
  const p95 = percentile(lat, 95);
  const p99 = percentile(lat, 99);
  const rps = m.wallMs > 0 ? (m.ok / (m.wallMs / 1000)) : 0;

  return {
    line: [
      `c=${m.concurrency}`.padEnd(6),
      `req=${m.total}`.padEnd(8),
      `ok=${m.ok}`.padEnd(10),
      `fail=${m.fail}`.padEnd(10),
      `tout=${m.timeout}`.padEnd(10),
      `p50=${p50.toFixed(0)}ms`.padEnd(12),
      `p95=${p95.toFixed(0)}ms`.padEnd(12),
      `max=${max.toFixed(0)}ms`.padEnd(12),
      `rps=${rps.toFixed(2)}`.padEnd(14),
      `wall=${m.wallMs.toFixed(0)}ms`,
    ].join("  "),
    csv: [
      m.concurrency,
      m.total,
      m.ok,
      m.fail,
      m.timeout,
      avg.toFixed(2),
      min.toFixed(0),
      p50.toFixed(0),
      p90.toFixed(0),
      p95.toFixed(0),
      p99.toFixed(0),
      max.toFixed(0),
      (m.wallMs / 1000).toFixed(3),
      (m.ok / (m.wallMs / 1000)).toFixed(3),
    ].join(","),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Target BASE_URL=${opts.baseUrl}`);
  console.log(`Endpoint=${opts.endpoint} | Sweep=${opts.sweep.join(",")} | Requests per level=${opts.requests}`);
  if (opts.warmup) console.log(`Warmup per worker=${opts.warmup}`);
  if (opts.sleepMs) console.log(`Sleep per request=${opts.sleepMs}ms`);
  console.log("");

  const lines: string[] = [];
  const csv: string[] = [];
  csv.push("concurrency,total,ok,fail,timeout,avg_ms,min_ms,p50_ms,p90_ms,p95_ms,p99_ms,max_ms,wall_s,rps");

  for (const c of opts.sweep) {
    console.log(`Running concurrency=${c} ...`);
    const m = await runLevel(opts, c);
    const row = renderSummaryRow(m);
    console.log(row.line);
    lines.push(row.line);
    csv.push(row.csv);
  }

  const now = new Date().toISOString();
  const header = [
    `Load Test Summary (${now})`,
    `Target: ${opts.baseUrl}`,
    `Endpoint: ${opts.endpoint}`,
    `Sweep: ${opts.sweep.join(", ")}`,
    `Requests per level: ${opts.requests}`,
    opts.warmup ? `Warmup per worker: ${opts.warmup}` : undefined,
    opts.sleepMs ? `Sleep per request: ${opts.sleepMs}ms` : undefined,
    "",
    "c=..  req=..  ok=..  fail=..  tout=..  p50=.. p95=.. max=.. rps=.. wall=..",
  ].filter(Boolean).join("\n");

  const summary = `${header}\n${lines.join("\n")}\n`;

  if (opts.outPath) {
    await Bun.write(opts.outPath, summary);
    console.log("");
    console.log(`Summary written to ${opts.outPath}`);
  }
  if (opts.csvPath) {
    await Bun.write(opts.csvPath, csv.join("\n") + "\n");
    console.log(`CSV metrics written to ${opts.csvPath}`);
  }
}

main().catch((err) => {
  console.error("loadtest error:", err?.stack || err?.message || String(err));
  process.exit(1);
});
