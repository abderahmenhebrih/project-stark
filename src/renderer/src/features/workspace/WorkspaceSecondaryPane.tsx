import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { UiIcon } from '../../components/icons/UiIcon'

export type SecondaryTabKind = 'review' | 'context' | 'file' | 'live'

interface SecondaryTab {
  readonly kind: SecondaryTabKind
  readonly label: string
}

interface WorkspaceSecondaryPaneProps {
  readonly tabs: readonly SecondaryTab[]
  readonly activeTab: SecondaryTabKind
  readonly onTabChange: (tab: SecondaryTabKind) => void
  readonly onOpenDrawer: () => void
  readonly onClosePane: () => void
  readonly children: ReactNode
  readonly terminalNode: ReactNode
  readonly terminalOpen: boolean
  /** Optional flex sizing from the parent split state (drag divider). */
  readonly style?: CSSProperties
}

/**
 * Contextual secondary workspace pane: Review / Context / file / Live
 * Review tabs above an optional stacked terminal. Rendered only when
 * useful (a file, review, context request, Live Review, or terminal
 * needs it); otherwise it unmounts and the session expands.
 * Presentational only — all review, editor, context, Live Review,
 * and terminal state stays with its existing owner. Explicit tab
 * selections win ownership; background updates never steal it.
 */
export function WorkspaceSecondaryPane({
  tabs,
  activeTab,
  onTabChange,
  onOpenDrawer,
  onClosePane,
  children,
  terminalNode,
  terminalOpen,
  style
}: WorkspaceSecondaryPaneProps): ReactElement {
  function tabTitle(kind: SecondaryTabKind, label: string): string {
    if (kind === 'review') {
      return 'Review'
    }
    if (kind === 'context') {
      return 'Context'
    }
    if (kind === 'live') {
      return 'Live Review — localhost preview'
    }
    return label
  }

  return (
    <section className="workspace__secondary" aria-label="Workspace" style={style}>
      <div className="workspace__tabs" role="tablist" aria-label="Workspace views">
        {tabs.map((tab) => (
          <button
            key={tab.kind}
            className={
              activeTab === tab.kind
                ? `workspace__tab workspace__tab--${tab.kind} workspace__tab--active`
                : `workspace__tab workspace__tab--${tab.kind}`
            }
            type="button"
            role="tab"
            aria-selected={activeTab === tab.kind}
            title={tab.kind === 'file' ? tab.label : tabTitle(tab.kind, tab.label)}
            aria-label={tab.kind === 'file' ? `File ${tab.label}` : tab.label}
            onClick={() => onTabChange(tab.kind)}
          >
            {tab.kind === 'review' ? (
              <UiIcon name="review" size={14} />
            ) : tab.kind === 'context' ? (
              <UiIcon name="context" size={14} />
            ) : tab.kind === 'live' ? (
              <UiIcon name="live" size={14} />
            ) : null}
            <span className="workspace__tab-label">{tab.label}</span>
          </button>
        ))}
        <span className="workspace__tabs-spacer" aria-hidden="true" />
        <button
          className="workspace__tab-action"
          type="button"
          onClick={onOpenDrawer}
          aria-label="Open workspace tools"
          title="Open workspace tools"
        >
          <UiIcon name="plus" size={15} />
        </button>
        <button
          className="workspace__tab-action"
          type="button"
          onClick={onClosePane}
          aria-label="Close workspace pane"
          title="Close workspace pane"
        >
          <UiIcon name="close" size={15} />
        </button>
      </div>
      <div className="workspace__pane-body">{children}</div>
      {terminalOpen && <div className="workspace__terminal">{terminalNode}</div>}
    </section>
  )
}
