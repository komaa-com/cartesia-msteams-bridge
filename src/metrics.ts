/**
 * Dependency-free counters exposed at GET /metrics in the Prometheus text
 * exposition format (0.0.4). Telephony ops need at minimum: how many calls,
 * how many right now, how long, and what is being rejected/dropped.
 */

const counts = new Map<string, number>();

const META: Record<string, { help: string; type: "counter" | "gauge" }> = {
  bridge_calls_total: { help: "Calls accepted (worker sessions created)", type: "counter" },
  bridge_calls_active: { help: "Live calls right now", type: "gauge" },
  bridge_call_seconds_total: { help: "Total call duration in seconds", type: "counter" },
  bridge_upgrades_rejected_auth_total: { help: "Upgrades rejected: bad/stale/replayed HMAC", type: "counter" },
  bridge_upgrades_rejected_cap_total: { help: "Upgrades rejected: connection caps", type: "counter" },
  bridge_upgrades_rejected_duplicate_total: { help: "Upgrades rejected: callId already live (409)", type: "counter" },
  bridge_frames_to_agent_total: { help: "Caller audio frames relayed to Cartesia", type: "counter" },
  bridge_frames_to_worker_total: { help: "Agent audio frames relayed to the worker", type: "counter" },
  bridge_frames_dropped_total: { help: "Frames dropped under worker backpressure", type: "counter" },
  bridge_agent_connect_failures_total: { help: "Cartesia Line stream connect failures", type: "counter" },
  bridge_agent_errors_total: { help: "Error events from the Cartesia Line stream", type: "counter" },
};

export function metricInc(name: keyof typeof META, by = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + by);
}

/** Call-duration histogram: what telephony ops actually query (p50/p95/p99). */
const HISTOGRAMS: Record<string, { help: string; buckets: number[] }> = {
  bridge_call_duration_seconds: {
    help: "Call duration distribution in seconds",
    buckets: [30, 60, 120, 300, 600, 1200, 1800, 3600],
  },
};

const histData = new Map<string, { counts: number[]; sum: number; count: number }>();

export function metricObserve(name: keyof typeof HISTOGRAMS, value: number): void {
  const def = HISTOGRAMS[name];
  if (!def) {
    return;
  }
  let h = histData.get(name);
  if (!h) {
    h = { counts: def.buckets.map(() => 0), sum: 0, count: 0 };
    histData.set(name, h);
  }
  for (let i = 0; i < def.buckets.length; i++) {
    if (value <= def.buckets[i]) {
      h.counts[i]++;
    }
  }
  h.sum += value;
  h.count++;
}

export function metricDec(name: keyof typeof META): void {
  metricInc(name, -1);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, meta] of Object.entries(META)) {
    lines.push(`# HELP ${name} ${meta.help}`);
    lines.push(`# TYPE ${name} ${meta.type}`);
    lines.push(`${name} ${counts.get(name) ?? 0}`);
  }
  for (const [name, def] of Object.entries(HISTOGRAMS)) {
    const h = histData.get(name) ?? { counts: def.buckets.map(() => 0), sum: 0, count: 0 };
    lines.push(`# HELP ${name} ${def.help}`);
    lines.push(`# TYPE ${name} histogram`);
    for (let i = 0; i < def.buckets.length; i++) {
      lines.push(`${name}_bucket{le="${def.buckets[i]}"} ${h.counts[i]}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
    lines.push(`${name}_sum ${h.sum}`);
    lines.push(`${name}_count ${h.count}`);
  }
  return lines.join("\n") + "\n";
}
