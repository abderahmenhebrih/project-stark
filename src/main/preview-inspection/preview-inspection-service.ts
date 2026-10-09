import { TextEncoder } from 'node:util'
import { previewUrlForPort } from '../../shared/project-runtime/types'
import { isAllowedPreviewNavigation } from '../project-runtime/runtime-preview'
import type { StoredRuntimeSession } from '../project-runtime/project-runtime-repository'
import {
  MAX_PREVIEW_ELEMENT_TEXT_CODEPOINTS,
  MAX_PREVIEW_INSPECTION_ELEMENTS,
  MAX_PREVIEW_INSPECTION_LOAD_MS,
  MAX_PREVIEW_INSPECTION_RESULT_BYTES,
  MAX_PREVIEW_VISIBLE_TEXT_BYTES
} from '../worker-tools/worker-tool-limits'
import { MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT } from './preview-inspection-script'
import { extractTargetPath, previewTargetUrlFor } from './preview-inspection-validation'

const encoder = new TextEncoder()

/** Raw snapshot collected by the main-owned script (untrusted page DATA). */
export interface RawPreviewSnapshot {
  readonly title: unknown
  readonly readyState: unknown
  readonly url: unknown
  readonly visibleText: unknown
  readonly elements: unknown
}

export interface RawPreviewElement {
  readonly tag: unknown
  readonly role: unknown
  readonly type: unknown
  readonly name: unknown
  readonly ariaLabel: unknown
  readonly placeholder: unknown
  readonly text: unknown
  readonly href: unknown
}

/** Bounded sanitized element returned to the Worker (metadata only, never values). */
export interface SanitizedPreviewElement {
  readonly tag: string
  readonly role: string | null
  readonly type: string | null
  readonly name: string | null
  readonly ariaLabel: string | null
  readonly placeholder: string | null
  readonly text: string
  readonly href: string | null
}

/** Bounded structured snapshot returned to the Worker as DATA. */
export interface BoundedPreviewSnapshot {
  readonly status: 'inspected' | 'preview_unavailable'
  readonly payloadJson: string
}

function truncateCodePoints(value: string, max: number): string {
  const points = [...value]
  if (points.length <= max) {
    return value
  }
  return points.slice(0, max).join('')
}

function truncateUtf8Bytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (encoder.encode(value).byteLength <= maxBytes) {
    return { text: value, truncated: false }
  }
  const points = [...value]
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const candidate = points.slice(0, mid).join('')
    if (encoder.encode(candidate).byteLength <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return { text: points.slice(0, low).join(''), truncated: true }
}

function asSafeText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  const withoutNul = value.replace(/\0/g, '')
  return truncateCodePoints(withoutNul, maxCodePoints)
}

/**
 * Sanitizes one raw element to metadata only. Drops input values,
 * site data, scripts, and styles by construction (the raw script
 * never collects them). External hrefs become null; same
 * managed-runtime origin hrefs collapse to path + search + hash.
 */
export function sanitizePreviewElement(raw: RawPreviewElement, port: number): SanitizedPreviewElement {
  const tag = typeof raw.tag === 'string' ? raw.tag.toLowerCase().slice(0, 32) : ''
  const role = typeof raw.role === 'string' && raw.role !== '' ? raw.role.slice(0, 128) : null
  const type = typeof raw.type === 'string' && raw.type !== '' ? raw.type.slice(0, 64) : null
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name.slice(0, 128) : null
  const ariaLabel = typeof raw.ariaLabel === 'string' && raw.ariaLabel !== '' ? raw.ariaLabel.slice(0, 256) : null
  const placeholder =
    typeof raw.placeholder === 'string' && raw.placeholder !== '' ? raw.placeholder.slice(0, 256) : null
  const text = asSafeText(raw.text, MAX_PREVIEW_ELEMENT_TEXT_CODEPOINTS)
  let href: string | null = null
  if (typeof raw.href === 'string' && raw.href !== '') {
    href = sanitizeHref(raw.href, port)
  }
  return { tag, role, type, name, ariaLabel, placeholder, text, href }
}

/** Collapses same-origin hrefs to path-only; external/invalid become null. */
export function sanitizeHref(href: string, port: number): string | null {
  const trimmed = href.trim()
  if (trimmed === '') {
    return null
  }
  // Origin-relative paths pass through (bounded, no authority).
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    try {
      const probe = new URL(trimmed, previewUrlForPort(port))
      void probe
      return [...trimmed].length > 2048 ? null : trimmed
    } catch {
      return null
    }
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:') {
      return null
    }
    if (parsed.hostname !== '127.0.0.1') {
      return null
    }
    const effectivePort = parsed.port === '' ? 80 : Number(parsed.port)
    if (!Number.isInteger(effectivePort) || effectivePort !== port) {
      return null
    }
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
    if (path === '' || !path.startsWith('/')) {
      return '/'
    }
    return [...path].length > 2048 ? null : path
  } catch {
    return null
  }
}

/** Minimal active-runtime source (repository or service adapter). */
export interface PreviewRuntimeSource {
  findActiveForWorkspace(workspaceId: number): StoredRuntimeSession | undefined
  findById(id: number): StoredRuntimeSession | undefined
}

/** Hidden inspection window surface (fake in tests, Electron in production). */
export interface HiddenInspectionWindow {
  loadURL(url: string): Promise<void>
  collectSnapshot(): Promise<RawPreviewSnapshot>
  destroy(): void
  isDestroyed(): boolean
}

export interface PreviewInspectionDeps {
  readonly runtimes: PreviewRuntimeSource
  /** Current human Preview URL for one runtime, or null when closed. */
  readonly getVisiblePreviewUrl?: (runtimeId: number) => string | null
  /** Read-only snapshot from the visible Preview (no navigation). */
  readonly inspectVisible?: (runtimeId: number) => Promise<RawPreviewSnapshot>
  /** Creates one temporary hidden inspector tied to the runtime partition. */
  readonly createHiddenInspector?: (input: { runtimeId: number; port: number; url: string }) => HiddenInspectionWindow
  readonly now?: () => number
  /** Bounded load deadline override (tests only). Defaults to 10s. */
  readonly loadTimeoutMs?: number
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('preview load timed out'))
    }, Math.max(0, ms))
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  })
}

/**
 * Read-only Preview inspection service (Stage 27, main only).
 * Resolves the active managed runtime, derives the inspection target
 * main-side (visible current URL or loopback root), performs exactly
 * ONE bounded page-load attempt maximum when a hidden inspector is
 * needed (no retry, no polling), collects via the single constant
 * main-owned script, sanitizes with privacy bounds, and destroys the
 * hidden window immediately. Zero provider calls.
 */
export class PreviewInspectionService {
  private readonly now: () => number
  private readonly loadTimeoutMs: number

  constructor(private readonly deps: PreviewInspectionDeps) {
    this.now = deps.now ?? Date.now
    this.loadTimeoutMs = deps.loadTimeoutMs ?? MAX_PREVIEW_INSPECTION_LOAD_MS
  }

  /** Main-owned inspection script reference (constant, never worker-supplied). */
  inspectionScript(): string {
    return MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT
  }

  /** Resolves the active runtime or returns null (no side effects). */
  getActiveForWorkspace(workspaceId: number): StoredRuntimeSession | undefined {
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      return undefined
    }
    const active = this.deps.runtimes.findActiveForWorkspace(workspaceId)
    if (active === undefined) {
      return undefined
    }
    if (active.status !== 'starting' && active.status !== 'running') {
      return undefined
    }
    return active
  }

  /** Derives the inspection target for one workspace (main-owned). */
  resolveTarget(workspaceId: number):
    | { readonly ok: true; readonly runtime: StoredRuntimeSession; readonly targetUrl: string; readonly targetPath: string; readonly useVisible: boolean }
    | { readonly ok: false } {
    const runtime = this.getActiveForWorkspace(workspaceId)
    if (runtime === undefined) {
      return { ok: false }
    }
    const visibleUrl = this.deps.getVisiblePreviewUrl?.(runtime.id) ?? null
    if (typeof visibleUrl === 'string' && visibleUrl !== '' && isAllowedPreviewNavigation(visibleUrl, runtime.previewPort)) {
      return { ok: true, runtime, targetUrl: visibleUrl, targetPath: extractTargetPath(visibleUrl), useVisible: true }
    }
    const root = previewUrlForPort(runtime.previewPort)
    return { ok: true, runtime, targetUrl: root, targetPath: '/', useVisible: false }
  }

  /**
   * Inspects once for one workspace. When frozen target metadata is
   * supplied (approved ASK path), the frozen runtime/path is used
   * with a hidden inspector and the human Preview is never touched.
   * Otherwise the current visible URL (when present) is inspected
   * read-only, falling back to one hidden root load.
   */
  async inspect(
    workspaceId: number,
    frozen?: { readonly runtimeId: number; readonly targetPathAndQueryAndHash: string }
  ): Promise<BoundedPreviewSnapshot> {
    void this.now
    if (frozen !== undefined) {
      return await this.inspectFrozen(workspaceId, frozen.runtimeId, frozen.targetPathAndQueryAndHash)
    }
    const target = this.resolveTarget(workspaceId)
    if (!target.ok) {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'No active project runtime.' })
      }
    }
    if (target.useVisible && this.deps.inspectVisible !== undefined) {
      try {
        const raw = await this.deps.inspectVisible(target.runtime.id)
        return this.sanitize(target.runtime, target.targetUrl, raw)
      } catch {
        return {
          status: 'preview_unavailable',
          payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The local Preview could not be inspected.' })
        }
      }
    }
    return await this.inspectViaHidden(target.runtime, target.targetUrl)
  }

  private async inspectFrozen(
    workspaceId: number,
    runtimeId: number,
    frozenPath: string
  ): Promise<BoundedPreviewSnapshot> {
    const active = this.getActiveForWorkspace(workspaceId)
    if (active === undefined || active.id !== runtimeId) {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'runtime_target_changed' })
      }
    }
    // Frozen path is inspected in an isolated hidden window even when
    // the human Preview is open elsewhere — the visible page is never
    // navigated, reloaded, focused, scrolled, or mutated.
    const targetUrl = previewTargetUrlFor(active.previewPort, frozenPath)
    if (!isAllowedPreviewNavigation(targetUrl, active.previewPort)) {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The approved Preview target is invalid.' })
      }
    }
    return await this.inspectViaHidden(active, targetUrl)
  }

  private async inspectViaHidden(runtime: StoredRuntimeSession, targetUrl: string): Promise<BoundedPreviewSnapshot> {
    const factory = this.deps.createHiddenInspector
    if (factory === undefined) {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The local Preview could not be loaded for inspection.' })
      }
    }
    if (!isAllowedPreviewNavigation(targetUrl, runtime.previewPort)) {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The Preview target is outside the managed runtime.' })
      }
    }
    let window: HiddenInspectionWindow | undefined
    try {
      window = factory({ runtimeId: runtime.id, port: runtime.previewPort, url: targetUrl })
    } catch {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The local Preview could not be loaded for inspection.' })
      }
    }
    try {
      // Exactly ONE navigation attempt with ONE bounded deadline. No
      // retry, no polling, no health-check loop.
      try {
        await withDeadline(window.loadURL(targetUrl), this.loadTimeoutMs)
      } catch {
        return {
          status: 'preview_unavailable',
          payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The local Preview could not be loaded for inspection.' })
        }
      }
      let raw: RawPreviewSnapshot
      try {
        raw = await withDeadline(window.collectSnapshot(), this.loadTimeoutMs)
      } catch {
        return {
          status: 'preview_unavailable',
          payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The local Preview could not be inspected.' })
        }
      }
      return this.sanitize(runtime, targetUrl, raw)
    } finally {
      try {
        window.destroy()
      } catch {
        // Best effort cleanup; the runtime keeps running.
      }
    }
  }

  /**
   * Sanitizes one raw snapshot into the bounded structured result.
   * Applies visible-text (32 KiB), element (100, 300 codepoints), and
   * total (64 KiB) bounds with truncation flags. Drops
   * oldest/lower-priority elements first when over budget. Never
   * includes input values, site data, scripts, or outerHTML.
   */
  sanitize(runtime: StoredRuntimeSession, targetUrl: string, raw: RawPreviewSnapshot): BoundedPreviewSnapshot {
    const title = typeof raw.title === 'string' ? truncateCodePoints(raw.title.replace(/\0/g, ''), 500) : ''
    const readyState = typeof raw.readyState === 'string' ? raw.readyState.slice(0, 32) : ''
    const rawText = typeof raw.visibleText === 'string' ? raw.visibleText.replace(/\0/g, '') : ''
    const textBound = truncateUtf8Bytes(rawText, MAX_PREVIEW_VISIBLE_TEXT_BYTES)
    const rawElements = Array.isArray(raw.elements) ? (raw.elements as RawPreviewElement[]) : []
    const sanitized: SanitizedPreviewElement[] = []
    const elementsTruncated = rawElements.length > MAX_PREVIEW_INSPECTION_ELEMENTS
    for (const entry of rawElements.slice(0, MAX_PREVIEW_INSPECTION_ELEMENTS)) {
      if (entry === null || typeof entry !== 'object') {
        continue
      }
      sanitized.push(sanitizePreviewElement(entry as RawPreviewElement, runtime.previewPort))
    }
    const build = (visibleText: string, textTruncated: boolean, elements: SanitizedPreviewElement[], truncated: boolean): string =>
      JSON.stringify({
        status: 'inspected',
        page: { url: targetUrl, title, readyState },
        visibleText,
        elements,
        textTruncated,
        elementsTruncated: truncated
      })
    let visibleText = textBound.text
    let textTruncated = textBound.truncated
    let elements = sanitized
    let payload = build(visibleText, textTruncated, elements, elementsTruncated)
    if (encoder.encode(payload).byteLength <= MAX_PREVIEW_INSPECTION_RESULT_BYTES) {
      return { status: 'inspected', payloadJson: payload }
    }
    // Reduce/drop oldest/lower-priority element entries until the
    // exact serialized UTF-8 budget fits.
    let guard = 0
    while (encoder.encode(payload).byteLength > MAX_PREVIEW_INSPECTION_RESULT_BYTES && elements.length > 0 && guard < 500) {
      guard += 1
      elements = elements.slice(0, Math.max(0, elements.length - 10))
      payload = build(visibleText, textTruncated, elements, true)
    }
    if (encoder.encode(payload).byteLength <= MAX_PREVIEW_INSPECTION_RESULT_BYTES) {
      return { status: 'inspected', payloadJson: payload }
    }
    // As a final bound, truncate visible text further (newest
    // preferred is already applied; this only fires for pathological
    // titles/URLs).
    const tight = truncateUtf8Bytes(visibleText, Math.floor(MAX_PREVIEW_VISIBLE_TEXT_BYTES / 2))
    visibleText = tight.text
    textTruncated = true
    payload = build(visibleText, textTruncated, [], true)
    if (encoder.encode(payload).byteLength > MAX_PREVIEW_INSPECTION_RESULT_BYTES) {
      return {
        status: 'preview_unavailable',
        payloadJson: JSON.stringify({ status: 'preview_unavailable', reason: 'The Preview snapshot exceeded the inspection limit.' })
      }
    }
    return { status: 'inspected', payloadJson: payload }
  }
}
