/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 *
 * Delegates core analysis to the shared runFullAnalysis orchestrator.
 * This CLI wrapper handles: heap management, progress bar, SIGINT,
 * skill generation (--skills), summary output, and process.exit().
 */

import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
import { closeLbug } from '../core/lbug/lbug-adapter.js';
import {
  getStoragePaths,
  getGlobalRegistryPath,
  listRegisteredRepos,
  RegistryNameCollisionError,
} from '../storage/repo-manager.js';
import { getGitRoot, hasGitDir } from '../storage/git.js';
import { runFullAnalysis } from '../core/run-analyze.js';
import { readThresholdsFromEnv, waitForResourceAvailability } from './resource-throttle.js';
import fs from 'fs/promises';
import fsSync from 'fs';

const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;
/** Increase default stack size (KB) to prevent stack overflow on deep class hierarchies. */
const STACK_KB = 4096;
const STACK_FLAG = `--stack-size=${STACK_KB}`;

/** Re-exec the process with an 8GB heap and larger stack if we're currently below that. */
function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  // --stack-size is a V8 flag not allowed in NODE_OPTIONS on Node 24+,
  // so pass it only as a direct CLI argument, not via the environment.
  const cliFlags = [HEAP_FLAG];
  if (!nodeOpts.includes('--stack-size')) cliFlags.push(STACK_FLAG);

  try {
    execFileSync(process.execPath, [...cliFlags, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: any) {
    process.exitCode = e.status ?? 1;
  }
  return true;
}

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /** Index the folder even when no .git directory is present. */
  skipGit?: boolean;
  /**
   * Override the default basename-derived registry `name` with a
   * user-supplied alias (#829). Disambiguates repos whose paths share a
   * basename. Persisted — subsequent re-analyses of the same path without
   * `--name` preserve the alias.
   */
  name?: string;
  /**
   * Allow registration even when another path already uses the same
   * `--name` alias (#829). Intentionally a distinct flag from `--force`
   * because the user may want to coexist under the same name WITHOUT
   * paying the cost of a pipeline re-index. Maps to registerRepo's
   * `allowDuplicateName` option end-to-end.
   */
  allowDuplicateName?: boolean;
  /**
   * Re-index every repo in ~/.gitnexus/registry.json (#253). When set,
   * [path], --name, and --allow-duplicate-name are all rejected — the
   * batch is a fleet operation, not a single-repo command. Each entry
   * is processed by spawning a child `gitnexus analyze <path>` so that
   * state (LadybugDB handles, progress bar, monkey-patched console)
   * never carries between iterations — if one repo crashes, the others
   * proceed untouched. Same per-repo error tolerance as `clean --all`.
   */
  all?: boolean;
  /**
   * Resource-aware throttle toggle for `--all` iterations (#1010 review).
   * Commander stores the CLI `--no-throttle` flag as `throttle: false`
   * (the `--no-` prefix is the commander convention for a negatable
   * boolean default-true option); omitting the flag leaves `throttle`
   * unset / true.
   *
   * Behaviour: by default, before each child spawn we poll CPU + memory
   * and wait while the system is above threshold (80% / 85%, tunable
   * via GITNEXUS_THROTTLE_CPU / GITNEXUS_THROTTLE_MEM). Pass
   * `--no-throttle` on dedicated CI / build agents where you've already
   * accepted the resource cost and want the batch to run flat-out.
   */
  throttle?: boolean;
}

/**
 * `analyze --all` implementation (#253): spawn a child
 * `gitnexus analyze <path>` for each entry in the global registry,
 * inheriting stdio. Child-process isolation means:
 *   - each repo gets a fresh LadybugDB handle, progress bar, and heap
 *   - a crash in one repo cannot bring down sibling cleanups
 *   - the existing analyze flow (SIGINT, ensureHeap, progress-bar
 *     monkey-patching) is reused verbatim — no in-process state
 *     reset hazards
 *
 * Forwarded flags: --force, --embeddings, --skills, --skip-agents-md,
 * --no-stats, --skip-git, -v. NOT forwarded: --name,
 * --allow-duplicate-name (per-repo concepts; validated out above),
 * [path] positional (ditto).
 *
 * Exit code: 0 when all entries succeeded or were cleanly skipped
 * (missing-path entries). 1 when at least one entry's child exited
 * non-zero — surfaces batch partial-failure to cron / CI.
 */
const analyzeAllBranch = async (options: AnalyzeOptions | undefined): Promise<void> => {
  const entries = await listRegisteredRepos();
  if (entries.length === 0) {
    console.log('\n  No indexed repositories found.');
    console.log('  Run `gitnexus analyze <path>` in a repo to index it first.\n');
    return;
  }

  console.log(`\n  GitNexus Analyzer — batch mode (${entries.length} repo(s))\n`);

  // Resolve the CLI entrypoint once so each child spawn re-uses it. Use
  // the same path the current process was launched with — that way
  // `dist/` vs source-via-tsx works identically in CI, dev, and
  // end-user installs. `process.argv[1]` is the path to index.js (or
  // the tsx'd index.ts during tests).
  const cliEntry = process.argv[1];
  if (!cliEntry) {
    console.error('Error: could not determine gitnexus CLI path from process.argv[1].');
    process.exitCode = 1;
    return;
  }

  // Build the forwarded-flag list once — same for every child. This
  // deliberately excludes --all itself (prevents infinite recursion),
  // --name, --allow-duplicate-name (per-repo), and the [path]
  // positional (each child gets the registry entry's path instead).
  const forwarded: string[] = [];
  if (options?.force) forwarded.push('--force');
  if (options?.embeddings) forwarded.push('--embeddings');
  if (options?.skills) forwarded.push('--skills');
  if (options?.skipAgentsMd) forwarded.push('--skip-agents-md');
  if (options?.noStats) forwarded.push('--no-stats');
  if (options?.skipGit) forwarded.push('--skip-git');
  if (options?.verbose) forwarded.push('--verbose');

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  const failedNames: string[] = [];

  // Resource-aware throttle config (#1010 review — @magyargergo).
  // Defaults match the reviewer's sketch (80% CPU / 85% mem); env vars
  // let operators tune without code changes. `--no-throttle` disables
  // the check entirely for CI / build agents that accept the full cost
  // (commander stores the negated flag as `throttle: false`; absence
  // of the flag leaves `throttle` undefined, which we treat as enabled).
  const throttleThresholds = readThresholdsFromEnv();
  const throttleEnabled = options?.throttle !== false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Pace the batch to host headroom BEFORE announcing the repo. That
    // way the "[i/N] Analyzing" heading always reflects work that is
    // actually starting, not a repo queued behind a throttle wait.
    if (throttleEnabled) {
      await waitForResourceAvailability({
        thresholds: throttleThresholds,
        onThrottling: (snapshot) => {
          console.warn(
            `  ⏸ Throttling — CPU ${snapshot.cpuPct.toFixed(1)}% / mem ${snapshot.memPct.toFixed(
              1,
            )}% (thresholds ${throttleThresholds.cpuPct}% / ${throttleThresholds.memPct}%) — ` +
              `waiting before [${i + 1}/${entries.length}]...`,
          );
        },
        onResumed: (snapshot) => {
          console.log(
            `  ▶ Resuming — CPU ${snapshot.cpuPct.toFixed(1)}% / mem ${snapshot.memPct.toFixed(1)}%`,
          );
        },
      });
    }

    console.log(`\n  [${i + 1}/${entries.length}] Analyzing: ${entry.name} (${entry.path})`);

    // Skip entries whose repo has been deleted externally. Same
    // error-tolerance principle as `clean --all`: a stale registry
    // entry should not halt the batch.
    try {
      if (!fsSync.existsSync(entry.path)) {
        console.warn(`  ⚠ Skipped (path no longer exists): ${entry.path}`);
        skipped++;
        continue;
      }
    } catch (err) {
      console.warn(`  ⚠ Skipped (stat error): ${entry.name}: ${(err as Error).message}`);
      skipped++;
      continue;
    }

    // Spawn a child `gitnexus analyze <path>` with the forwarded flags
    // and inherited stdio so the child's own progress bar / logs flow
    // through naturally.
    //
    // Propagating `process.execArgv` is critical for the test suite
    // (and any other tsx-loaded invocation): execArgv holds Node-level
    // flags like `--import <tsx-loader-url>` that aren't part of argv.
    // Without them, the child can't load .ts sources and dies with
    // `ERR_UNKNOWN_FILE_EXTENSION`. In production (npm install of the
    // compiled package), execArgv is typically empty, so this is a
    // no-op — but it makes the CLI equally usable under tsx/tsnode dev
    // setups and in vitest-spawned integration tests.
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, cliEntry, 'analyze', entry.path, ...forwarded],
      {
        stdio: 'inherit',
        env: process.env,
      },
    );

    if (result.status === 0) {
      succeeded++;
    } else {
      failed++;
      failedNames.push(entry.name);
      const reason =
        result.signal !== null
          ? `signal ${result.signal}`
          : result.error
            ? (result.error as Error).message
            : `exit code ${result.status}`;
      console.error(`  ✗ Failed (${reason}): ${entry.name}`);
    }
  }

  console.log(
    `\n  Summary: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed.` +
      (failed > 0 ? `\n  Failed: ${failedNames.join(', ')}\n` : '\n'),
  );

  // Exit non-zero on any failure so cron / CI pick up partial-failure
  // conditions. Skipped entries (missing paths) are NOT failures —
  // they're just registry self-heal candidates that `list --validate`
  // would clean up on next read.
  if (failed > 0) process.exitCode = 1;
};

export const analyzeCommand = async (inputPath?: string, options?: AnalyzeOptions) => {
  if (ensureHeap()) return;

  if (options?.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  // ── `analyze --all` branch (#253) ──────────────────────────────────
  //
  // Validate mutual exclusions up-front so the user sees a clear error
  // BEFORE any registry or filesystem work happens. Each flag is
  // incompatible with --all because it's inherently per-repo:
  //   - [path]              → --all iterates the registry; the user
  //                           can't also pin a single path
  //   - --name <alias>      → an alias targets one repo
  //   - --allow-duplicate-name → same (registry-collision semantics)
  if (options?.all) {
    const violations: string[] = [];
    if (inputPath) violations.push('[path] positional argument');
    if (options.name !== undefined) violations.push('--name <alias>');
    if (options.allowDuplicateName) violations.push('--allow-duplicate-name');
    if (violations.length > 0) {
      console.error(
        `Error: --all cannot be combined with ${violations.join(', ')}. ` +
          `--all re-indexes every registered repo; these flags target a single repo.`,
      );
      process.exitCode = 1;
      return;
    }
    return analyzeAllBranch(options);
  }

  console.log('\n  GitNexus Analyzer\n');

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      if (!options?.skipGit) {
        console.log(
          '  Not inside a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n',
        );
        process.exitCode = 1;
        return;
      }
      // --skip-git: fall back to cwd as the root
      repoPath = path.resolve(process.cwd());
    } else {
      repoPath = gitRoot;
    }
  }

  const repoHasGit = hasGitDir(repoPath);
  if (!repoHasGit && !options?.skipGit) {
    console.log(
      '  Not a git repository.\n  Tip: pass --skip-git to index any folder without a .git directory.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!repoHasGit) {
    console.log(
      '  Warning: no .git directory found \u2014 commit-tracking and incremental updates disabled.\n',
    );
  }

  // KuzuDB migration cleanup is handled by runFullAnalysis internally.
  // Note: --skills is handled after runFullAnalysis using the returned pipelineResult.

  if (process.env.GITNEXUS_NO_GITIGNORE) {
    console.log(
      '  GITNEXUS_NO_GITIGNORE is set — skipping .gitignore (still reading .gitnexusignore)\n',
    );
  }

  // ── CLI progress bar setup ─────────────────────────────────────────
  const bar = new cliProgress.SingleBar(
    {
      format: '  {bar} {percentage}% | {phase}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      barGlue: '',
      autopadding: true,
      clearOnComplete: false,
      stopOnComplete: false,
    },
    cliProgress.Presets.shades_grey,
  );

  bar.start(100, 0, { phase: 'Initializing...' });

  // Graceful SIGINT handling
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1);
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    closeLbug()
      .catch(() => {})
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  // Route console output through bar.log() to prevent progress bar corruption
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  let barCurrentValue = 0;
  const barLog = (...args: any[]) => {
    process.stdout.write('\x1b[2K\r');
    origLog(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    bar.update(barCurrentValue);
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Track elapsed time per phase
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();

  const updateBar = (value: number, phaseLabel: string) => {
    barCurrentValue = value;
    if (phaseLabel !== lastPhaseLabel) {
      lastPhaseLabel = phaseLabel;
      phaseStart = Date.now();
    }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const display = elapsed >= 3 ? `${phaseLabel} (${elapsed}s)` : phaseLabel;
    bar.update(value, { phase: display });
  };

  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      bar.update({ phase: `${lastPhaseLabel} (${elapsed}s)` });
    }
  }, 1000);

  const t0 = Date.now();

  // ── Run shared analysis orchestrator ───────────────────────────────
  try {
    const result = await runFullAnalysis(
      repoPath,
      {
        // Pipeline re-index — OR'd with --skills because skill generation
        // needs a fresh pipelineResult. Has no bearing on the registry
        // collision guard (see allowDuplicateName below).
        force: options?.force || options?.skills,
        embeddings: options?.embeddings,
        skipGit: options?.skipGit,
        skipAgentsMd: options?.skipAgentsMd,
        noStats: options?.noStats,
        registryName: options?.name,
        // Registry-collision bypass — its own CLI flag, intentionally NOT
        // overloading --force. A user who hits the collision guard should
        // be able to accept the duplicate name without also paying the
        // cost of a full pipeline re-index. See #829 review round 2.
        allowDuplicateName: options?.allowDuplicateName,
      },
      {
        onProgress: (_phase, percent, message) => {
          updateBar(percent, message);
        },
        onLog: barLog,
      },
    );

    if (result.alreadyUpToDate) {
      clearInterval(elapsedTimer);
      process.removeListener('SIGINT', sigintHandler);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      bar.stop();
      console.log('  Already up to date\n');
      // Safe to return without process.exit(0) — the early-return path in
      // runFullAnalysis never opens LadybugDB, so no native handles prevent exit.
      return;
    }

    // Skill generation (CLI-only, uses pipeline result from analysis)
    if (options?.skills && result.pipelineResult) {
      updateBar(99, 'Generating skill files...');
      try {
        const { generateSkillFiles } = await import('./skill-gen.js');
        const { generateAIContextFiles } = await import('./ai-context.js');
        const skillResult = await generateSkillFiles(
          repoPath,
          result.repoName,
          result.pipelineResult,
        );
        if (skillResult.skills.length > 0) {
          barLog(`  Generated ${skillResult.skills.length} skill files`);
          // Re-generate AI context files now that we have skill info
          const s = result.stats;
          const communityResult = result.pipelineResult?.communityResult;
          let aggregatedClusterCount = 0;
          if (communityResult?.communities) {
            const groups = new Map<string, number>();
            for (const c of communityResult.communities) {
              const label = c.heuristicLabel || c.label || 'Unknown';
              groups.set(label, (groups.get(label) || 0) + c.symbolCount);
            }
            aggregatedClusterCount = Array.from(groups.values()).filter(
              (count: number) => count >= 5,
            ).length;
          }
          const { storagePath: sp } = getStoragePaths(repoPath);
          await generateAIContextFiles(
            repoPath,
            sp,
            result.repoName,
            {
              files: s.files ?? 0,
              nodes: s.nodes ?? 0,
              edges: s.edges ?? 0,
              communities: s.communities,
              clusters: aggregatedClusterCount,
              processes: s.processes,
            },
            skillResult.skills,
            { skipAgentsMd: options?.skipAgentsMd, noStats: options?.noStats },
          );
        }
      } catch {
        /* best-effort */
      }
    }

    const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);

    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;

    bar.update(100, { phase: 'Done' });
    bar.stop();

    // ── Summary ────────────────────────────────────────────────────
    const s = result.stats;
    console.log(`\n  Repository indexed successfully (${totalTime}s)\n`);
    console.log(
      `  ${(s.nodes ?? 0).toLocaleString()} nodes | ${(s.edges ?? 0).toLocaleString()} edges | ${s.communities ?? 0} clusters | ${s.processes ?? 0} flows`,
    );
    console.log(`  ${repoPath}`);

    try {
      await fs.access(getGlobalRegistryPath());
    } catch {
      console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
    }

    console.log('');
  } catch (err: any) {
    clearInterval(elapsedTimer);
    process.removeListener('SIGINT', sigintHandler);
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    bar.stop();

    const msg = err.message || String(err);

    // Registry name-collision from --name (#829) — surface as an
    // actionable error rather than a generic stack-trace.
    if (err instanceof RegistryNameCollisionError) {
      console.error(`\n  Registry name collision:\n`);
      console.error(`    "${err.registryName}" is already used by "${err.existingPath}".\n`);
      console.error(`  Options:`);
      console.error(`    • Pick a different alias:  gitnexus analyze --name <alias>`);
      console.error(
        `    • Allow the duplicate:     gitnexus analyze --allow-duplicate-name  (leaves "-r ${err.registryName}" ambiguous)`,
      );
      console.error('');
      process.exitCode = 1;
      return;
    }

    console.error(`\n  Analysis failed: ${msg}\n`);

    // Provide helpful guidance for known failure modes
    if (
      msg.includes('Maximum call stack size exceeded') ||
      msg.includes('call stack') ||
      msg.includes('Map maximum size') ||
      msg.includes('Invalid array length') ||
      msg.includes('Invalid string length') ||
      msg.includes('allocation failed') ||
      msg.includes('heap out of memory') ||
      msg.includes('JavaScript heap')
    ) {
      console.error('  This error typically occurs on very large repositories.');
      console.error('  Suggestions:');
      console.error('    1. Add large vendored/generated directories to .gitnexusignore');
      console.error('    2. Increase Node.js heap: NODE_OPTIONS="--max-old-space-size=16384"');
      console.error('    3. Increase stack size: NODE_OPTIONS="--stack-size=4096"');
      console.error('');
    } else if (msg.includes('ERESOLVE') || msg.includes('Could not resolve dependency')) {
      // Note: the original arborist "Cannot destructure property 'package' of
      // 'node.target'" crash happens inside npm *before* gitnexus code runs,
      // so it can't be caught here.  This branch handles dependency-resolution
      // errors that surface at runtime (e.g. dynamic require failures).
      console.error('  This looks like an npm dependency resolution issue.');
      console.error('  Suggestions:');
      console.error('    1. Clear the npm cache:    npm cache clean --force');
      console.error('    2. Update npm:             npm install -g npm@latest');
      console.error('    3. Reinstall gitnexus:     npm install -g gitnexus@latest');
      console.error('    4. Or try npx directly:    npx gitnexus@latest analyze');
      console.error('');
    } else if (
      msg.includes('MODULE_NOT_FOUND') ||
      msg.includes('Cannot find module') ||
      msg.includes('ERR_MODULE_NOT_FOUND')
    ) {
      console.error('  A required module could not be loaded. The installation may be corrupt.');
      console.error('  Suggestions:');
      console.error('    1. Reinstall:   npm install -g gitnexus@latest');
      console.error('    2. Clear cache: npm cache clean --force && npx gitnexus@latest analyze');
      console.error('');
    }

    process.exitCode = 1;
    return;
  }

  // LadybugDB's native module holds open handles that prevent Node from exiting.
  // ONNX Runtime also registers native atexit hooks that segfault on some
  // platforms (#38, #40). Force-exit to ensure clean termination.
  process.exit(0);
};
