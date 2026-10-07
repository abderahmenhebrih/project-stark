import type { ReactElement, ReactNode } from 'react'
import { APP_NAME, FOUNDATION_LABEL } from '../../../shared/constants'
import { useAppInfo } from '../hooks/useAppInfo'
import './MainLayout.css'

interface MainLayoutProps {
  readonly children: ReactNode
}

/**
 * Main application chrome: header, content area, footer.
 * Keeps page components free of shell concerns.
 */
export function MainLayout({ children }: MainLayoutProps): ReactElement {
  const { appInfo } = useAppInfo()

  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__brand">{APP_NAME}</span>
        <span className="shell__stage">{FOUNDATION_LABEL}</span>
      </header>
      <main className="shell__main">{children}</main>
      <footer className="shell__footer">
        <span className="shell__footer-version">{appInfo === null ? '…' : `v${appInfo.version}`}</span>
      </footer>
    </div>
  )
}
