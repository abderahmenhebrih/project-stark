import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { editor } from 'monaco-editor/editor/editor.api'
import type { EditorFocus } from './editor-focus'
import type { EditorEol } from './editor-document'
import { STARK_EDITOR_THEME_NAME, registerStarkTheme } from './editor-theme'
import { loadMonaco, type Monaco } from './editor-setup'
import './editor.css'

export interface CodeEditorProps {
  /** Synthetic model URI (never a host path). Remount via key to swap documents. */
  readonly documentUri: string
  /** Monaco language id from detectEditorLanguage. */
  readonly language: string
  /** Exact file content at mount. */
  readonly initialValue: string
  /** Uniform original EOL convention; the model is pinned to match. */
  readonly eol: EditorEol
  /** Preview mode: no editing, no change events. */
  readonly readOnly: boolean
  /** Search-result cursor request applied after mount/update. */
  readonly focusRequest: EditorFocus | null
  /** Fired with model.getValue() on every local edit. */
  readonly onContentChange?: (value: string) => void
  /** Fired with the cursor selection on change (Stage 15 excerpt attach). */
  readonly onSelectionChange?: (selection: EditorSelection | null) => void
  readonly ariaLabel: string
}

/** Minimal cursor-selection snapshot (1-based, Monaco convention). */
export interface EditorSelection {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

interface EditorInstance {
  readonly monaco: Monaco
  readonly editor: editor.IStandaloneCodeEditor
  readonly model: editor.ITextModel
}

/**
 * Applies a Search-result cursor request: reveals the line centered
 * and places the cursor at the column. Pure against the instance so
 * both the mount path (late Monaco init) and later updates share it.
 */
function applyFocusRequest(instance: EditorInstance, focus: EditorFocus | null): void {
  if (focus === null) {
    return
  }
  instance.editor.revealLineInCenter(focus.lineNumber)
  instance.editor.setPosition({ lineNumber: focus.lineNumber, column: focus.column })
  instance.editor.revealPositionInCenter({ lineNumber: focus.lineNumber, column: focus.column })
}

/**
 * One Monaco editing surface for the single active document.
 *
 * Data flows one way: Stage 6 content in, local edits out through
 * onContentChange (the parent owns revision/dirty state), proposals
 * out through Stage 9. The component never touches IPC, Node, or
 * files. One mount owns exactly one model and one editor; unmount
 * disposes both. A failed Monaco load degrades to plain text instead
 * of crashing the shell.
 */
export function CodeEditor({
  documentUri,
  language,
  initialValue,
  eol,
  readOnly,
  focusRequest,
  onContentChange,
  onSelectionChange,
  ariaLabel
}: CodeEditorProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const instanceRef = useRef<EditorInstance | null>(null)
  const changeRef = useRef(onContentChange)
  const selectionRef = useRef(onSelectionChange)
  const focusRequestRef = useRef(focusRequest)
  const [failed, setFailed] = useState(false)
  // Mount-once document props: the parent remounts this component via
  // key whenever the document itself changes, so the live draft must
  // NEVER re-trigger model creation — recreating the model on every
  // keystroke would destroy focus and the undo stack.
  const [mountProps] = useState(() => ({ documentUri, language, initialValue, eol, readOnly }))

  useEffect(() => {
    changeRef.current = onContentChange
    selectionRef.current = onSelectionChange
    focusRequestRef.current = focusRequest
  })

  useEffect(() => {
    let cancelled = false
    let instance: EditorInstance | null = null
    loadMonaco().then(
      (monaco) => {
        if (cancelled || containerRef.current === null) {
          return
        }
        try {
          registerStarkTheme(monaco)
          const model = monaco.editor.createModel(
            mountProps.initialValue,
            mountProps.language,
            monaco.Uri.parse(mountProps.documentUri)
          )
          model.setEOL(
            mountProps.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF
          )
          const editor = monaco.editor.create(containerRef.current, {
            model,
            readOnly: mountProps.readOnly,
            theme: STARK_EDITOR_THEME_NAME,
            fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace",
            fontSize: 13,
            lineNumbers: 'on',
            minimap: { enabled: false },
            matchBrackets: 'always',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            tabSize: 2,
            insertSpaces: true,
            wordWrap: 'off',
            padding: { top: 8 },
            scrollbar: { vertical: 'auto', horizontal: 'auto' },
            accessibilitySupport: 'auto',
            fixedOverflowWidgets: true,
            stickyScroll: { enabled: false },
            glyphMargin: false,
            folding: true,
            renderWhitespace: 'none',
            cursorBlinking: mountProps.readOnly ? 'solid' : 'blink'
          })
          model.onDidChangeContent(() => {
            changeRef.current?.(model.getValue())
          })
          editor.onDidChangeCursorSelection((event) => {
            const selection = event.selection
            if (selection.isEmpty()) {
              selectionRef.current?.(null)
              return
            }
            selectionRef.current?.({
              startLineNumber: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLineNumber: selection.endLineNumber,
              endColumn: selection.endColumn
            })
          })
          const ready: EditorInstance = { monaco, editor, model }
          instance = ready
          instanceRef.current = ready
          // The focus request often predates Monaco init (async module
          // load + editor creation); apply the latest one on readiness
          // instead of dropping it. Applied immediately (covers pages
          // where rAF is throttled) and re-applied past first paint so
          // the reveal also runs against a laid-out viewport rather
          // than a zero-height container, which would silently leave
          // scrollTop at 0.
          applyFocusRequest(ready, focusRequestRef.current)
          requestAnimationFrame(() => {
            if (!cancelled && instanceRef.current === ready) {
              applyFocusRequest(ready, focusRequestRef.current)
            }
          })
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
      instanceRef.current = null
      // Model before editor: the editor must never outlive its model.
      try {
        instance?.model.dispose()
      } catch {
        // Best effort during teardown.
      }
      try {
        instance?.editor.dispose()
      } catch {
        // Best effort during teardown.
      }
    }
  }, [mountProps])

  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) {
      return
    }
    applyFocusRequest(instance, focusRequest)
  }, [focusRequest])

  if (failed) {
    return (
      <div className="code-editor__fallback">
        <p className="code-editor__status" role="alert">
          The code editor couldn’t start. Showing plain text.
        </p>
        <pre className="code-editor__plain">{initialValue}</pre>
      </div>
    )
  }

  return <div ref={containerRef} className="code-editor__frame" role="application" aria-label={ariaLabel} />
}
