/*
  Generate a human-friendly Markdown report from Ollama load test outputs.

  Inputs:
    - Summary text: scripts/ollama_results.txt
    - Metrics CSV:  scripts/ollama_results.csv

  Output:
    - Markdown report: scripts/ollama_report.md

  Example:
    bun run scripts/ollama_report.ts \
      --summary scripts/ollama_results.txt \
      --csv scripts/ollama_results.csv \
      --out scripts/ollama_report.md \
      --err-threshold 2
*/

interface Row {
  concurrency: number;
  total: number;
  ok: number;
  fail: number;
  timeout: number;
  avg_ms: number;
  min_ms: number;
  p50_ms: number;
  p90_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  wall_s: number;
  rps: number;
  err_rate: number; // computed (fail+timeout)/total
}

interface Options {
  summaryPath?: string;
  csvPath: string;
  outPath: string;
  errThresholdPct: number; // e.g., 2 => 2%
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    csvPath: "scripts/results/ollama_results.csv",
    outPath: "scripts/results/ollama_report.md",
    errThresholdPct: 2,
  } as Options;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (def?: string) => (i + 1 < argv.length ? argv[++i] : def || "");
    switch (a) {
      case "--summary":
        opts.summaryPath = next();
        break;
      case "--csv":
        opts.csvPath = next();
        break;
      case "--out":
        opts.outPath = next();
        break;
      case "--err-threshold":
      case "--err-threshold-pct":
        opts.errThresholdPct = Math.max(0, parseFloat(next()));
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function parseSummaryHeader(text: string) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const meta: Record<string, string> = {};
  for (const ln of lines) {
    if (/^Target:\s*/i.test(ln)) meta.target = ln.replace(/^Target:\s*/i, "");
    else if (/^Model:\s*/i.test(ln)) meta.model = ln.replace(/^Model:\s*/i, "");
    else if (/^Host:\s*/i.test(ln)) meta.host = ln.replace(/^Host:\s*/i, "");
    else if (/^Endpoint:\s*/i.test(ln)) meta.endpoint = ln.replace(/^Endpoint:\s*/i, "");
    else if (/^Sweep:\s*/i.test(ln)) meta.sweep = ln.replace(/^Sweep:\s*/i, "");
    else if (/^Requests per level:\s*/i.test(ln)) meta.requests = ln.replace(/^Requests per level:\s*/i, "");
    else if (/^Duration per level:\s*/i.test(ln)) meta.duration = ln.replace(/^Duration per level:\s*/i, "");
    else if (/^Invocation:\s*/i.test(ln)) meta.invocation = ln.replace(/^Invocation:\s*/i, "");
  }
  return meta;
}

function parseCsvMeta(rawCsv: string) {
  const meta: Record<string, string> = {};
  const lines = rawCsv.split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^#\s*([^=]+)=(.*)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim();
      meta[key] = val;
    }
  }
  return meta;
}

function parseCsv(text: string): Row[] {
  const all = text.trim().split(/\r?\n/);
  const lines = all.filter((ln) => ln.trim() !== "");
  // Skip any commented meta lines starting with '#'
  const dataLines = lines.filter((ln) => !ln.trim().startsWith("#"));
  const header = dataLines.shift();
  if (!header) return [];
  const out: Row[] = [];
  for (const ln of dataLines) {
    if (!ln.trim()) continue;
    const [
      concurrency,
      total,
      ok,
      fail,
      timeout,
      avg_ms,
      min_ms,
      p50_ms,
      p90_ms,
      p95_ms,
      p99_ms,
      max_ms,
      wall_s,
      rps,
    ] = ln.split(",").map((x) => x.trim());

    const t = {
      concurrency: parseInt(concurrency, 10),
      total: parseInt(total, 10),
      ok: parseInt(ok, 10),
      fail: parseInt(fail, 10),
      timeout: parseInt(timeout, 10),
      avg_ms: parseFloat(avg_ms),
      min_ms: parseFloat(min_ms),
      p50_ms: parseFloat(p50_ms),
      p90_ms: parseFloat(p90_ms),
      p95_ms: parseFloat(p95_ms),
      p99_ms: parseFloat(p99_ms),
      max_ms: parseFloat(max_ms),
      wall_s: parseFloat(wall_s),
      rps: parseFloat(rps),
      err_rate: 0,
    } satisfies Row;
    t.err_rate = t.total > 0 ? (t.fail + t.timeout) / t.total : 0;
    out.push(t);
  }
  return out.sort((a, b) => a.concurrency - b.concurrency);
}

function toPct(n: number, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}

function bar(value: number, max: number, width = 40) {
  if (max <= 0) return "";
  const filled = Math.max(0, Math.round((value / max) * width));
  return "█".repeat(filled).padEnd(width, " ");
}

function buildReport(meta: Record<string, string>, rows: Row[], errThresholdPct: number) {
  const errThreshold = errThresholdPct / 100;
  const maxRps = rows.reduce((m, r) => Math.max(m, r.rps), 0);
  const maxP95 = rows.reduce((m, r) => Math.max(m, r.p95_ms), 0);

  // Find peak stable concurrency (<= errThreshold)
  let best: Row | undefined;
  for (const r of rows) {
    if (r.err_rate <= errThreshold) {
      if (!best || r.rps > best.rps) best = r;
    }
  }

  const lines: string[] = [];
  lines.push(`# Ollama Load Test Report`);
  lines.push("");
  lines.push(`- Target: ${meta.target || ""}`);
  lines.push(`- Model: ${meta.model || ""}`);
  if (meta.host) lines.push(`- Host: ${meta.host}`);
  lines.push(`- Endpoint: ${meta.endpoint || ""}`);
  if (meta.duration) lines.push(`- Duration per level: ${meta.duration}`);
  if (meta.requests) lines.push(`- Requests per level: ${meta.requests}`);
  if (meta.sweep) lines.push(`- Concurrency sweep: ${meta.sweep}`);
  lines.push("");

  // Key findings
  lines.push(`## Key Findings`);
  if (best) {
    lines.push(`- Peak stable concurrency (<=${errThresholdPct}% errors): c=${best.concurrency}`);
    lines.push(`  - Throughput: ${best.rps.toFixed(2)} rps, OK=${best.ok}, errors=${toPct(best.err_rate)}`);
    lines.push(`  - Latency: p50=${best.p50_ms.toFixed(0)}ms, p95=${best.p95_ms.toFixed(0)}ms, p99=${best.p99_ms.toFixed(0)}ms`);
  } else {
    lines.push(`- No stable point found under ${errThresholdPct}% error rate.`);
  }
  lines.push("");

  // Tables
  lines.push(`## Metrics by Concurrency`);
  lines.push(`| c | rps | err% | ok | total | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | wall (s) |`);
  lines.push(`| -:| ---:| ----:| --:| ----:| -------:| -------:| -------:| -------:| -------:|`);
  for (const r of rows) {
    lines.push(`| ${r.concurrency} | ${r.rps.toFixed(2)} | ${toPct(r.err_rate)} | ${r.ok} | ${r.total} | ${r.p50_ms.toFixed(0)} | ${r.p95_ms.toFixed(0)} | ${r.p99_ms.toFixed(0)} | ${r.max_ms.toFixed(0)} | ${r.wall_s.toFixed(2)} |`);
  }
  lines.push("");

  // ASCII charts
  lines.push(`## Throughput (RPS) vs Concurrency`);
  for (const r of rows) {
    lines.push(`${String(r.concurrency).padStart(3)} | ${bar(r.rps, maxRps)} ${r.rps.toFixed(2)} rps`);
  }
  lines.push("");
  lines.push(`## Latency p95 (ms) vs Concurrency`);
  for (const r of rows) {
    lines.push(`${String(r.concurrency).padStart(3)} | ${bar(r.p95_ms, maxP95)} ${r.p95_ms.toFixed(0)} ms`);
  }
  lines.push("");

  // Guidance
  lines.push(`## Guidance`);
  lines.push(`- Use the "Peak stable concurrency" as a safe upper bound for concurrent users under the tested prompt and model.`);
  lines.push(`- If you require lower tail latency (e.g., p95 < 1000ms), choose a concurrency below the peak where p95 meets your target.`);
  lines.push(`- Results depend on prompt length, model, and hardware; re-run after changes.`);
  lines.push("");

  if (meta.invocation) {
    lines.push(`## What Was Run`);
    lines.push("```");
    lines.push(meta.invocation);
    lines.push("```");
    lines.push("");
  }

  // Repro
  lines.push(`## Re-run`);
  lines.push(`- Stress test: \`./scripts/ollama_stress_test.sh --sweep 10 -d 60000\``);
  lines.push(`- Report: \`bun run scripts/ollama_report.ts --summary ${meta.summaryPath || "scripts/ollama_results.txt"} --csv ${meta.csvPath || "scripts/ollama_results.csv"} --out scripts/ollama_report.md\``);

  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summaryText = opts.summaryPath ? await Bun.file(opts.summaryPath).text().catch(() => "") : "";
  const csvText = await Bun.file(opts.csvPath).text();
  const metaFromSummary = summaryText ? parseSummaryHeader(summaryText) : {};
  const metaFromCsv = parseCsvMeta(csvText);
  const meta = { ...metaFromCsv, ...metaFromSummary } as Record<string, string>;
  // Include paths so the report can show exact files used
  if (opts.summaryPath) (meta as any).summaryPath = opts.summaryPath;
  (meta as any).csvPath = opts.csvPath;
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("No data rows found in CSV");
  const md = buildReport(meta, rows, opts.errThresholdPct);
  await Bun.write(opts.outPath, md);
  console.log(`Report written to ${opts.outPath}`);
}

main().catch((err) => {
  console.error("ollama report error:", err?.stack || err?.message || String(err));
  process.exit(1);
});
