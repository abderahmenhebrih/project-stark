/**
 * PTY environment construction (Stage 11).
 *
 * Built entirely in main: the renderer supplies no environment maps.
 * The current process environment is filtered to valid string values
 * (never logged), then terminal markers are applied. Values are never
 * printed or logged by this module.
 */

export type RawEnvironment = Record<string, string | undefined>

function isValidEnvValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

/**
 * Builds the environment map for node-pty spawn.
 * Filters the host environment to defined non-empty NUL-free strings,
 * then pins TERM/COLORTERM/TERM_PROGRAM for xterm compatibility.
 */
export function buildTerminalEnv(source: RawEnvironment = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key !== '' && !key.includes('\0') && isValidEnvValue(value)) {
      env[key] = value
    }
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'STARK'
  return env
}
