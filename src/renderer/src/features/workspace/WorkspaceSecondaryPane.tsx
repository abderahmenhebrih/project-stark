import type { ReactElement, ReactNode } from 'react'
import { StarkIcon } from '../../components/icons/StarkIcon'

export type SecondaryTabKind = 'review' | 'context' | 'file'

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
}

/**
 * Contextual secondary workspace pane: Review / Context / file tabs
 * above an optional stacked terminal. Rendered only when useful (a
 * file, review, context request, or terminal needs it); otherwise it
 * unmounts and the session expands. Presentational only — all review,
 * editor, context, and terminal state stays with its existing owner.
 */
export function WorkspaceSecondaryPane({
  tabs,
  activeTab,
  onTabChange,
  onOpenDrawer,
  onClosePane,
  children,
  terminalNode,
  terminalOpen
}: WorkspaceSecondaryPaneProps): ReactElement {
  return (
    <section className="workspace__secondary" aria-label="Workspace">
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
            title={tab.kind === 'review' ? 'Review' : tab.kind === 'context' ? 'Context' : tab.label}
            aria-label={tab.kind === 'file' ? `File ${tab.label}` : tab.label}
            onClick={() => onTabChange(tab.kind)}
          >
            {tab.kind === 'review' ? (
              <StarkIcon name="review" size={14} />
            ) : tab.kind === 'context' ? (
              <StarkIcon name="context" size={14} />
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
          <StarkIcon name="plus" size={15} />
        </button>
        <button
          className="workspace__tab-action"
          type="button"
          onClick={onClosePane}
          aria-label="Close workspace pane"
          title="Close workspace pane"
        >
          <StarkIcon name="close" size={15} />
        </button>
      </div>
      <div className="workspace__pane-body">{children}</div>
      {terminalOpen && <div className="workspace__terminal">{terminalNode}</div>}
    </section>
  )
}
