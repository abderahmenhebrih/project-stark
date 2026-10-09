import type { ReactElement, ReactNode } from 'react'
import './MainLayout.css'

interface MainLayoutProps {
  readonly children: ReactNode
}

/**
 * Main application chrome: viewport-bounding shell only. All identity
 * and navigation live in the single global AppChrome bar so the shell
 * never stacks redundant toolbars.
 */
export function MainLayout({ children }: MainLayoutProps): ReactElement {
  return (
    <div className="shell">
      <main className="shell__main">{children}</main>
    </div>
  )
}
