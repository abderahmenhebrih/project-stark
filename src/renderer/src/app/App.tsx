import type { ReactElement } from 'react'
import { MainLayout } from '../layouts/MainLayout'
import { HomePage } from '../pages/HomePage'

/**
 * STARK application root.
 * Pages are composed inside the main layout; routing will be added
 * later without changing this composition point.
 */
export function App(): ReactElement {
  return (
    <MainLayout>
      <HomePage />
    </MainLayout>
  )
}
