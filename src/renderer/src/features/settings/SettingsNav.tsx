import type { ReactElement } from 'react'
import { SETTINGS_SECTIONS, type SettingsSection } from './settings-section'

interface SettingsNavProps {
  readonly section: SettingsSection
  readonly onSectionChange: (section: SettingsSection) => void
}

/**
 * Settings V2 left navigation: exactly the five locked categories.
 * Selected rows use the magenta selection cue (secondary accent);
 * lime stays reserved for primary actions in the content canvas.
 */
export function SettingsNav({ section, onSectionChange }: SettingsNavProps): ReactElement {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map((entry) => (
        <button
          key={entry.kind}
          className={
            section === entry.kind ? 'settings-nav__item settings-nav__item--active' : 'settings-nav__item'
          }
          type="button"
          aria-current={section === entry.kind}
          onClick={() => onSectionChange(entry.kind)}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  )
}
