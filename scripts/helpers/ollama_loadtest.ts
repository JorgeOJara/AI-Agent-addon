/*
  Load tester for the Ollama server itself.

  - Targets Ollama `/api/chat` or `/api/generate`
  - Optional streaming vs non-streaming
  - Sweeps concurrency levels, measures latency & throughput
  - Writes a human-readable summary and optional CSV

  Environment:
    OLLAMA_HOST (default: localhost)
    OLLAMA_PORT (default: 11434)
    OLLAMA_MODEL (default: llama3.2)

  Example:
    bun run scripts/ollama_loadtest.ts \
      --endpoint chat \
      --model llama3.2:3b \
      --sweep 1,2,5,10 \
      --requests 50 \
      --message "Explain your capabilities" \
      --timeout 120000 \
      --out scripts/ollama_results.txt \
      --csv scripts/ollama_results.csv
*/

import os from "os";

type Endpoint = "chat" | "generate";

interface Options {
  url: string;              // base http://host:port
  model: string;
  endpoint: Endpoint;       // chat | generate
  stream: boolean;          // stream true/false
  sweep: number[];          // list of concurrency levels
  requests: number;         // total requests per concurrency level
  durationMs?: number;      // if set, run each level for this duration instead of fixed requests
  message: string;
  timeoutMs: number;        // per-request timeout
  warmup: number;           // per-worker warmup requests (not measured)
  sleepMs: number;          // delay between requests per worker
  outPath?: string;         // summary file path
  csvPath?: string;         // csv file path
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
  const host = process.env.OLLAMA_HOST || "localhost";
  const port = process.env.OLLAMA_PORT || "11434";
  const model = process.env.OLLAMA_MODEL || "llama3.2";

  const opts: Options = {
    url: `http://${host}:${port}`,
    model,
    endpoint: "chat",
    stream: false,
    sweep: [1, 2, 5, 10, 15, 20, 30, 40],
    requests: 50,
    message: "Summarize this system in two sentences.",
    timeoutMs: 120000,
    warmup: 0,
    sleepMs: 0,
    outPath: undefined,
    csvPath: "scripts/results/ollama_results.csv",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (def?: string) => (i + 1 < argv.length ? argv[++i] : def || "");
    switch (a) {
      case "--url":
        opts.url = next();
        break;
      case "--host": {
        const h = next();
        const u = new URL(opts.url);
        u.hostname = h;
        opts.url = u.toString().replace(/\/$/, "");
        break;
      }
      case "--port": {
        const p = next();
        const u = new URL(opts.url);
        u.port = p;
        opts.url = u.toString().replace(/\/$/, "");
        break;
      }
      case "--model":
        opts.model = next();
        break;
      case "--endpoint": {
        const v = next();
        if (v !== "chat" && v !== "generate") throw new Error(`Invalid --endpoint ${v}`);
        opts.endpoint = v;
        break;
      }
      case "--stream": {
        const v = next();
        opts.stream = v === "1" || v === "true" || v === "yes";
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
      case "--duration":
      case "--duration-ms": {
        const v = parseInt(next(), 10);
        if (!(v > 0)) throw new Error("--duration must be > 0 ms");
        opts.durationMs = v;
        break;
      }
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
  // Normalize URL
  opts.url = opts.url.replace(/\/$/, "");
  return opts;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function doRequest(opts: Options): Promise<{ ok: boolean; ms: number; err?: string }>
{
  const url = `${opts.url}/api/${opts.endpoint}`;
  const start = performance.now();
  try {
    const body = opts.endpoint === "chat" ?
      {
        model: opts.model,
        messages: [{ role: "user", content: opts.message }],
        stream: opts.stream,
        keep_alive: -1,
        options: { temperature: 0.3, num_ctx: 16384 },
      } :
      {
        model: opts.model,
        prompt: opts.message,
        stream: opts.stream,
        keep_alive: -1,
        options: { temperature: 0.3, num_ctx: 16384 },
      };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    if (!res.ok) {
      try { await res.arrayBuffer(); } catch {}
      return { ok: false, ms: performance.now() - start, err: `HTTP ${res.status}` };
    }

    if (!opts.stream) {
      // Non-streaming: read JSON and discard
      try { await res.json(); } catch { await res.arrayBuffer(); }
    } else {
      // Streaming: drain the stream
      if (!res.body) return { ok: false, ms: performance.now() - start, err: "no-body" };
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
  const totalRequested = opts.durationMs ? undefined : opts.requests;
  const perWorker = totalRequested ? Math.floor(totalRequested / concurrency) : undefined;
  const remainder = totalRequested ? (totalRequested % concurrency) : 0;

  let ok = 0, fail = 0, timeout = 0;
  const latencies: number[] = [];
  const endTime = opts.durationMs ? performance.now() + opts.durationMs : undefined;

  const worker = async (count?: number) => {
    // Warmup (not measured)
    for (let i = 0; i < opts.warmup; i++) {
      await doRequest(opts);
      if (opts.sleepMs) await sleep(opts.sleepMs);
    }

    // Measured runs
    if (endTime) {
      // Duration mode: loop until deadline
      while (true) {
        const now = performance.now();
        if (now >= endTime) break;
        const r = await doRequest(opts);
        if (r.ok) {
          ok++;
          latencies.push(r.ms);
        } else {
          if (r.err === "timeout") timeout++; else fail++;
        }
        if (opts.sleepMs) await sleep(opts.sleepMs);
      }
    } else if (count && count > 0) {
      for (let i = 0; i < count; i++) {
        const r = await doRequest(opts);
        if (r.ok) {
          ok++;
          latencies.push(r.ms);
        } else {
          if (r.err === "timeout") timeout++; else fail++;
        }
        if (opts.sleepMs) await sleep(opts.sleepMs);
      }
    }
  };

  const tasks: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    const count = perWorker !== undefined ? (perWorker + (i < remainder ? 1 : 0)) : undefined;
    tasks.push(worker(count));
  }

  const t0 = performance.now();
  await Promise.all(tasks);
  const wallMs = performance.now() - t0;

  const total = totalRequested ?? (ok + fail + timeout);
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

  console.log(`Target OLLAMA_URL=${opts.url}`);
  console.log(`Model=${opts.model} | Endpoint=${opts.endpoint} | Stream=${opts.stream}`);
  if (opts.durationMs && opts.durationMs > 0) {
    console.log(`Sweep=${opts.sweep.join(",")} | Duration per level=${opts.durationMs}ms`);
  } else {
    console.log(`Sweep=${opts.sweep.join(",")} | Requests per level=${opts.requests}`);
  }
  if (opts.warmup) console.log(`Warmup per worker=${opts.warmup}`);
  if (opts.sleepMs) console.log(`Sleep per request=${opts.sleepMs}ms`);
  console.log("");

  const lines: string[] = [];
  const csv: string[] = [];
  csv.push("concurrency,total,ok,fail,timeout,avg_ms,min_ms,p50_ms,p90_ms,p95_ms,p99_ms,max_ms,wall_s,rps");
  const allMetrics: LevelMetrics[] = [];

  for (const c of opts.sweep) {
    console.log(`Running concurrency=${c} ...`);
    const m = await runLevel(opts, c);
    const row = renderSummaryRow(m);
    console.log(row.line);
    lines.push(row.line);
    csv.push(row.csv);
    allMetrics.push(m);
  }

  const now = new Date().toISOString();
  const cpuCount = Math.max(1, (os.cpus()?.length || 1));
  const hostInfo = `${os.hostname()} (${os.platform()}/${os.arch()}, ${cpuCount} vCPU, ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GB RAM)`;
  const invocationParts = [
    `bun run scripts/ollama_loadtest.ts`,
    `--url ${opts.url}`,
    `--model ${opts.model}`,
    `--endpoint ${opts.endpoint}`,
    `--stream ${String(opts.stream)}`,
    `--sweep ${opts.sweep.join(",")}`,
    opts.durationMs && opts.durationMs > 0 ? `--duration ${opts.durationMs}` : `--requests ${opts.requests}`,
    opts.warmup ? `--warmup ${opts.warmup}` : undefined,
    opts.sleepMs ? `--sleep ${opts.sleepMs}` : undefined,
  ].filter(Boolean) as string[];
  const invocation = invocationParts.join(" ");
  const header = [
    `Ollama Load Test Summary (${now})`,
    `Target: ${opts.url}`,
    `Model: ${opts.model}`,
    `Host: ${hostInfo}`,
    `Endpoint: ${opts.endpoint}${opts.stream ? " (stream)" : ""}`,
    `Sweep: ${opts.sweep.join(", ")}`,
    opts.durationMs && opts.durationMs > 0 ? `Duration per level: ${opts.durationMs}ms` : `Requests per level: ${opts.requests}`,
    opts.warmup ? `Warmup per worker: ${opts.warmup}` : undefined,
    opts.sleepMs ? `Sleep per request: ${opts.sleepMs}ms` : undefined,
    `Invocation: ${invocation}`,
    "",
    "c=..  req=..  ok=..  fail=..  tout=..  p50=.. p95=.. max=.. rps=.. wall=..",
  ].filter(Boolean).join("\n");

  // Compute a simple peak recommendation: highest RPS with <= 2% (fail+timeout)/total
  let peakLine = "";
  if (allMetrics.length) {
    let best: { c: number; rps: number; errRate: number } | null = null;
    for (const m of allMetrics) {
      const errs = m.fail + m.timeout;
      const errRate = m.total > 0 ? (errs / m.total) : 0;
      const rps = m.wallMs > 0 ? (m.ok / (m.wallMs / 1000)) : 0;
      if (errRate <= 0.02) {
        if (!best || rps > best.rps) best = { c: m.concurrency, rps, errRate };
      }
    }
    if (best) {
      peakLine = `\nPeak (<=2% errors): c=${best.c}, rps=${best.rps.toFixed(2)}, err_rate=${(best.errRate*100).toFixed(1)}%`;
    }
  }

  const summary = `${header}\n${lines.join("\n")}\n${peakLine}\n`;

  if (opts.outPath) {
    await Bun.write(opts.outPath, summary);
    console.log("");
    console.log(`Summary written to ${opts.outPath}`);
  }
  if (opts.csvPath) {
    const meta = [
      `# target=${opts.url}`,
      `# model=${opts.model}`,
      `# host=${os.hostname()}`,
      `# endpoint=${opts.endpoint}`,
      `# stream=${opts.stream}`,
      `# sweep=${opts.sweep.join(",")}`,
      opts.durationMs && opts.durationMs > 0 ? `# duration_ms=${opts.durationMs}` : `# requests=${opts.requests}`,
      opts.warmup ? `# warmup=${opts.warmup}` : undefined,
      opts.sleepMs ? `# sleep_ms=${opts.sleepMs}` : undefined,
      `# invocation=${invocation}`,
    ].filter(Boolean).join("\n");
    await Bun.write(opts.csvPath, meta + "\n" + csv.join("\n") + "\n");
    console.log(`CSV metrics written to ${opts.csvPath}`);
  }
}

main().catch((err) => {
  console.error("ollama loadtest error:", err?.stack || err?.message || String(err));
  process.exit(1);
});
