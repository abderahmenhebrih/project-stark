import { previewUrlForPort } from '../../shared/project-runtime/types'
import { InvalidWorkerToolRequestError } from '../worker-tools/worker-tool-errors'

/** One validated preview_inspect approved action: exact frozen target only. */
export interface ValidatedPreviewInspect {
  readonly runtimeId: number
  readonly targetPathAndQueryAndHash: string
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

function isValidPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || !value.startsWith('/')) {
    return false
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    return false
  }
  if ([...value].length > 2048) {
    return false
  }
  // No scheme/host smuggling: frozen paths are origin-relative only.
  if (value.startsWith('//')) {
    return false
  }
  return true
}

/**
 * Strict main-owned validation for preview_inspect worker args.
 * Exactly `{}` — empty object. The Worker may not provide URL, path,
 * host, port, selector, JavaScript, runtimeId, coordinates, or text.
 * Main derives everything.
 */
export function parsePreviewInspectArgs(args: unknown): Record<string, never> {
  if (!hasStrictShape(args, [])) {
    throw new InvalidWorkerToolRequestError('tool arguments are invalid')
  }
  return {}
}

/**
 * Strict validation for the canonical internal approved action
 * `{runtimeId, targetPathAndQueryAndHash}`. Provider/renderer never
 * supply this shape — it is main-derived at request time and
 * hash-bound to the approval.
 */
export function parsePreviewInspectApprovalArgs(args: unknown): ValidatedPreviewInspect {
  if (!hasStrictShape(args, ['runtimeId', 'targetPathAndQueryAndHash'])) {
    throw new InvalidWorkerToolRequestError('approval arguments are invalid')
  }
  const record = args as Record<string, unknown>
  const runtimeId = record['runtimeId']
  const target = record['targetPathAndQueryAndHash']
  if (typeof runtimeId !== 'number' || !Number.isInteger(runtimeId) || runtimeId <= 0) {
    throw new InvalidWorkerToolRequestError('approval arguments are invalid')
  }
  if (!isValidPath(target)) {
    throw new InvalidWorkerToolRequestError('approval arguments are invalid')
  }
  return { runtimeId, targetPathAndQueryAndHash: target }
}

/** Extracts the frozen origin-relative path (pathname + search + hash) from a loopback URL. */
export function extractTargetPath(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
    if (path === '' || !path.startsWith('/')) {
      return '/'
    }
    if ([...path].length > 2048) {
      return '/'
    }
    return path
  } catch {
    return '/'
  }
}

/** Derives the exact loopback inspection URL from an approved port and frozen path. */
export function previewTargetUrlFor(port: number, targetPath: string): string {
  const safePath = isValidPath(targetPath) ? targetPath : '/'
  return `${previewUrlForPort(port).replace(/\/$/, '')}${safePath}`
}

/**
 * Exact human-readable approval summary for one frozen Preview
 * inspection. Shows the loopback Preview path only; never exposes
 * PIDs, storage, or credentials.
 */
export function buildPreviewInspectApprovalSummary(input: { port: number; path: string }): string {
  const safePath = isValidPath(input.path) ? input.path : '/'
  const url = previewTargetUrlFor(input.port, safePath)
  return (
    `Inspect rendered Live Preview\n` +
    `Preview: ${url}\n` +
    `STARK Worker may inspect bounded rendered content from this local Preview once.\n` +
    `STARK does not click, type, submit forms, or modify the DOM.\n` +
    `If needed, STARK may load this approved local Preview path in an isolated inspection window.`
  )
}

/** Canonical policy-deny copy for preview.inspect. */
export const WORKER_PREVIEW_INSPECT_DENY_MESSAGE = 'Live Preview inspection is not allowed for this Workspace.'

/** Canonical copy for human denial of a Preview inspection approval. */
export const WORKER_PREVIEW_USER_DENY_MESSAGE = 'The user denied inspecting this Preview.'

/** Canonical copy when the Preview cannot be loaded. */
export const WORKER_PREVIEW_UNAVAILABLE_MESSAGE = 'The local Preview could not be loaded for inspection.'
