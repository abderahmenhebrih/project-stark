import type { Dispatch, ReactElement } from 'react'
import type { AgentCapability } from '../../../../../shared/capabilities/types'
import {
  CAPABILITY_ORDER,
  capabilityLabel,
  legalModesFor,
  type CapabilityPanelAction,
  type CapabilityPanelState
} from '../../sessions/capabilities-state'
import { UiIcon, type UiIconName } from '../../../components/icons/UiIcon'
import './PermissionsSettings.css'

interface PermissionsSettingsProps {
  readonly workspaceId: number
  readonly capabilities: CapabilityPanelState
  readonly capabilitiesDispatch: Dispatch<CapabilityPanelAction>
  readonly onSaveCapabilities: () => void
}

/**
 * Capability groups for the table (presentation only — enforcement
 * stays with CAPABILITY_ORDER and the main-process gate). Every
 * canonical id has exactly one group, so rows render directly from
 * CAPABILITY_ORDER and no capability can be dropped or invented here.
 */
type CapabilityGroupKey = 'read' | 'change' | 'execute'

const CAPABILITY_GROUP: Record<AgentCapability, CapabilityGroupKey> = {
  'workspace.read': 'read',
  'workspace.search': 'read',
  'git.read': 'read',
  'runtime.observe': 'read',
  'preview.inspect': 'read',
  'change.propose': 'change',
  'attachment.import': 'change',
  'terminal.execute': 'execute',
  'image.generate': 'execute'
}

const CAPABILITY_GROUPS: readonly { readonly key: CapabilityGroupKey; readonly title: string }[] = [
  { key: 'read', title: 'Read & inspect' },
  { key: 'change', title: 'Change & import' },
  { key: 'execute', title: 'Execute & generate' }
]

/** One-line presentation copy per capability (semantics unchanged). */
const CAPABILITY_COPY: Record<AgentCapability, string> = {
  'workspace.read': 'Read files in the current workspace.',
  'workspace.search': 'Search text across workspace files.',
  'git.read': 'Inspect repository status and diffs.',
  'change.propose': 'Propose file changes for human review.',
  'attachment.import': 'Import chat attachments into the project.',
  'image.generate': 'Generate images for workspace tasks.',
  'terminal.execute': 'Run terminal commands inside the workspace.',
  'runtime.observe': 'Inspect managed runtime status and bounded logs.',
  'preview.inspect': 'Inspect rendered local preview content.'
}

/** Glyph per capability from the existing local icon set (no new assets). */
const CAPABILITY_ICON: Record<AgentCapability, UiIconName> = {
  'workspace.read': 'explorer',
  'workspace.search': 'search',
  'git.read': 'git',
  'change.propose': 'review',
  'attachment.import': 'paperclip',
  'image.generate': 'context',
  'terminal.execute': 'terminal',
  'runtime.observe': 'refresh',
  'preview.inspect': 'extensions'
}

/**
 * Settings → Permissions as ONE LoopLink-family table: container
 * header (master switch), column header, group section rows, one row
 * per capability (capability / description / mode). Each legal row
 * carries ONE real switch — OFF means Always ask, ON means Allow.
 * Ask-only capabilities render the same row with a permanently OFF
 * disabled switch. Legacy `deny` stays stored and enforced until the
 * user flips the switch (OFF flip sets ask explicitly, ON sets allow
 * where legal) — shown only as a tiny muted note, never a badge, never
 * a selectable choice. Enforcement, ids, legal modes, defaults, and
 * the explicit-save flow are untouched.
 */
export function PermissionsSettings(props: PermissionsSettingsProps): ReactElement {
  const { workspaceId, capabilities } = props
  const enabled = capabilities.draft.enabled
  return (
    <section aria-label="Permissions" className="permissions-page">
      <p className="settings-section__title">Permissions</p>
      <p className="settings-section__copy">Control what STARK is allowed to access and do.</p>
      <div className={'permissions-table' + (enabled ? '' : ' permissions-table--muted')}>
        <div className="permissions-master">
          <div className="permissions-master__text">
            <p className="permissions-master__title">Agent Permissions</p>
            <p className="permissions-master__copy">
              These permissions control what STARK is allowed to access and do in your workspace.
            </p>
          </div>
          <span className="permissions-master__action">
            <span className="permissions-master__enable">Enable all permissions</span>
            <button
              className={'permissions-switch' + (enabled ? ' permissions-switch--on' : '')}
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Enable Agent Permissions"
              onClick={() => props.capabilitiesDispatch({ type: 'enabled-toggled', workspaceId, enabled: !enabled })}
            >
              <span className="permissions-switch__knob" aria-hidden="true" />
            </button>
          </span>
        </div>
        <p className="permissions-safety" role="note">
          Permissions only control whether future STARK Worker tools may request an action. They do not bypass
          Workspace security or human review.
        </p>
        <table className="permissions-table__grid" aria-label="Workspace Agent Capabilities">
          <thead className="permissions-table__head">
            <tr>
              <th scope="col" className="permissions-table__th permissions-table__th--capability">
                Capability
              </th>
              <th scope="col" className="permissions-table__th permissions-table__th--description">
                Description
              </th>
              <th scope="col" className="permissions-table__th permissions-table__th--mode">
                Mode
              </th>
            </tr>
          </thead>
          <tbody aria-disabled={!enabled}>
            {CAPABILITY_GROUPS.map((group) => {
              const members = CAPABILITY_ORDER.filter((capability) => CAPABILITY_GROUP[capability] === group.key)
              return [
                <tr key={group.key} className="permissions-table__sectionrow" aria-hidden="true">
                  <td colSpan={3} className="permissions-table__section">
                    {group.title} · {members.length}
                  </td>
                </tr>,
                ...members.map((capability) => {
                  const mode = capabilities.draft.modes[capability]
                  const name = capabilityLabel(capability)
                  const allowLegal = legalModesFor(capability).includes('allow')
                  const checked = mode === 'allow'
                  return (
                    <tr key={capability} className="permissions-table__row">
                      <td className="permissions-table__td permissions-table__capability">
                        <span className="permissions-table__icon" aria-hidden="true">
                          <UiIcon name={CAPABILITY_ICON[capability]} size={18} />
                        </span>
                        <span className="permissions-table__name">{name}</span>
                      </td>
                      <td className="permissions-table__td permissions-table__description">
                        {CAPABILITY_COPY[capability]}
                        {mode === 'deny' && (
                          <span
                            className="permissions-table__deniednote"
                            title="This capability is currently blocked. Flipping the switch updates this policy."
                          >
                            {' '}
                            · Blocked
                          </span>
                        )}
                      </td>
                      <td className="permissions-table__td permissions-table__mode">
                        <span className={'permissions-toggle' + (checked ? ' permissions-toggle--on' : '')}>
                          <span className="permissions-toggle__label">Always ask</span>
                          <button
                            className={'permissions-switch' + (checked ? ' permissions-switch--on' : '')}
                            type="button"
                            role="switch"
                            aria-checked={checked}
                            aria-label={
                              allowLegal
                                ? `Allow ${name} without asking`
                                : `${name} is always ask`
                            }
                            aria-disabled={!allowLegal}
                            title={allowLegal ? undefined : 'Always ask is required for this capability.'}
                            disabled={!enabled}
                            onClick={() => {
                              if (!allowLegal) {
                                return
                              }
                              props.capabilitiesDispatch({
                                type: 'mode-selected',
                                workspaceId,
                                capability,
                                mode: checked ? 'ask' : 'allow'
                              })
                            }}
                          >
                            <span className="permissions-switch__knob" aria-hidden="true" />
                          </button>
                          <span className="permissions-toggle__label">Allow</span>
                        </span>
                      </td>
                    </tr>
                  )
                })
              ]
            })}
          </tbody>
        </table>
      </div>
      <p className="permissions-status" role="status">
        Agent permissions {enabled ? 'Enabled' : 'Disabled'}
      </p>
      {!enabled && (
        <p className="session__hint" role="note">
          Enable Agent Permissions to use these capability policies.
        </p>
      )}
      {capabilities.loading && (
        <p className="session__status" role="status">
          Loading permissions…
        </p>
      )}
      {capabilities.loadError !== null && (
        <p className="session__error" role="alert">
          {capabilities.loadError}
        </p>
      )}
      {capabilities.saveError !== null && (
        <p className="session__error" role="alert">
          {capabilities.saveError}
        </p>
      )}
      {capabilities.notice !== null && (
        <p className="session__status" role="status">
          {capabilities.notice}
        </p>
      )}
      <div className="session__settings-row">
        <button
          className="explorer__primary"
          type="button"
          onClick={props.onSaveCapabilities}
          disabled={capabilities.saving}
        >
          {capabilities.saving ? 'Saving…' : 'Save permissions'}
        </button>
      </div>
    </section>
  )
}
