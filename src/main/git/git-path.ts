/**
 * Secure repo-relative Git path validation (Stage 12).
 *
 * Diff paths may refer to deleted files, so existence is NEVER checked
 * here — only syntax. Forward-slash repo-relative form is the public
 * representation; backslashes are normalized for comparison only.
 */

import { MAX_GIT_RELATIVE_PATH_CODEPOINTS } from './limits'
import { InvalidGitRequestError } from './errors'

function countCodePoints(value: string): number {
  return [...value].length
}

/**
 * Validates renderer-supplied repo-relative Git paths. Rejects empty,
 * NUL, absolute (POSIX/Windows/drive/UNC), `..` traversal, and overlong
 * payloads. Returns normalized forward-slash form.
 */
export function validateGitRelativePath(rawPath: unknown): string {
  if (typeof rawPath !== 'string') {
    throw new InvalidGitRequestError('Git path must be a string')
  }
  if (rawPath === '') {
    throw new InvalidGitRequestError('Git path must not be empty')
  }
  // NUL written as escape on purpose: no raw control bytes in source.
  if (rawPath.includes('\0')) {
    throw new InvalidGitRequestError('Git path is invalid')
  }
  if (countCodePoints(rawPath) > MAX_GIT_RELATIVE_PATH_CODEPOINTS) {
    throw new InvalidGitRequestError('Git path is too long')
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    throw new InvalidGitRequestError('Git path must be relative')
  }
  if (/^[A-Za-z]:/.test(rawPath)) {
    throw new InvalidGitRequestError('Git path must be relative')
  }
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
    throw new InvalidGitRequestError('Git path must be relative')
  }
  // Normalize separators for segment analysis and public representation.
  const normalized = rawPath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    throw new InvalidGitRequestError('Git path must be relative')
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '..') {
      throw new InvalidGitRequestError('Git path must not traverse')
    }
    if (segment === '' && normalized !== '') {
      // Collapse empty segments (double slashes, trailing slash) — but
      // a bare '.' or empty logical path is rejected below.
      continue
    }
  }
  const meaningful = segments.filter((segment) => segment !== '' && segment !== '.')
  if (meaningful.length === 0) {
    throw new InvalidGitRequestError('Git path must not be empty')
  }
  for (const segment of meaningful) {
    if (segment === '..') {
      throw new InvalidGitRequestError('Git path must not traverse')
    }
  }
  const canonical = meaningful.join('/')
  if (canonical === '' || canonical === '.' || canonical.startsWith('/')) {
    throw new InvalidGitRequestError('Git path must not be empty')
  }
  if (/^[A-Za-z]:/.test(canonical)) {
    throw new InvalidGitRequestError('Git path must be relative')
  }
  return canonical
}

/** Normalizes an already-trusted repo path for membership comparison. */
export function normalizeGitPathForComparison(value: string): string {
  return value.replace(/\\/g, '/')
}
