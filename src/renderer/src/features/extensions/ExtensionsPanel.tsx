import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import type { ExtensionEntry, InstalledExtensionEntry } from '../../../../shared/extension-registry/types'
import { getExtensionHostStatus, installExtension, listFeaturedExtensions, listInstalledExtensions, searchExtensionCatalog, setExtensionEnabled, startExtensionHost, stopExtensionHost, uninstallExtension } from '../../lib/stark-api'
import type { ExtensionHostState } from '../../../../shared/extension-host/types'
import { StarkIcon } from '../../components/icons/StarkIcon'
import './ExtensionsPanel.css'

/** Live-catalog debounce: one registry request per 300ms of typing quiet. */
const CATALOG_DEBOUNCE_MS = 300

const BUILT_IN: readonly string[] = ['STARK Editor', 'STARK Git', 'STARK Terminal']

interface CatalogState {
  readonly entries: readonly ExtensionEntry[]
  readonly loading: boolean
  readonly error: string | null
  readonly loadedQuery: string | null
}

type CatalogAction =
  | { readonly type: 'catalog-started' }
  | { readonly type: 'catalog-succeeded'; readonly entries: readonly ExtensionEntry[]; readonly query: string | null }
  | { readonly type: 'catalog-failed' }

function initialCatalogState(): CatalogState {
  return { entries: [], loading: false, error: null, loadedQuery: null }
}

function catalogReducer(state: CatalogState, action: CatalogAction): CatalogState {
  switch (action.type) {
    case 'catalog-started':
      return { ...state, loading: true, error: null }
    case 'catalog-succeeded':
      return { entries: action.entries, loading: false, error: null, loadedQuery: action.query }
    case 'catalog-failed':
      return { ...state, loading: false, error: 'We couldn’t load extensions.' }
  }
}

function formatDownloads(count: number): string {
  return count.toLocaleString('en-US')
}

function ExtensionIcon({ iconUrl }: { readonly iconUrl: string | null }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (iconUrl === null || failed) {
    return (
      <span className="extensions__icon-fallback" aria-hidden="true">
        <StarkIcon name="extensions" size={20} />
      </span>
    )
  }
  return (
    <img
      className="extensions__icon"
      src={iconUrl}
      alt=""
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

type ExtensionsView = 'marketplace' | 'installed'

/**
 * Extension catalog browser with safe installation (store only).
 *
 * The panel never touches the registry or the filesystem: keystrokes
 * debounce 300ms into the main-owned catalog bridge (fixed Open VSX
 * origin, 10s timeout, zero retries, max 20 results), with stale
 * responses discarded by monotonic request ids. Install buttons send
 * normalized identity only; download, validation, extraction, and
 * storage are main-owned and bounded, and installed packages stay
 * inert files (never activated or executed). All registry text
 * renders as plain React text.
 */
export function ExtensionsPanel(): ReactElement {
  const [input, setInput] = useState('')
  const [view, setView] = useState<ExtensionsView>('marketplace')
  const [state, dispatch] = useReducer(catalogReducer, undefined, initialCatalogState)
  const { entries, loading, error, loadedQuery } = state
  const requestIdRef = useRef(0)
  const [installingIds, setInstallingIds] = useState<readonly string[]>([])
  const [failedIds, setFailedIds] = useState<readonly string[]>([])
  /** Renderer-safe failure copy per entry, as returned by main (matched, never raw internals). */
  const [failedMessages, setFailedMessages] = useState<Readonly<Record<string, string>>>({})
  const [installedByKey, setInstalledByKey] = useState<Readonly<Record<string, InstalledExtensionEntry>>>({})
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [uninstallingKeys, setUninstallingKeys] = useState<readonly string[]>([])
  const [uninstallFailedKeys, setUninstallFailedKeys] = useState<readonly string[]>([])
  const [stateChangingKeys, setStateChangingKeys] = useState<readonly string[]>([])
  const [stateFailedKeys, setStateFailedKeys] = useState<readonly string[]>([])
  const [hostState, setHostState] = useState<ExtensionHostState>('stopped')
  const [hostBusy, setHostBusy] = useState(false)

  function installedKeyOf(namespace: string, name: string, version: string): string {
    return `${namespace}.${name}@${version}`
  }

  const installedCount = Object.keys(installedByKey).length

  useEffect(() => {
    // The Installed view is local disk state only: no catalog request,
    // so it renders fully offline.
    if (view !== 'marketplace') {
      return
    }
    const trimmed = input.trim()
    if (trimmed === '') {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      dispatch({ type: 'catalog-started' })
      listFeaturedExtensions().then(
        (result) => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-succeeded', entries: result.entries, query: null })
        },
        () => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-failed' })
        }
      )
      return
    }
    const timer = setTimeout(() => {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      dispatch({ type: 'catalog-started' })
      searchExtensionCatalog({ query: trimmed }).then(
        (result) => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-succeeded', entries: result.entries, query: trimmed })
        },
        () => {
          if (requestIdRef.current !== requestId) {
            return
          }
          dispatch({ type: 'catalog-failed' })
        }
      )
    }, CATALOG_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [input, view])

  useEffect(() => {
    let cancelled = false
    listInstalledExtensions().then(
      (installed) => {
        if (cancelled) {
          return
        }
        const next: Record<string, InstalledExtensionEntry> = {}
        for (const item of installed) {
          next[`${item.namespace}.${item.name}@${item.version}`] = item
        }
        setInstalledByKey(next)
      },
      () => {
        // Installed state stays empty; catalog rows remain installable.
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  function refreshInstalled(): void {
    listInstalledExtensions().then(
      (installed) => {
        const next: Record<string, InstalledExtensionEntry> = {}
        for (const item of installed) {
          next[`${item.namespace}.${item.name}@${item.version}`] = item
        }
        setInstalledByKey(next)
      },
      () => {
        // Keep the last known installed set on refresh failure.
      }
    )
  }

  function refreshHostStatus(): void {
    getExtensionHostStatus().then(
      (status) => setHostState(status.state),
      () => {
        // Keep the last known host state on refresh failure.
      }
    )
  }

  useEffect(() => {
    refreshHostStatus()
  }, [])

  function handleStartHost(): void {
    if (hostBusy) {
      return
    }
    setHostBusy(true)
    startExtensionHost().then(
      (status) => {
        setHostState(status.state)
        setHostBusy(false)
      },
      () => {
        setHostBusy(false)
        refreshHostStatus()
      }
    )
  }

  function handleStopHost(): void {
    if (hostBusy) {
      return
    }
    setHostBusy(true)
    stopExtensionHost().then(
      (status) => {
        setHostState(status.state)
        setHostBusy(false)
      },
      () => {
        setHostBusy(false)
        refreshHostStatus()
      }
    )
  }

  function handleInstall(entry: ExtensionEntry): void {
    if (installingIds.includes(entry.id)) {
      return
    }
    setFailedIds((ids) => ids.filter((id) => id !== entry.id))
    setFailedMessages((messages) => {
      if (messages[entry.id] === undefined) {
        return messages
      }
      const next = { ...messages }
      delete next[entry.id]
      return next
    })
    setInstallingIds((ids) => (ids.includes(entry.id) ? ids : [...ids, entry.id]))
    installExtension({ namespace: entry.namespace, name: entry.name, version: entry.version }).then(
      () => {
        setInstallingIds((ids) => ids.filter((id) => id !== entry.id))
        refreshInstalled()
      },
      (error: unknown) => {
        setInstallingIds((ids) => ids.filter((id) => id !== entry.id))
        setFailedIds((ids) => (ids.includes(entry.id) ? ids : [...ids, entry.id]))
        const copy = error instanceof Error && error.message !== '' ? error.message : 'Install failed'
        setFailedMessages((messages) => ({ ...messages, [entry.id]: copy }))
      }
    )
  }

  function installKey(entry: ExtensionEntry): string {
    return installedKeyOf(entry.namespace, entry.name, entry.version)
  }

  function renderInstallAction(entry: ExtensionEntry): ReactElement {
    const installed = installedByKey[installKey(entry)]
    if (installed !== undefined) {
      return (
        <span className="extensions__installed-state">
          <button className="extensions__installed" type="button" disabled aria-label={`${entry.displayName} installed`}>
            Installed
          </button>
          <span className="extensions__state-label">{installed.enabled ? ' · Enabled' : ' · Disabled'}</span>
        </span>
      )
    }
    if (installingIds.includes(entry.id)) {
      return (
        <button className="extensions__install" type="button" disabled aria-label={`Installing ${entry.displayName}`}>
          Installing…
        </button>
      )
    }
    if (failedIds.includes(entry.id)) {
      // Main returns normalized safe copy only: the standing size
      // policy names itself, everything else stays a calm failure.
      const copy = failedMessages[entry.id] ?? 'Install failed'
      const tooLarge = copy.includes('50 MiB safety limit')
      return (
        <span className="extensions__install-failed">
          <span className="extensions__install-failed-copy">
            {tooLarge ? 'Extension package exceeds STARK’s 50 MiB safety limit.' : 'Install failed'}
          </span>
          <button className="extensions__retry" type="button" onClick={() => handleInstall(entry)}>
            Retry
          </button>
        </span>
      )
    }
    return (
      <button
        className="extensions__install"
        type="button"
        onClick={() => handleInstall(entry)}
        aria-label={`Install ${entry.displayName}`}
      >
        Install
      </button>
    )
  }

  function handleUninstallRequest(item: InstalledExtensionEntry): void {
    setUninstallFailedKeys((keys) => keys.filter((key) => key !== installedKeyOf(item.namespace, item.name, item.version)))
    setConfirmingKey(installedKeyOf(item.namespace, item.name, item.version))
  }

  function handleUninstallCancel(): void {
    setConfirmingKey(null)
  }

  function handleUninstallConfirm(item: InstalledExtensionEntry): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    if (uninstallingKeys.includes(key)) {
      return
    }
    setConfirmingKey(null)
    setUninstallingKeys((keys) => (keys.includes(key) ? keys : [...keys, key]))
    uninstallExtension({ namespace: item.namespace, name: item.name, version: item.version }).then(
      () => {
        setUninstallingKeys((keys) => keys.filter((other) => other !== key))
        refreshInstalled()
      },
      () => {
        setUninstallingKeys((keys) => keys.filter((other) => other !== key))
        setUninstallFailedKeys((keys) => (keys.includes(key) ? keys : [...keys, key]))
      }
    )
  }

  /**
   * Enable/disable flip for one exact installed version. Sends
   * identity plus the desired flag; persistence is main-owned.
   * One in-flight change per exact identity; failures surface calm
   * copy with user-initiated retry only. No polling, no retry loop.
   */
  function handleSetEnabled(item: InstalledExtensionEntry, enabled: boolean): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    if (stateChangingKeys.includes(key)) {
      return
    }
    setStateFailedKeys((keys) => keys.filter((other) => other !== key))
    setStateChangingKeys((keys) => (keys.includes(key) ? keys : [...keys, key]))
    setExtensionEnabled({ namespace: item.namespace, name: item.name, version: item.version }, enabled).then(
      () => {
        setStateChangingKeys((keys) => keys.filter((other) => other !== key))
        refreshInstalled()
      },
      () => {
        setStateChangingKeys((keys) => keys.filter((other) => other !== key))
        setStateFailedKeys((keys) => (keys.includes(key) ? keys : [...keys, key]))
      }
    )
  }

  function renderStateAction(item: InstalledExtensionEntry): ReactElement {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    if (stateChangingKeys.includes(key)) {
      return (
        <button className="extensions__secondary" type="button" disabled aria-label={`Updating ${item.displayName}`}>
          Updating…
        </button>
      )
    }
    if (stateFailedKeys.includes(key)) {
      return (
        <span className="extensions__install-failed">
          <span className="extensions__install-failed-copy">Couldn’t update extension state.</span>
          <button
            className="extensions__retry"
            type="button"
            onClick={() => handleSetEnabled(item, !item.enabled)}
            aria-label={`Retry ${item.enabled ? 'disabling' : 'enabling'} ${item.displayName}`}
          >
            Retry
          </button>
        </span>
      )
    }
    if (item.enabled) {
      return (
        <button
          className="extensions__secondary"
          type="button"
          onClick={() => handleSetEnabled(item, false)}
          aria-label={`Disable ${item.displayName}`}
        >
          Disable
        </button>
      )
    }
    return (
      <button
        className="extensions__secondary"
        type="button"
        onClick={() => handleSetEnabled(item, true)}
        aria-label={`Enable ${item.displayName}`}
      >
        Enable
      </button>
    )
  }

  function renderInstalledRow(item: InstalledExtensionEntry): ReactElement {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    return (
      <li key={key} className="extensions__installed-row">
        <ExtensionIcon iconUrl={item.iconUrl} />
        <span className="extensions__installed-details">
          <span className="extensions__installed-name">{item.displayName}</span>
          <span className="extensions__installed-meta">
            {item.namespace} · {item.version}
          </span>
          <span className="extensions__state-label">{item.enabled ? 'Enabled' : 'Disabled'}</span>
        </span>
        {uninstallingKeys.includes(key) ? (
          <button className="extensions__uninstall" type="button" disabled aria-label={`Uninstalling ${item.displayName}`}>
            Uninstalling…
          </button>
        ) : confirmingKey === key ? (
          <span className="extensions__confirm">
            <span className="extensions__confirm-copy">
              Uninstall {item.displayName}? This removes the extension package from STARK. It does not modify your
              project files.
            </span>
            <span className="extensions__confirm-actions">
              <button className="extensions__secondary" type="button" onClick={handleUninstallCancel}>
                Cancel
              </button>
              <button
                className="extensions__uninstall"
                type="button"
                onClick={() => handleUninstallConfirm(item)}
                aria-label={`Confirm uninstall of ${item.displayName}`}
              >
                Uninstall
              </button>
            </span>
          </span>
        ) : uninstallFailedKeys.includes(key) ? (
          <span className="extensions__install-failed">
            <span className="extensions__install-failed-copy">Uninstall failed</span>
            <button className="extensions__retry" type="button" onClick={() => handleUninstallRequest(item)}>
              Retry
            </button>
          </span>
        ) : (
          <span className="extensions__row-actions">
            {renderStateAction(item)}
            <button
              className="extensions__uninstall"
              type="button"
              onClick={() => handleUninstallRequest(item)}
              aria-label={`Uninstall ${item.displayName}`}
            >
              Uninstall
            </button>
          </span>
        )}
      </li>
    )
  }

  function handleRetry(): void {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const trimmed = input.trim()
    dispatch({ type: 'catalog-started' })
    const pending = trimmed === '' ? listFeaturedExtensions() : searchExtensionCatalog({ query: trimmed })
    pending.then(
      (result) => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'catalog-succeeded', entries: result.entries, query: trimmed === '' ? null : trimmed })
      },
      () => {
        if (requestIdRef.current !== requestId) {
          return
        }
        dispatch({ type: 'catalog-failed' })
      }
    )
  }

  const installedItems = Object.values(installedByKey)

  return (
    <section className="extensions" aria-label="Extensions">
      <div className="extensions__views" role="tablist" aria-label="Extensions views">
        <button
          className={view === 'marketplace' ? 'extensions__view-tab extensions__view-tab--active' : 'extensions__view-tab'}
          type="button"
          role="tab"
          aria-selected={view === 'marketplace'}
          onClick={() => setView('marketplace')}
        >
          Marketplace
        </button>
        <button
          className={view === 'installed' ? 'extensions__view-tab extensions__view-tab--active' : 'extensions__view-tab'}
          type="button"
          role="tab"
          aria-selected={view === 'installed'}
          onClick={() => setView('installed')}
        >
          Installed ({installedCount})
        </button>
      </div>
      {view === 'marketplace' ? (
        <>
          <div className="extensions__field">
            <span className="extensions__field-icon" aria-hidden="true">
              <StarkIcon name="search" size={16} />
            </span>
            <input
              className="extensions__input"
              type="search"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search extensions…"
              aria-label="Search extensions"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <p className="extensions__summary">VS Code-compatible extensions</p>
          {loading && (
            <p className="extensions__status" role="status">
              Loading extensions…
            </p>
          )}
          {error !== null && !loading && (
            <div className="extensions__error" role="alert">
              <p className="extensions__error-copy">We couldn’t load extensions.</p>
              <button className="extensions__retry" type="button" onClick={handleRetry}>
                Retry
              </button>
            </div>
          )}
          {error === null && !loading && entries.length === 0 && loadedQuery !== null && (
            <p className="extensions__status" role="status">
              No extensions found for “{loadedQuery}”.
            </p>
          )}
          {entries.length > 0 && (
            <ul className="extensions__results" aria-label="Extension catalog results">
              {entries.map((entry) => (
                <li key={entry.id} className="extensions__result">
                  <ExtensionIcon iconUrl={entry.iconUrl} />
                  <div className="extensions__details">
                    <p className="extensions__name">
                      {entry.displayName}
                      <span className="extensions__badge">Catalog only</span>
                    </p>
                    <p className="extensions__publisher">
                      {entry.publisher}
                      {entry.verified && <span className="extensions__verified"> · verified</span>}
                    </p>
                    <p className="extensions__description">{entry.description}</p>
                    <p className="extensions__meta">
                      {entry.version} · {formatDownloads(entry.downloadCount)} downloads
                      {entry.rating !== null && ` · ★ ${entry.rating.toFixed(1)}`}
                    </p>
                    <div className="extensions__actions">{renderInstallAction(entry)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="extensions__footnote">Installed packages stay inert — nothing runs yet.</p>
          <p className="extensions__group-name">Built-in</p>
          <ul className="extensions__list">
            {BUILT_IN.map((name) => (
              <li key={name} className="extensions__scope extensions__scope--builtin">
                {name}
              </li>
            ))}
          </ul>
          <p className="extensions__group-name">Extension Host</p>
          <p className="extensions__body">Developer foundation preview. Installed extensions cannot run yet.</p>
          <div className="extensions__host-row">
            <span className="extensions__host-status" role="status">
              Status: {hostState}
            </span>
            {hostState === 'ready' ? (
              <button
                className="extensions__secondary"
                type="button"
                onClick={handleStopHost}
                disabled={hostBusy}
                aria-label="Stop Extension Host"
              >
                {hostBusy ? 'Stopping…' : 'Stop host'}
              </button>
            ) : (
              <button
                className="extensions__secondary"
                type="button"
                onClick={handleStartHost}
                disabled={hostBusy}
                aria-label="Start Extension Host"
              >
                {hostBusy ? 'Starting…' : 'Start host'}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="extensions__group-name">Installed</p>
          <p className="extensions__note">Extension activation support is still in development.</p>
          {installedItems.length === 0 ? (
            <p className="extensions__status" role="status">
              No extensions installed yet. Find them in the Marketplace view.
            </p>
          ) : (
            <ul className="extensions__list" aria-label="Installed extensions">
              {installedItems.map((item) => renderInstalledRow(item))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
