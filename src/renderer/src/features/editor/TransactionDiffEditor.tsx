import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { editor } from 'monaco-editor/editor/editor.api'
import type { EditorEol } from './editor-document'
import { STARK_EDITOR_THEME_NAME, registerStarkTheme } from './editor-theme'
import { loadMonaco } from './editor-setup'
import './editor.css'

export interface TransactionDiffEditorProps {
  /** Synthetic URIs for the two sides (never host paths). Remount via key per transaction. */
  readonly beforeUri: string
  readonly afterUri: string
  readonly beforeContent: string
  readonly afterContent: string
  /** Monaco language id from detectEditorLanguage. */
  readonly language: string
  readonly eol: EditorEol
  readonly ariaLabel: string
}

interface DiffInstance {
  readonly original: editor.ITextModel
  readonly modified: editor.ITextModel
  readonly diff: editor.IStandaloneDiffEditor
}

/**
 * Read-only Monaco DiffEditor for one change transaction:
 * original = checkpoint, modified = proposal. Strings only — content
 * is source text, never HTML. Accept/Reject/Rollback stay STARK
 * controls outside this surface; the diff itself performs no
 * mutation. One mount owns exactly three disposables; unmount (or
 * remount per transaction) releases all of them.
 */
export function TransactionDiffEditor({
  beforeUri,
  afterUri,
  beforeContent,
  afterContent,
  language,
  eol,
  ariaLabel
}: TransactionDiffEditorProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)
  // Mount-once diff props (see CodeEditor): the parent remounts per
  // transaction via key, so prop churn must never recreate models.
  const [mountProps] = useState(() => ({ beforeUri, afterUri, beforeContent, afterContent, language, eol }))

  useEffect(() => {
    let cancelled = false
    let instance: DiffInstance | null = null
    loadMonaco().then(
      (monaco) => {
        if (cancelled || containerRef.current === null) {
          return
        }
        try {
          registerStarkTheme(monaco)
          const eolSequence =
            mountProps.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
          const original = monaco.editor.createModel(
            mountProps.beforeContent,
            mountProps.language,
            monaco.Uri.parse(mountProps.beforeUri)
          )
          original.setEOL(eolSequence)
          const modified = monaco.editor.createModel(
            mountProps.afterContent,
            mountProps.language,
            monaco.Uri.parse(mountProps.afterUri)
          )
          modified.setEOL(eolSequence)
          const diff = monaco.editor.createDiffEditor(containerRef.current, {
            readOnly: true,
            theme: STARK_EDITOR_THEME_NAME,
            fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace",
            fontSize: 13,
            lineNumbers: 'on',
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderSideBySide: true,
            renderIndicators: true,
            ignoreTrimWhitespace: false,
            scrollbar: { vertical: 'auto', horizontal: 'auto' },
            accessibilitySupport: 'auto',
            fixedOverflowWidgets: true,
            stickyScroll: { enabled: false },
            glyphMargin: false
          })
          diff.setModel({ original, modified })
          instance = { original, modified, diff }
        } catch {
          if (!cancelled) {
            setFailed(true)
          }
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true)
        }
      }
    )
    return () => {
      cancelled = true
      try {
        instance?.diff.dispose()
      } catch {
        // Best effort during teardown.
      }
      try {
        instance?.modified.dispose()
      } catch {
        // Best effort during teardown.
      }
      try {
        instance?.original.dispose()
      } catch {
        // Best effort during teardown.
      }
    }
  }, [mountProps])

  if (failed) {
    return (
      <div className="code-editor__fallback">
        <p className="code-editor__status" role="alert">
          The change comparison couldn’t start. Showing plain text.
        </p>
        <pre className="code-editor__plain">{beforeContent}</pre>
        <pre className="code-editor__plain">{afterContent}</pre>
      </div>
    )
  }

  return <div ref={containerRef} className="code-editor__frame code-editor__frame--diff" role="application" aria-label={ariaLabel} />
}
