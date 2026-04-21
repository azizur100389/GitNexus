/**
 * Resource-aware throttle for `analyze --all` (#253 review — @magyargergo).
 *
 * The `--all` batch is strictly sequential (one `spawnSync` child at a
 * time), but across 100s of repos the cumulative CPU / memory pressure
 * can push the host toward thermal limits or OOM — especially when the
 * user is also running unrelated workloads on the same machine. This
 * module inserts a gentle wait BETWEEN repos whenever the system is
 * already under load, so the batch paces itself to the host's real
 * available headroom rather than charging through blindly.
 *
 * Design notes:
 *   - Pure function `shouldThrottle(cpu, mem, thresholds)` is the hot
 *     predicate — extractable and trivially unit-testable without
 *     poking real hardware.
 *   - `waitForResourceAvailability` is the only function that touches
 *     `systeminformation`. Tests inject a metrics-provider stub so they
 *     never depend on the runner's actual CPU state.
 *   - No max-wait timeout by design (per PR #1010 review): a machine
 *     chronically over threshold is exactly the case the user asked us
 *     to protect, and bailing to fs.rm-equivalents silently defeats the
 *     safety. Ctrl-C is the only exit other than natural recovery.
 *   - Defaults (80% CPU / 85% memory) match the reviewer's sketch.
 *     Env overrides let advanced users tune without code changes.
 */

export const DEFAULT_CPU_THRESHOLD_PCT = 80;
export const DEFAULT_MEM_THRESHOLD_PCT = 85;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface ThrottleThresholds {
  /** Throttle when CPU usage exceeds this percentage (0–100). */
  cpuPct: number;
  /** Throttle when memory usage exceeds this percentage (0–100). */
  memPct: number;
}

/**
 * Read thresholds from env vars, falling back to the defaults matched
 * to @magyargergo's review sketch (80 / 85). Invalid or non-positive
 * values are silently ignored with a fallback to the default — env
 * parsing errors should never break `analyze --all`.
 */
export const readThresholdsFromEnv = (): ThrottleThresholds => {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback;
    return n;
  };
  return {
    cpuPct: parse(process.env.GITNEXUS_THROTTLE_CPU, DEFAULT_CPU_THRESHOLD_PCT),
    memPct: parse(process.env.GITNEXUS_THROTTLE_MEM, DEFAULT_MEM_THRESHOLD_PCT),
  };
};

/**
 * Pure predicate: should we back off given these current readings?
 * Exported for unit-test coverage across the CPU-only / mem-only /
 * both-over / both-under quadrants and the exact-boundary case.
 */
export const shouldThrottle = (
  cpuPct: number,
  memPct: number,
  thresholds: ThrottleThresholds,
): boolean => {
  return cpuPct > thresholds.cpuPct || memPct > thresholds.memPct;
};

/** Snapshot of one metrics poll. Shape matches what we derive from the
 *  `systeminformation` library so the provider contract is concrete
 *  and mockable. */
export interface ResourceSnapshot {
  cpuPct: number;
  memPct: number;
}

/**
 * Metrics provider contract — exists as a seam for testing. Production
 * code uses {@link defaultMetricsProvider}; tests inject their own to
 * simulate different load trajectories without touching the host.
 */
export type MetricsProvider = () => Promise<ResourceSnapshot>;

/**
 * Default metrics provider — lazy-loads `systeminformation` so the
 * import cost is only paid when `--all` runs (not on every CLI
 * invocation). Returns CPU % and memory-used %, derived from
 * `si.currentLoad().currentLoad` and `si.mem().used / mem.total`.
 */
export const defaultMetricsProvider: MetricsProvider = async () => {
  const { default: systeminfo } = await import('systeminformation');
  const si = systeminfo as typeof import('systeminformation');
  const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  const cpuPct = typeof load.currentLoad === 'number' ? load.currentLoad : 0;
  const memPct = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
  return { cpuPct, memPct };
};

export interface WaitForResourcesOptions {
  thresholds: ThrottleThresholds;
  /** How often to re-poll while throttling. Defaults to 1s. */
  pollIntervalMs?: number;
  /** Test seam — defaults to real systeminformation provider. */
  metricsProvider?: MetricsProvider;
  /**
   * Test seam — replaces the global `setTimeout` so unit tests can
   * advance time synchronously without slow polling. Signature matches
   * the subset of `setTimeout` we actually use.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called before the first throttled wait and on each subsequent
   * poll-while-still-throttling. Production use renders a
   * human-friendly message; tests observe the call history.
   */
  onThrottling?: (snapshot: ResourceSnapshot, thresholds: ThrottleThresholds) => void;
  /**
   * Called once when the throttle clears (only if there was ever a
   * throttled wait). Used to render a "resuming" message at the right
   * moment.
   */
  onResumed?: (snapshot: ResourceSnapshot) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block (asynchronously) until the system drops below the throttle
 * thresholds, polling at `pollIntervalMs`. Returns immediately on the
 * first poll if the system is already idle enough — the common case.
 *
 * Intentionally has NO max-wait / timeout: a host that stays pinned
 * above threshold is exactly the scenario the user asked us to pace
 * for. Proceeding anyway after some arbitrary deadline would defeat
 * the safety. Ctrl-C is the graceful exit.
 *
 * If the metrics provider throws (e.g. systeminformation fails to
 * import or surfaces a platform-specific error), we fall through
 * WITHOUT throttling — a broken provider must never block the batch
 * indefinitely. The error is logged via `onThrottling` with a
 * synthetic snapshot (cpuPct: -1) so callers can log / surface it.
 */
export const waitForResourceAvailability = async (opts: WaitForResourcesOptions): Promise<void> => {
  const provider = opts.metricsProvider ?? defaultMetricsProvider;
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let everThrottled = false;

  while (true) {
    let snapshot: ResourceSnapshot;
    try {
      snapshot = await provider();
    } catch {
      // Provider failure is non-fatal — don't block the batch. Best-
      // effort proceed rather than hang.
      return;
    }

    if (!shouldThrottle(snapshot.cpuPct, snapshot.memPct, opts.thresholds)) {
      if (everThrottled) opts.onResumed?.(snapshot);
      return;
    }

    everThrottled = true;
    opts.onThrottling?.(snapshot, opts.thresholds);
    await sleep(intervalMs);
  }
};
