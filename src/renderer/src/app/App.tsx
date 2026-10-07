import type { ReactElement } from 'react'
import { AppProvider } from './AppProvider'
import { useApp } from './app-context'
import { OnboardingPage } from '../features/onboarding/OnboardingPage'
import { MainLayout } from '../layouts/MainLayout'
import { HomePage } from '../pages/HomePage'
import './App.css'

function BootLoading(): ReactElement {
  return (
    <div className="boot">
      <p className="boot__text" role="status">
        Loading…
      </p>
    </div>
  )
}

function BootError(): ReactElement {
  const { retryBoot } = useApp()
  return (
    <div className="boot">
      <p className="boot__text" role="alert">
        STARK couldn’t start. Check the connection and try again.
      </p>
      <button className="boot__retry" type="button" onClick={retryBoot}>
        Retry
      </button>
    </div>
  )
}

function BootRouter(): ReactElement {
  const { boot } = useApp()
  if (boot === 'loading') {
    return <BootLoading />
  }
  if (boot === 'error') {
    return <BootError />
  }
  if (boot === 'onboarding') {
    return <OnboardingPage />
  }
  return (
    <MainLayout>
      <HomePage />
    </MainLayout>
  )
}

/**
 * STARK application root.
 * The provider resolves first-launch onboarding before any shell
 * renders, so the greeting shell never flashes during profile load.
 */
export function App(): ReactElement {
  return (
    <AppProvider>
      <BootRouter />
    </AppProvider>
  )
}
