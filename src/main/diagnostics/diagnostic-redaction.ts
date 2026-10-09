/**
 * Diagnostic redaction (Stage 30).
 *
 * Every diagnostic line passes through here before memory or disk.
 * Allowed: timestamps, severity, subsystem, safe categories,
 * operations, durations, bounded safe messages. Forbidden patterns
 * below are replaced with [redacted] — API keys, OAuth tokens,
 * authorization codes, PKCE verifiers, bearer material, provider
 * prompts/bodies, file contents, terminal output, runtime logs,
 * Preview DOM, and raw environments never reach diagnostics.
 */

const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /refresh_token\s*[:=]\s*\S+/gi,
  /access_token\s*[:=]\s*\S+/gi,
  /authorization\s*[:=]\s*\S+/gi,
  /(?:^|[\s?&;])code=\S+/gi,
  /verifier\s*[:=]\s*\S+/gi,
  /SUPABASE_SERVICE_ROLE\S*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
]

/** Redacts secret-bearing patterns from one diagnostic message. */
export function redactForLog(message: string): string {
  let redacted = message
  for (const pattern of REDACTION_PATTERNS) {
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, '[redacted]')
  }
  return redacted
}

/**
 * True when a message contains no recognizable secret pattern.
 * Tests use this to audit logger outputs and public errors.
 */
export function isRedactedForLog(message: string): boolean {
  const probes = [
    /sk-[A-Za-z0-9_-]{8,}/,
    /Bearer\s+[A-Za-z0-9\-._~+/=]+/i,
    /refresh_token\s*[:=]\s*\S+/i,
    /access_token\s*[:=]\s*\S+/i,
    /(?:^|[\s?&;])code=\S+/i
  ]
  return !probes.some((probe) => probe.test(message))
}
