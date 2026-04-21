/**
 * Unit tests for the resource-aware throttle used by `analyze --all`
 * (#1010 review — @magyargergo).
 *
 * All tests use injected metrics providers + a fake `sleep` fn so they
 * run synchronously without polling the real host, and so coverage
 * doesn't depend on the runner's CPU state. The sketch these tests
 * lock in:
 *   - pure `shouldThrottle` predicate across boundary / quadrant cases
 *   - `waitForResourceAvailability` returns immediately when the
 *     system is idle enough on the first poll
 *   - polls repeatedly until the system drops below thresholds, then
 *     resumes — and calls `onThrottling` / `onResumed` exactly when the
 *     CLI render points expect
 *   - survives a metrics-provider throw without blocking the batch
 *   - env-var overrides parse correctly (with fallback on invalid)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_CPU_THRESHOLD_PCT,
  DEFAULT_MEM_THRESHOLD_PCT,
  THRESHOLD_RISK_WARNING_PCT,
  areThresholdsRisky,
  readThresholdsFromEnv,
  shouldThrottle,
  waitForResourceAvailability,
  warnIfThresholdsRisky,
  type MetricsProvider,
  type ResourceSnapshot,
  type ThrottleThresholds,
} from '../../src/cli/resource-throttle.js';

const noopSleep = (): Promise<void> => Promise.resolve();

const thresholds: ThrottleThresholds = {
  cpuPct: 80,
  memPct: 85,
};

/** Build a provider that returns each snapshot in sequence, then
 *  repeats the last one. Mirrors how tests want to simulate a
 *  "throttled until N polls, then clears" trajectory. */
const sequenceProvider = (snapshots: ResourceSnapshot[]): MetricsProvider => {
  let i = 0;
  return async () => {
    const s = snapshots[Math.min(i, snapshots.length - 1)];
    i++;
    return s;
  };
};

// ─── shouldThrottle ───────────────────────────────────────────────────

describe('shouldThrottle', () => {
  it('returns false when both CPU and memory are well below thresholds', () => {
    expect(shouldThrottle(50, 60, thresholds)).toBe(false);
    expect(shouldThrottle(0, 0, thresholds)).toBe(false);
  });

  it('returns false when BOTH are exactly at the threshold (strict > semantics)', () => {
    // `> threshold` (strict) — boundary value itself is NOT throttled.
    // This matches the reviewer's sketch (`> CPU_THRESHOLD`) exactly.
    expect(shouldThrottle(80, 85, thresholds)).toBe(false);
  });

  it('returns true when only CPU is over threshold', () => {
    expect(shouldThrottle(81, 0, thresholds)).toBe(true);
    expect(shouldThrottle(100, 20, thresholds)).toBe(true);
  });

  it('returns true when only memory is over threshold', () => {
    expect(shouldThrottle(10, 86, thresholds)).toBe(true);
    expect(shouldThrottle(0, 100, thresholds)).toBe(true);
  });

  it('returns true when both are over threshold', () => {
    expect(shouldThrottle(95, 95, thresholds)).toBe(true);
  });

  it('respects custom thresholds independently', () => {
    const tight: ThrottleThresholds = { cpuPct: 40, memPct: 50 };
    expect(shouldThrottle(45, 45, tight)).toBe(true); // CPU over
    expect(shouldThrottle(30, 60, tight)).toBe(true); // mem over
    expect(shouldThrottle(30, 30, tight)).toBe(false); // both under
  });
});

// ─── waitForResourceAvailability ──────────────────────────────────────

describe('waitForResourceAvailability', () => {
  it('returns immediately when the first poll is already below threshold', async () => {
    const provider = sequenceProvider([{ cpuPct: 10, memPct: 20 }]);
    const throttleCalls: ResourceSnapshot[] = [];
    const resumeCalls: ResourceSnapshot[] = [];

    await waitForResourceAvailability({
      thresholds,
      metricsProvider: provider,
      sleep: noopSleep,
      onThrottling: (s) => throttleCalls.push(s),
      onResumed: (s) => resumeCalls.push(s),
    });

    // Idle on first poll → no throttle callbacks, no resume callback
    // (resume only fires after at least one throttle).
    expect(throttleCalls).toHaveLength(0);
    expect(resumeCalls).toHaveLength(0);
  });

  it('polls until the system drops below threshold, then resumes', async () => {
    // Trajectory: 3 polls over threshold, then drops below.
    const provider = sequenceProvider([
      { cpuPct: 95, memPct: 30 }, // over (cpu)
      { cpuPct: 92, memPct: 30 }, // over (cpu)
      { cpuPct: 85, memPct: 90 }, // over (mem)
      { cpuPct: 50, memPct: 40 }, // clear
    ]);
    const throttleCalls: ResourceSnapshot[] = [];
    const resumeCalls: ResourceSnapshot[] = [];

    await waitForResourceAvailability({
      thresholds,
      metricsProvider: provider,
      sleep: noopSleep,
      onThrottling: (s) => throttleCalls.push(s),
      onResumed: (s) => resumeCalls.push(s),
    });

    // 3 throttle announcements, 1 resume at the end with the clearing
    // snapshot.
    expect(throttleCalls).toHaveLength(3);
    expect(throttleCalls[0].cpuPct).toBe(95);
    expect(throttleCalls[2].memPct).toBe(90);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].cpuPct).toBe(50);
  });

  it('falls through without blocking when the metrics provider throws', async () => {
    // A broken provider must never hang the batch indefinitely.
    const failing: MetricsProvider = async () => {
      throw new Error('systeminformation unavailable');
    };
    const throttleCalls: ResourceSnapshot[] = [];
    const resumeCalls: ResourceSnapshot[] = [];

    // Must resolve cleanly even though the provider always throws.
    await waitForResourceAvailability({
      thresholds,
      metricsProvider: failing,
      sleep: noopSleep,
      onThrottling: (s) => throttleCalls.push(s),
      onResumed: (s) => resumeCalls.push(s),
    });

    expect(throttleCalls).toHaveLength(0);
    expect(resumeCalls).toHaveLength(0);
  });

  it('does not emit onResumed if it never throttled in the first place', async () => {
    const provider = sequenceProvider([{ cpuPct: 0, memPct: 0 }]);
    const resumeCalls: ResourceSnapshot[] = [];

    await waitForResourceAvailability({
      thresholds,
      metricsProvider: provider,
      sleep: noopSleep,
      onResumed: (s) => resumeCalls.push(s),
    });

    // Pre-condition was already clear — no "resumed" message needed.
    expect(resumeCalls).toHaveLength(0);
  });

  it('respects the pollIntervalMs by passing it to the sleep fn', async () => {
    const provider = sequenceProvider([
      { cpuPct: 95, memPct: 0 }, // over
      { cpuPct: 10, memPct: 0 }, // clear
    ]);
    const sleepCalls: number[] = [];
    const capturingSleep = (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };

    await waitForResourceAvailability({
      thresholds,
      metricsProvider: provider,
      sleep: capturingSleep,
      pollIntervalMs: 42,
    });

    // One throttle poll → one sleep call with the configured interval.
    expect(sleepCalls).toEqual([42]);
  });
});

// ─── readThresholdsFromEnv ────────────────────────────────────────────

describe('readThresholdsFromEnv', () => {
  const savedCpu = process.env.GITNEXUS_THROTTLE_CPU;
  const savedMem = process.env.GITNEXUS_THROTTLE_MEM;

  afterEach(() => {
    if (savedCpu === undefined) delete process.env.GITNEXUS_THROTTLE_CPU;
    else process.env.GITNEXUS_THROTTLE_CPU = savedCpu;
    if (savedMem === undefined) delete process.env.GITNEXUS_THROTTLE_MEM;
    else process.env.GITNEXUS_THROTTLE_MEM = savedMem;
  });

  it('returns defaults when env vars are unset', () => {
    delete process.env.GITNEXUS_THROTTLE_CPU;
    delete process.env.GITNEXUS_THROTTLE_MEM;
    const t = readThresholdsFromEnv();
    expect(t.cpuPct).toBe(DEFAULT_CPU_THRESHOLD_PCT);
    expect(t.memPct).toBe(DEFAULT_MEM_THRESHOLD_PCT);
  });

  it('parses valid numeric env vars', () => {
    process.env.GITNEXUS_THROTTLE_CPU = '75';
    process.env.GITNEXUS_THROTTLE_MEM = '90';
    const t = readThresholdsFromEnv();
    expect(t.cpuPct).toBe(75);
    expect(t.memPct).toBe(90);
  });

  it('falls back to defaults on invalid input (NaN, zero, negative, > 100)', () => {
    for (const bad of ['abc', '0', '-10', '150', '']) {
      process.env.GITNEXUS_THROTTLE_CPU = bad;
      process.env.GITNEXUS_THROTTLE_MEM = bad;
      const t = readThresholdsFromEnv();
      expect(t.cpuPct, `CPU fallback for ${bad}`).toBe(DEFAULT_CPU_THRESHOLD_PCT);
      expect(t.memPct, `mem fallback for ${bad}`).toBe(DEFAULT_MEM_THRESHOLD_PCT);
    }
  });

  it('accepts fractional percentages (e.g. 82.5)', () => {
    process.env.GITNEXUS_THROTTLE_CPU = '82.5';
    process.env.GITNEXUS_THROTTLE_MEM = '93.2';
    const t = readThresholdsFromEnv();
    expect(t.cpuPct).toBe(82.5);
    expect(t.memPct).toBe(93.2);
  });
});

// ─── areThresholdsRisky / warnIfThresholdsRisky ──────────────────────
//
// Post-#1010 review round 2: @magyargergo removed the `--no-throttle`
// bypass and asked for "a warning on overusing resources" when env
// vars are tuned past the point where the safeguard still meaningfully
// protects. The boundary is THRESHOLD_RISK_WARNING_PCT = 90%.

describe('areThresholdsRisky', () => {
  it('returns false for the shipped defaults (80 / 85)', () => {
    expect(
      areThresholdsRisky({
        cpuPct: DEFAULT_CPU_THRESHOLD_PCT,
        memPct: DEFAULT_MEM_THRESHOLD_PCT,
      }),
    ).toBe(false);
  });

  it('returns true when CPU alone is at or above the warning boundary (>= 90)', () => {
    expect(areThresholdsRisky({ cpuPct: 90, memPct: 50 })).toBe(true);
    expect(areThresholdsRisky({ cpuPct: 99, memPct: 50 })).toBe(true);
  });

  it('returns true when memory alone is at or above the warning boundary', () => {
    expect(areThresholdsRisky({ cpuPct: 50, memPct: 90 })).toBe(true);
    expect(areThresholdsRisky({ cpuPct: 50, memPct: 95 })).toBe(true);
  });

  it('returns true when both are risky', () => {
    expect(areThresholdsRisky({ cpuPct: 95, memPct: 95 })).toBe(true);
  });

  it('returns false at exactly one below the boundary (89.9)', () => {
    // The boundary is INCLUSIVE (>= 90 is risky). 89.9 is the last
    // safe tick for CPU; mem left at default.
    expect(areThresholdsRisky({ cpuPct: 89.9, memPct: DEFAULT_MEM_THRESHOLD_PCT })).toBe(false);
  });

  it('the warning boundary constant matches the documented 90%', () => {
    // Locks in the doc contract — the help text and JSDoc both say
    // "raised above 90%", so this constant must reflect that.
    expect(THRESHOLD_RISK_WARNING_PCT).toBe(90);
  });
});

describe('warnIfThresholdsRisky', () => {
  it('no-ops when thresholds are at defaults', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfThresholdsRisky({
        cpuPct: DEFAULT_CPU_THRESHOLD_PCT,
        memPct: DEFAULT_MEM_THRESHOLD_PCT,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('emits a warning naming CPU when only CPU is risky', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfThresholdsRisky({ cpuPct: 95, memPct: DEFAULT_MEM_THRESHOLD_PCT });
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('CPU=95%');
      // Mem at default must NOT be in the warning — specificity matters.
      expect(msg).not.toContain('memory=');
      // Always suggests the defaults in the remediation text.
      expect(msg).toMatch(/GITNEXUS_THROTTLE_CPU/);
      expect(msg).toMatch(/80 \/ 85/);
    } finally {
      warn.mockRestore();
    }
  });

  it('emits a warning naming memory when only memory is risky', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfThresholdsRisky({ cpuPct: DEFAULT_CPU_THRESHOLD_PCT, memPct: 92 });
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('memory=92%');
      expect(msg).not.toContain('CPU=');
    } finally {
      warn.mockRestore();
    }
  });

  it('emits a single warning listing both when both are risky', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfThresholdsRisky({ cpuPct: 91, memPct: 95 });
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain('CPU=91%');
      expect(msg).toContain('memory=95%');
    } finally {
      warn.mockRestore();
    }
  });
});
