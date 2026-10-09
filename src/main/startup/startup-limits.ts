/**
 * Central release bounds for Stage 30 startup/shutdown/packaging.
 * Single definitions — no layer duplicates these numbers.
 */

/** Bounded overall application-shutdown deadline (10 seconds). */
export const MAX_APP_SHUTDOWN_MS = 10_000

/** Hard timeout for one packaged smoke launch (20 seconds). */
export const MAX_PACKAGED_SMOKE_MS = 20_000

/**
 * Explicit main-process startup step ids, in dependency order:
 * lock → protocol handlers → paths → SQLite → services → bounded
 * recovery passes → secured window → usable → non-blocking restore.
 */
export const STARTUP_ORDER: readonly string[] = [
  'single-instance-lock',
  'protocol-handlers',
  'paths',
  'sqlite-open-migrate',
  'core-services',
  'startup-recovery',
  'secured-window',
  'usable',
  'cloud-restore-detached'
]

/**
 * Explicit shutdown step ids, in dependency order: stop accepting
 * privileged work → close Preview/inspection surfaces → stop exact
 * runtime trees → terminate terminals → flush runtime state → close
 * database → exit.
 */
export const SHUTDOWN_ORDER: readonly string[] = [
  'stop-accepting-work',
  'close-preview-surfaces',
  'stop-runtime-trees',
  'terminate-terminals',
  'flush-runtime-state',
  'close-database',
  'exit'
]
