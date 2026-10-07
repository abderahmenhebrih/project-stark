import { useEffect, useRef, useState, type ReactElement } from 'react'
import { loadMonaco } from '../editor/editor-setup'
import { STARK_EDITOR_THEME_NAME, registerStarkTheme } from '../editor/editor-theme'
import './git.css'

interface GitDiffViewerProps {
  /** Repo-relative path (plain text, never HTML). */
  readonly relativePath: string
  readonly target: 'staged' | 'unstaged'
  /** Plain-text unified patch (plain string, never HTML/ANSI). */
  readonly patch: string
}

/**
 * Read-only Monaco viewer for one Git patch. The patch is a plain
 * string passed to Monaco only — React text plus Monaco model text,
 * with no HTML rendering path and no ANSI processing. Monaco language
 * is `diff` when registered locally, otherwise plaintext fallback.
 */
export function GitDiffViewer({ relativePath, target, patch }: GitDiffViewerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)
  const [mountProps] = useState(() => ({ relativePath, target, patch }))

  useEffect(() => {
    let cancelled = false
    let editor: { dispose: () => void } | null = null
    let model: { dispose: () => void } | null = null
    loadMonaco().then(
      (monaco) => {
        if (cancelled || containerRef.current === null) {
          return
        }
        try {
          registerStarkTheme(monaco)
          const languages: readonly string[] = monaco.languages.getLanguages().map((entry) => entry.id)
          const language = languages.includes('diff') ? 'diff' : 'plaintext'
          const created = monaco.editor.createModel(
            mountProps.patch,
            language,
            monaco.Uri.parse(`inmemory://stark-git/${mountProps.target}/${encodeURIComponent(mountProps.relativePath)}`)
          )
          model = created
          const instance = monaco.editor.create(containerRef.current, {
            model: created,
            readOnly: true,
            theme: STARK_EDITOR_THEME_NAME,
            fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace",
            fontSize: 13,
            lineNumbers: 'on',
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            wordWrap: 'off',
            padding: { top: 8 },
            scrollbar: { vertical: 'auto', horizontal: 'auto' },
            accessibilitySupport: 'auto',
            fixedOverflowWidgets: true,
            stickyScroll: { enabled: false },
            glyphMargin: false,
            folding: true,
            renderWhitespace: 'none',
            cursorBlinking: 'solid'
          })
          editor = instance
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
        editor?.dispose()
      } catch {
        // Best effort during teardown.
      }
      try {
        model?.dispose()
      } catch {
        // Best effort during teardown.
      }
    }
  }, [mountProps])

  if (failed) {
    return (
      <div className="git-diff-viewer">
        <p className="explorer__error explorer__inline-alert" role="alert">
          The Git diff couldn’t start. Showing plain text.
        </p>
        <pre className="code-editor__plain">{patch}</pre>
      </div>
    )
  }

  return (
    <div className="git-diff-viewer">
      <div ref={containerRef} className="code-editor__frame" role="application" aria-label={`Git diff ${relativePath}`} />
    </div>
  )
}
