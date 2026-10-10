import type * as MonacoApi from 'monaco-editor/editor/editor.api'
import { getExtensionIconTheme, getExtensionSnippets, getExtensionThemeData, getSelectedExtensionThemes, listExtensionLanguages, queryExtensionProviders } from '../../lib/stark-api'
import { applyExtensionTheme, registerStarkTheme } from '../editor/editor-theme'
import { buildLanguageOverrides } from '../editor/editor-language'

/**
 * Renderer-side Monaco glue for extension language features (Step 8).
 *
 * Registers Monaco providers that query the main-owned runtime (which
 * fans out to active Extension Host providers with bounds), plus
 * snippet completions, contributed-language overrides, extension
 * editor themes, and diagnostic markers. No direct host access, no
 * filesystem, no network — everything flows through the fixed
 * preload bridge. Monaco instances are injected (never imported
 * here) so mapping logic stays unit-testable in Node.
 */

/** VS Code CompletionItemKind (0-24) → Monaco CompletionItemKind. */
const COMPLETION_KIND_MAP: Record<number, number> = {  0: 18, // Text
  1: 0, // Method
  2: 1, // Function
  3: 2, // Constructor
  4: 3, // Field
  5: 4, // Variable
  6: 5, // Class
  7: 7, // Interface
  8: 8, // Module
  9: 9, // Property
  10: 12, // Unit
  11: 13, // Value
  12: 15, // Enum
  13: 17, // Keyword
  14: 27, // Snippet
  15: 19, // Color
  16: 20, // File
  17: 21, // Reference
  18: 23, // Folder
  19: 16, // EnumMember
  20: 14, // Constant
  21: 6, // Struct
  22: 10, // Event
  23: 11, // Operator
  24: 24 // TypeParameter
}

export function toMonacoCompletionKind(vscodeKind: number): MonacoApi.languages.CompletionItemKind {
  return ((COMPLETION_KIND_MAP[vscodeKind] ?? 18) as MonacoApi.languages.CompletionItemKind)
}

/** VS Code DiagnosticSeverity (0-3) → Monaco MarkerSeverity (8/4/2/1). */
export function toMonacoSeverity(vscodeSeverity: number): MonacoApi.MarkerSeverity {
  if (vscodeSeverity === 0) {
    return 8 as MonacoApi.MarkerSeverity
  }
  if (vscodeSeverity === 1) {
    return 4 as MonacoApi.MarkerSeverity
  }
  if (vscodeSeverity === 2) {
    return 2 as MonacoApi.MarkerSeverity
  }
  return 1 as MonacoApi.MarkerSeverity
}

export interface BridgeCompletionItem {
  readonly label: string
  readonly kind: number
  readonly detail?: string
  readonly documentation?: string
  readonly insertText?: string
}

export interface BridgePosition {
  readonly line: number
  readonly character: number
}

/** Maps a host completion result to Monaco suggestion shapes (pure). */
export function mapCompletionItems(result: Record<string, unknown> | null): BridgeCompletionItem[] {
  const items = (result?.['items'] ?? null) as unknown
  if (!Array.isArray(items)) {
    return []
  }
  const out: BridgeCompletionItem[] = []
  for (const entry of items.slice(0, 200)) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record['label'] !== 'string' || record['label'] === '') {
      continue
    }
    out.push({
      label: (record['label'] as string).slice(0, 256),
      kind: toMonacoCompletionKind(typeof record['kind'] === 'number' ? record['kind'] : 0),
      detail: typeof record['detail'] === 'string' ? (record['detail'] as string).slice(0, 512) : undefined,
      documentation: typeof record['documentation'] === 'string' ? (record['documentation'] as string).slice(0, 2048) : undefined,
      insertText: typeof record['insertText'] === 'string' ? (record['insertText'] as string).slice(0, 2048) : undefined
    })
  }
  return out
}

/** Maps a host hover result to display text (pure). */
export function mapHoverContents(result: Record<string, unknown> | null): string {
  const contents = result?.['contents']
  return typeof contents === 'string' ? contents.slice(0, 8192) : ''
}

export interface BridgeLocation {
  readonly uri: string
  readonly range: { start: BridgePosition; end: BridgePosition }
}

/** Maps a host definition/reference result to locations (pure). */
export function mapLocations(result: Record<string, unknown> | null): BridgeLocation[] {
  const locations = (result?.['locations'] ?? null) as unknown
  if (!Array.isArray(locations)) {
    return []
  }
  const out: BridgeLocation[] = []
  for (const entry of locations.slice(0, 100)) {
    if (entry === null || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    const range = record['range'] as { start?: BridgePosition; end?: BridgePosition } | undefined
    if (typeof record['uri'] !== 'string' || range?.start === undefined || range?.end === undefined) {
      continue
    }
    out.push({ uri: record['uri'] as string, range: { start: range.start, end: range.end } })
  }
  return out
}

/** Single-flight per (kind, uri, version, position): one host query at a time. */
const inflightQueries = new Map<string, Promise<Record<string, unknown> | null>>()

export function queryWithSingleFlight(key: string, run: () => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null> {
  const existing = inflightQueries.get(key)
  if (existing !== undefined) {
    return existing
  }
  if (inflightQueries.size >= 64) {
    const oldest = inflightQueries.keys().next().value as string | undefined
    if (oldest !== undefined) {
      inflightQueries.delete(oldest)
    }
  }
  const flight = run().finally(() => {
    if (inflightQueries.get(key) === flight) {
      inflightQueries.delete(key)
    }
  })
  inflightQueries.set(key, flight)
  return flight
}

/** Minimal Monaco surface consumed here (structural, injected). */
export interface BridgeMonaco {
  languages: typeof MonacoApi.languages
  editor: Pick<typeof MonacoApi.editor, 'setModelMarkers' | 'defineTheme' | 'setTheme'>
  Range: typeof MonacoApi.Range
}

function toMonacoRange(monaco: BridgeMonaco, range: { start: BridgePosition; end: BridgePosition }): MonacoApi.Range {
  return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1)
}

export interface BridgeModel {
  uri: { toString: () => string; path: string }
  getValue: () => string
  getVersionId: () => number
  getWordUntilPosition: (position: { lineNumber: number; column: number }) => { startColumn: number; endColumn: number } | null
}

function queryKey(kind: string, model: BridgeModel, position: { lineNumber: number; column: number }): string {
  return `${kind}|${model.uri.toString()}|${model.getVersionId()}|${position.lineNumber}:${position.column}`
}

function queryPosition(position: { lineNumber: number; column: number }): BridgePosition {
  return { line: Math.max(0, position.lineNumber - 1), character: Math.max(0, position.column - 1) }
}

/**
 * Registers completion, hover, definition, and signature providers
 * for one language id. Each fans out through the bounded bridge
 * (single-flight per model version + position, empty on failure).
 * Returns a combined disposable for unmount.
 */
export function registerExtensionLanguageProviders(
  monaco: BridgeMonaco,
  languageId: string,
  filePath: string
): { dispose: () => void } {
  const disposables: { dispose: () => void }[] = []
  disposables.push(
    monaco.languages.registerCompletionItemProvider(languageId, {
      provideCompletionItems: (model: BridgeModel, position: { lineNumber: number; column: number }) => {
        const key = queryKey('completion', model, position)
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({
            kind: 'completion',
            filePath,
            languageId,
            text: model.getValue(),
            position: queryPosition(position)
          }).catch(() => null)
        ).then((result) => {
          const word = model.getWordUntilPosition(position) ?? { startColumn: position.column, endColumn: position.column }
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          return {
            suggestions: mapCompletionItems(result).map((item) => ({
              label: item.label,
              kind: item.kind,
              detail: item.detail,
              documentation: item.documentation ? { value: item.documentation } : undefined,
              insertText: item.insertText ?? item.label,
              insertTextRules: item.insertText !== undefined && item.insertText.includes('$')
                ? (4 as MonacoApi.languages.CompletionItemInsertTextRule)
                : undefined,
              range
            }))
          }
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: (model: BridgeModel, position: { lineNumber: number; column: number }) => {
        const key = queryKey('hover', model, position)
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({
            kind: 'hover',
            filePath,
            languageId,
            text: model.getValue(),
            position: queryPosition(position)
          }).catch(() => null)
        ).then((result) => {
          const contents = mapHoverContents(result)
          if (contents === '') {
            return null
          }
          return { contents: [{ value: contents }] }
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerDefinitionProvider(languageId, {
      provideDefinition: (model: BridgeModel, position: { lineNumber: number; column: number }) => {
        const key = queryKey('definition', model, position)
        const modelUri = model.uri.toString()
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({
            kind: 'definition',
            filePath,
            languageId,
            text: model.getValue(),
            position: queryPosition(position)
          }).catch(() => null)
        ).then((result) =>
          mapLocations(result)
            .filter((location) => location.uri === modelUri)
            .slice(0, 16)
            .map((location) => ({
              uri: model.uri as MonacoApi.Uri,
              range: new monaco.Range(
                location.range.start.line + 1,
                location.range.start.character + 1,
                location.range.end.line + 1,
                location.range.end.character + 1
              )
            }))
        )
      }
    })
  )
  disposables.push(
    monaco.languages.registerSignatureHelpProvider(languageId, {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: (model: BridgeModel, position: { lineNumber: number; column: number }) => {        const key = queryKey('signature', model, position)
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({
            kind: 'signatureHelp',
            filePath,
            languageId,
            text: model.getValue(),
            position: queryPosition(position)
          }).catch(() => null)
        ).then((result) => {
          const signatures = (result?.['signatures'] ?? null) as { label?: string; documentation?: string }[] | null
          if (!Array.isArray(signatures) || signatures.length === 0) {
            return null
          }
          return {
            value: {
              signatures: signatures.slice(0, 8).map((signature) => ({
                label: typeof signature.label === 'string' ? signature.label : '',
                documentation: typeof signature.documentation === 'string' ? { value: signature.documentation } : undefined,
                parameters: []
              })),
              activeSignature: 0,
              activeParameter: 0
            },
            dispose: () => {}
          }
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerDocumentHighlightProvider(languageId, {
      provideDocumentHighlights: (model: BridgeModel, position: { lineNumber: number; column: number }) => {
        const key = queryKey('documentHighlight', model, position)
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({
            kind: 'documentHighlight',
            filePath,
            languageId,
            text: model.getValue(),
            position: queryPosition(position)
          }).catch(() => null)
        ).then((result) => {
          const highlights = (result?.['highlights'] ?? null) as { range?: { start: BridgePosition; end: BridgePosition }; kind?: number }[] | null
          if (!Array.isArray(highlights)) {
            return []
          }
          return highlights.slice(0, 64).flatMap((highlight) => {
            if (highlight?.range === undefined) {
              return []
            }
            const kind = highlight.kind === 1 ? 1 : highlight.kind === 2 ? 2 : 0
            return [{ range: toMonacoRange(monaco, highlight.range), kind: kind as MonacoApi.languages.DocumentHighlightKind }]
          })
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerLinkProvider(languageId, {
      provideLinks: (model: BridgeModel) => {
        const key = `documentLink|${model.uri.toString()}|${model.getVersionId()}`
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({ kind: 'documentLink', filePath, languageId, text: model.getValue() }).catch(() => null)
        ).then((result) => {
          const links = (result?.['links'] ?? null) as { range?: { start: BridgePosition; end: BridgePosition }; target?: string }[] | null
          if (!Array.isArray(links)) {
            return { links: [] }
          }
          return {
            links: links.slice(0, 64).flatMap((link) => {
              if (link?.range === undefined || typeof link.target !== 'string' || link.target === '') {
                return []
              }
              return [{ range: toMonacoRange(monaco, link.range), url: link.target }]
            })
          }
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerFoldingRangeProvider(languageId, {
      provideFoldingRanges: (model: BridgeModel) => {
        const key = `foldingRange|${model.uri.toString()}|${model.getVersionId()}`
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({ kind: 'foldingRange', filePath, languageId, text: model.getValue() }).catch(() => null)
        ).then((result) => {
          const ranges = (result?.['ranges'] ?? null) as { start?: number; end?: number; kind?: number }[] | null
          if (!Array.isArray(ranges)) {
            return []
          }
          return ranges.slice(0, 256).flatMap((range) => {
            if (typeof range?.start !== 'number' || typeof range?.end !== 'number') {
              return []
            }
            const folded = {
              start: Math.max(1, range.start + 1),
              end: Math.max(1, range.end + 1),
              kind: range.kind
            }
            return [folded as MonacoApi.languages.FoldingRange]
          })
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerSelectionRangeProvider(languageId, {
      provideSelectionRanges: (model: BridgeModel, positions: { lineNumber: number; column: number }[]) => {
        const position = positions[0] ?? { lineNumber: 1, column: 1 }
        const key = queryKey('selectionRange', model, position)
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({
            kind: 'selectionRange',
            filePath,
            languageId,
            text: model.getValue(),
            position: queryPosition(position)
          }).catch(() => null)
        ).then((result) => {
          const chain = (result?.['chain'] ?? null) as { range?: { start: BridgePosition; end: BridgePosition } }[] | null
          if (!Array.isArray(chain) || chain.length === 0) {
            return []
          }
          const ranges = chain.slice(0, 16).flatMap((entry) => {
            if (entry?.range === undefined) {
              return []
            }
            return [{ range: toMonacoRange(monaco, entry.range) }]
          })
          return ranges.length === 0 ? [] : [ranges]
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerInlayHintsProvider(languageId, {
      provideInlayHints: (model: BridgeModel) => {
        const key = `inlayHint|${model.uri.toString()}|${model.getVersionId()}`
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({ kind: 'inlayHint', filePath, languageId, text: model.getValue() }).catch(() => null)
        ).then((result) => {
          const hints = (result?.['hints'] ?? null) as { position?: BridgePosition; label?: string; kind?: number }[] | null
          if (!Array.isArray(hints)) {
            return { hints: [], dispose: () => {} }
          }
          return {
            hints: hints.slice(0, 256).flatMap((hint) => {
              if (hint?.position === undefined || typeof hint.label !== 'string' || hint.label === '') {
                return []
              }
              return [{
                label: hint.label.slice(0, 512),
                position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
                kind: hint.kind === 1 ? 1 : hint.kind === 2 ? 2 : undefined
              }]
            }),
            dispose: () => {}
          }
        })
      }
    })
  )
  disposables.push(
    monaco.languages.registerColorProvider(languageId, {
      provideColorPresentations: (model: BridgeModel, colorInfo: { color: { red: number; green: number; blue: number; alpha: number }; range: unknown }) => {
        void model
        const color = colorInfo?.color
        if (color === undefined) {
          return []
        }
        const toHex = (value: number): string => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')
        return [{ label: `#${toHex(color.red)}${toHex(color.green)}${toHex(color.blue)}` }]
      },
      provideDocumentColors: (model: BridgeModel) => {
        const key = `documentColor|${model.uri.toString()}|${model.getVersionId()}`
        return queryWithSingleFlight(key, () =>
          queryExtensionProviders({ kind: 'documentColor', filePath, languageId, text: model.getValue() }).catch(() => null)
        ).then((result) => {
          const colors = (result?.['colors'] ?? null) as {
            range?: { start: BridgePosition; end: BridgePosition }
            color?: { red?: number; green?: number; blue?: number; alpha?: number }
          }[] | null
          if (!Array.isArray(colors)) {
            return []
          }
          return colors.slice(0, 128).flatMap((entry) => {
            if (entry?.range === undefined || entry.color === undefined) {
              return []
            }
            const color = entry.color
            return [{
              range: toMonacoRange(monaco, entry.range),
              color: {
                red: Math.min(1, Math.max(0, Number(color.red ?? 0))),
                green: Math.min(1, Math.max(0, Number(color.green ?? 0))),
                blue: Math.min(1, Math.max(0, Number(color.blue ?? 0))),
                alpha: Math.min(1, Math.max(0, Number(color.alpha ?? 1)))
              }
            }]
          })
        })
      }
    })
  )
  return {
    dispose: () => {
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {
          // Best effort per provider.
        }
      }
    }
  }
}

const snippetsRegistered = new Set<string>()

/** Test seam: forget registered snippet languages. */
export function resetSnippetRegistrationsForTests(): void {
  snippetsRegistered.clear()
}

/**
 * Registers contributed snippet completions for one language id
 * (once per session per language). Snippet files were read
 * main-side under containment; bodies render through Monaco's own
 * snippet engine (no HTML, no scripts).
 */
export function ensureExtensionSnippets(monaco: BridgeMonaco, languageId: string): void {
  if (snippetsRegistered.has(languageId)) {
    return
  }
  snippetsRegistered.add(languageId)
  getExtensionSnippets(languageId).then(
    (snippets) => {
      if (snippets.length === 0) {
        return
      }
      monaco.languages.registerCompletionItemProvider(languageId, {
        provideCompletionItems: (model: BridgeModel, position: { lineNumber: number; column: number }) => {
          const word = model.getWordUntilPosition(position) ?? { startColumn: position.column, endColumn: position.column }
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          return {
            suggestions: snippets.slice(0, 128).map((snippet) => ({
              label: snippet.prefix,
              kind: 27 as MonacoApi.languages.CompletionItemKind,
              detail: snippet.description,
              insertText: snippet.body,
              insertTextRules: 4 as MonacoApi.languages.CompletionItemInsertTextRule,
              range
            }))
          }
        }
      })
    },
    () => {
      // Offline-safe: no snippets without the bridge.
    }
  )
}

let languageOverridesCache: Record<string, string> | null = null

/** Test seam: forget cached language overrides. */
export function resetLanguageOverridesForTests(): void {
  languageOverridesCache = null
}

/** Contributed-language detection overrides (cached per session). */
export function fetchLanguageOverrides(): Promise<Record<string, string>> {
  if (languageOverridesCache !== null) {
    return Promise.resolve(languageOverridesCache)
  }
  return listExtensionLanguages().then(
    (languages) => {
      languageOverridesCache = buildLanguageOverrides(languages)
      return languageOverridesCache
    },
    () => ({})
  )
}

/**
 * Applies the selected editor theme (or the STARK default). Theme
 * data maps into Monaco only — the application shell is untouched.
 */
export function ensureExtensionTheme(monaco: BridgeMonaco): void {  getSelectedExtensionThemes().then(
    (selected) => {
      if (selected.editor === null) {
        registerStarkTheme(monaco)
        return
      }
      const at = selected.editor.extensionId.lastIndexOf('@')
      const head = selected.editor.extensionId.slice(0, at)
      const headDot = head.indexOf('.')
      const identity = {
        namespace: head.slice(0, headDot),
        name: head.slice(headDot + 1),
        version: selected.editor.extensionId.slice(at + 1)
      }
      getExtensionThemeData(identity, selected.editor.themeId).then(
        (data) => {
          if (data === null || !applyExtensionTheme(monaco, data)) {
            registerStarkTheme(monaco)
          }
        },
        () => {
          registerStarkTheme(monaco)
        }
      )
    },
    () => {
      registerStarkTheme(monaco)
    }
  )
}

/** Broadcasts a locally-applied theme change to mounted editors. */
export function notifyEditorThemeChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent('stark:editor-theme-changed'))
  } catch {
    // Best effort fan-out.
  }
}

export interface ExtensionMarkerInput {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
  readonly severity: number
  readonly message: string
}

/**
 * Applies extension diagnostics as Monaco model markers (STARK-owned
 * marker state, plain text only). Bounded and best-effort.
 */
export function applyExtensionMarkers(
  monaco: BridgeMonaco,
  model: MonacoApi.editor.ITextModel,
  diagnostics: readonly ExtensionMarkerInput[]
): void {
  const markers = diagnostics.slice(0, 2000).flatMap((diagnostic) => {
    if (typeof diagnostic.message !== 'string' || diagnostic.message === '') {
      return []
    }
    const startLineNumber = Math.max(1, Math.floor(diagnostic.startLineNumber))
    const startColumn = Math.max(1, Math.floor(diagnostic.startColumn))
    const endLineNumber = Math.max(startLineNumber, Math.floor(diagnostic.endLineNumber))
    const endColumn = Math.max(1, Math.floor(diagnostic.endColumn))
    return [
      {
        severity: toMonacoSeverity(diagnostic.severity),
        message: diagnostic.message.slice(0, 2048),
        startLineNumber,
        startColumn,
        endLineNumber,
        endColumn
      }
    ]
  })
  // The caller passes the live model; markers attach to it directly
  // (no model identity is fabricated).
  monaco.editor.setModelMarkers(model, 'stark-extensions', markers)
}

export interface IconThemeSnapshot {
  readonly fileExtensions: Record<string, string>
  readonly fileNames: Record<string, string>
  readonly icons: Record<string, string>
}

const iconThemeCache = new Map<string, Promise<IconThemeSnapshot | null>>()

/** Test seam: forget cached icon themes. */
export function resetIconThemeCacheForTests(): void {
  iconThemeCache.clear()
}

/** Selected Explorer icon theme data (cached per theme ref). */
export function fetchIconThemeCached(ref: { extensionId: string; themeId: string } | null): Promise<IconThemeSnapshot | null> {
  if (ref === null) {
    return Promise.resolve(null)
  }
  const key = `${ref.extensionId}#${ref.themeId}`
  const existing = iconThemeCache.get(key)
  if (existing !== undefined) {
    return existing
  }
  const at = ref.extensionId.lastIndexOf('@')
  const head = ref.extensionId.slice(0, at)
  const headDot = head.indexOf('.')
  const flight = getExtensionIconTheme(
    { namespace: head.slice(0, headDot), name: head.slice(headDot + 1), version: ref.extensionId.slice(at + 1) },
    ref.themeId
  ).then(
    (data) => (data === null ? null : { fileExtensions: { ...data.fileExtensions }, fileNames: { ...data.fileNames }, icons: { ...data.icons } }),
    () => null
  )
  iconThemeCache.set(key, flight)
  return flight
}

/**
 * Resolves an Explorer file-row icon URL (pure): exact file-name
 * matches win, then file-extension matches. Returns null for the
 * STARK default glyph path. Scoped to file/folder rows — never
 * branding.
 */
export function resolveTreeFileIcon(fileName: string, theme: IconThemeSnapshot | null): string | null {
  if (theme === null || typeof fileName !== 'string' || fileName === '') {
    return null
  }
  const base = fileName.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  if (base === '') {
    return null
  }
  const byName = theme.fileNames[base]
  if (typeof byName === 'string' && typeof theme.icons[byName] === 'string') {
    return theme.icons[byName] as string
  }
  const dot = base.lastIndexOf('.')
  if (dot > 0) {
    const byExtension = theme.fileExtensions[base.slice(dot + 1)]
    if (typeof byExtension === 'string' && typeof theme.icons[byExtension] === 'string') {
      return theme.icons[byExtension] as string
    }
  }
  return null
}
