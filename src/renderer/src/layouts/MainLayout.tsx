import type { ReactElement, ReactNode } from 'react'
import { APP_NAME } from '../../../shared/constants'
import { StarkMark } from '../components/StarkMark'
import './MainLayout.css'

interface MainLayoutProps {
  readonly children: ReactNode
}

/**
 * Main application chrome: compact IDE app bar plus the content area.
 * Version/status live once in the workbench status bar (SystemStatus),
 * so no duplicate footer line is rendered.
 */
export function MainLayout({ children }: MainLayoutProps): ReactElement {

  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__brand">
          <StarkMark size="bar" />
          {APP_NAME}
        </span>
      </header>
      <main className="shell__main">{children}</main>
    </div>
  )
}
