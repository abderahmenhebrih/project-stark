import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { UiIcon } from '../../components/icons/UiIcon'
import type { ExplorerMenuTarget } from './explorer-crud-state'

export type ExplorerMenuAction = 'new-file' | 'new-folder' | 'rename' | 'delete' | 'refresh'

interface ExplorerContextMenuProps {
  readonly target: ExplorerMenuTarget
  readonly x: number
  readonly y: number
  readonly onAction: (action: ExplorerMenuAction) => void
  readonly onClose: () => void
}

function menuItemsFor(target: ExplorerMenuTarget): readonly { action: ExplorerMenuAction; label: string; icon: 'file-plus' | 'folder-plus' | 'rename' | 'trash' | 'refresh' }[] {
  if (target.kind === 'root') {
    return [
      { action: 'new-file', label: 'New File', icon: 'file-plus' },
      { action: 'new-folder', label: 'New Folder', icon: 'folder-plus' },
      { action: 'refresh', label: 'Refresh', icon: 'refresh' }
    ]
  }
  if (target.kind === 'directory') {
    return [
      { action: 'new-file', label: 'New File', icon: 'file-plus' },
      { action: 'new-folder', label: 'New Folder', icon: 'folder-plus' },
      { action: 'rename', label: 'Rename', icon: 'rename' },
      { action: 'delete', label: 'Delete', icon: 'trash' },
      { action: 'refresh', label: 'Refresh', icon: 'refresh' }
    ]
  }
  return [
    { action: 'rename', label: 'Rename', icon: 'rename' },
    { action: 'delete', label: 'Delete', icon: 'trash' }
  ]
}

/**
 * STARK-owned tree context menu (never the browser-native menu).
 * Fixed-position portal; closes on outside pointer or Escape.
 */
export function ExplorerContextMenu({ target, x, y, onAction, onClose }: ExplorerContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<{ readonly top: number; readonly left: number } | null>(null)

  useLayoutEffect(() => {
    function place(): void {
      const element = menuRef.current
      const width = element?.offsetWidth ?? 220
      const height = element?.offsetHeight ?? 180
      const margin = 8
      let left = Math.min(x, window.innerWidth - width - margin)
      left = Math.max(margin, left)
      let top = Math.min(y, window.innerHeight - height - margin)
      top = Math.max(margin, top)
      setPlacement((prev) => (prev !== null && prev.top === top && prev.left === left ? prev : { top, left }))
    }
    place()
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
    }
  }, [x, y])

  useEffect(() => {
    function handlePointer(event: PointerEvent): void {
      const node = event.target as Node | null
      if (node !== null && menuRef.current !== null && menuRef.current.contains(node)) {
        return
      }
      onClose()
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey, true)
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      className="explorer__menu"
      role="menu"
      aria-label={target.kind === 'root' ? 'Project actions' : `Actions for ${target.name}`}
      style={placement === null ? { visibility: 'hidden' } : { top: placement.top, left: placement.left }}
    >
      {menuItemsFor(target).map((item) => (
        <button
          key={item.action}
          className="explorer__menu-item"
          type="button"
          role="menuitem"
          onClick={() => onAction(item.action)}
        >
          <UiIcon name={item.icon} size={14} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}

interface ExplorerDeleteConfirmProps {
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly busy: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/**
 * Delete confirmation (STARK-owned dialog, never browser-native).
 * Deletion moves the entry to the system Trash — never permanent.
 */
export function ExplorerDeleteConfirm({ name, kind, busy, onConfirm, onCancel }: ExplorerDeleteConfirmProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onCancel])

  return createPortal(
    <div className="explorer__confirm-backdrop">
      <div className="explorer__confirm" role="alertdialog" aria-label={`Delete ${name}?`} aria-modal="true">
        <p className="explorer__confirm-title">{`Delete “${name}”?`}</p>
        <p className="explorer__confirm-copy">
          {kind === 'directory'
            ? 'This will move the folder and everything inside it to the system Trash.'
            : 'This will move the file to the system Trash.'}
        </p>
        <div className="explorer__confirm-actions">
          <button
            ref={cancelRef}
            className="explorer__secondary"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="explorer__danger"
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-label={`Move ${name} to Trash`}
          >
            {busy ? 'Moving…' : 'Move to Trash'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
