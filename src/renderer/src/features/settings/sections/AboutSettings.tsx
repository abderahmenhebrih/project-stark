import { useEffect, useState, type ReactElement } from 'react'
import { useAppInfo } from '../../../hooks/useAppInfo'
import { STARK_FULL_LOGO_URL } from '../../../components/brandAssets'

/**
 * Developer diagnostics (read-only): Extension Host lifecycle state.
 * Normal users never manage the host here — it starts on demand and
 * stops by lifecycle policy. Status text only, no process details.
 */
function DeveloperDiagnostics(): ReactElement {
  const [hostState, setHostState] = useState<string>('unknown')
  useEffect(() => {
    let cancelled = false
    void import('../../../lib/stark-api').then(
      (api) => {
        api.getExtensionHostStatus().then(
          (status) => {
            if (!cancelled) {
              setHostState(status.state)
            }
          },
          () => {}
        )
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <div className="session__settings-row">
      <span className="session__provider-name">Developer</span>
      <p className="session__hint" role="note">
        Extension Host: {hostState}. The host starts on demand when an extension runs.
      </p>
    </div>
  )
}

/**
 * Settings → About: real application metadata only (version, desktop
 * platform, Electron build). No paths, no environment, no machine
 * identifiers, no secrets. Third-party notices ship with the product
 * in THIRD_PARTY_NOTICES.md.
 */
export function AboutSettings(): ReactElement {
  const { appInfo } = useAppInfo()
  return (
    <section aria-label="About STARK">
      <p className="settings-section__title">About</p>
      <img className="settings-about__logo" src={STARK_FULL_LOGO_URL} alt="STARK" />
      <div className="session__settings-row">
        <span className="session__provider-name">
          {appInfo === null ? 'Starting…' : `v${appInfo.version} · ${appInfo.platform} · Electron ${appInfo.electron}`}
        </span>
      </div>
      <p className="session__hint" role="note">
        Your model stopped. Your work didn’t.
      </p>
      <p className="session__hint" role="note">
        Local-first coding workspace. Your projects and local STARK data remain on this device.
      </p>
      <p className="session__hint" role="note">
        Third-party notices ship with STARK in THIRD_PARTY_NOTICES.md.
      </p>
      <DeveloperDiagnostics />
    </section>
  )
}
