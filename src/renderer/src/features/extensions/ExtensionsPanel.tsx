import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react'
import type { ExtensionEntry, InstalledExtensionEntry } from '../../../../shared/extension-registry/types'
import type { ExtensionDetails, ExtensionEditProposal } from '../../../../shared/extension-management/types'
import {
  acknowledgeAndActivateExtension,
  checkExtensionUpdate,
  dismissExtensionProposal,
  fireExtensionTrigger,
  getExtensionConfig,
  getExtensionDetails,
  getExtensionAutoUpdate,
  getSelectedExtensionThemes,
  installExtension,
  listActiveExtensions,
  listExtensionEditProposals,
  listFeaturedExtensions,
  listInstalledExtensions,
  searchExtensionCatalog,
  setExtensionAutoUpdate,
  setExtensionEnabled,
  setExtensionTrust,
  getExtensionHostStatus,
  getExtensionOutput,
  getExtensionStatusItems,
  listExtensionOutputChannels,
  setSelectedExtensionTheme,
  uninstallExtension,
  updateExtensionConfig
} from '../../lib/stark-api'
import { getWorkspaceFilesApi } from '../../lib/stark-api'
import { createFileChange } from '../../lib/changes-api'
import type { ExtensionHostState } from '../../../../shared/extension-host/types'
import { StarkIcon } from '../../components/icons/StarkIcon'
import { requestExtensionTrust } from './extension-trust-bus'
import { notifyEditorThemeChanged } from './extension-language-bridge'
import { applyProposalEdits, groupProposalEditsByUri, relativePathFromProposalUri } from './extension-proposals'
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

function CompatBadge({ level }: { readonly level: 'compatible' | 'partial' | 'unsupported' | 'unknown' }): ReactElement {
  if (level === 'unknown') {
    return <span className="extensions__badge">Compatibility unknown until installed</span>
  }
  const label = level === 'compatible' ? 'Compatible' : level === 'partial' ? 'Partially compatible' : 'Unsupported'
  return <span className={`extensions__badge--${level}`}>{label}</span>
}

type ExtensionsView = 'marketplace' | 'installed'

export interface ExtensionsPanelProps {
  readonly workspaceId: number
  readonly rootPath: string
}

interface ProposalAcceptState {
  readonly status: 'accepting' | 'failed'
  readonly message: string
}

/**
 * Extension catalog browser with safe installation plus the
 * demand-driven management surface (Steps 8+9).
 *
 * The panel never touches the registry or the filesystem: keystrokes
 * debounce 300ms into the main-owned catalog bridge (fixed Open VSX
 * origin, 10s timeout, zero retries, max 20 results), with stale
 * responses discarded by monotonic request ids. Install buttons send
 * normalized identity only; download, validation, extraction, and
 * storage are main-owned and bounded, and installed packages run
 * only on demand inside the isolated host — nothing runs at startup.
 * Extension edits surface as review proposals (human Accept/Reject);
 * the panel turns Accept into change transactions through the
 * existing review pipeline. All registry text renders as plain React
 * text. The Installed view is local disk state only and works fully
 * offline.
 */
export function ExtensionsPanel({ workspaceId, rootPath }: ExtensionsPanelProps): ReactElement {
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
  /**
   * Main-known active ids (Loaded vs Not loaded). Enabled means
   * allowed, never running — this set proves actual execution.
   * Refreshed on view changes and state mutations only (no polling).
   */
  const [activeIds, setActiveIds] = useState<readonly string[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null)
  const [detailsCache, setDetailsCache] = useState<Readonly<Record<string, ExtensionDetails>>>({})
  const [detailsLoading, setDetailsLoading] = useState<readonly string[]>([])
  const [updateCache, setUpdateCache] = useState<Readonly<Record<string, { updateAvailable: boolean; latestVersion: string | null }>>>({})
  const [updatingKeys, setUpdatingKeys] = useState<readonly string[]>([])
  const [autoUpdate, setAutoUpdate] = useState(false)
  const [massConfirm, setMassConfirm] = useState<'disable' | 'enable' | null>(null)
  const [massBusy, setMassBusy] = useState(false)
  const [proposals, setProposals] = useState<readonly ExtensionEditProposal[]>([])
  const [proposalStates, setProposalStates] = useState<Readonly<Record<string, ProposalAcceptState>>>({})
  const [statusItems, setStatusItems] = useState<readonly { itemId: number; owner: string; text: string; command?: string }[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [configCache, setConfigCache] = useState<Readonly<Record<string, Record<string, string | number | boolean | null | readonly string[]>>>>({})
  const [outputCache, setOutputCache] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [outputChannels, setOutputChannels] = useState<readonly string[]>([])
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [runBusyKeys, setRunBusyKeys] = useState<readonly string[]>([])
  const [themeChoices, setThemeChoices] = useState<readonly { extensionId: string; themeId: string; label: string; displayName: string }[]>([])
  const [selectedEditorTheme, setSelectedEditorTheme] = useState<string | null>(null)
  const checkedUpdatesRef = useRef<Set<string>>(new Set())

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

  function refreshActive(): void {
    listActiveExtensions().then(
      (ids) => setActiveIds(ids),
      () => {
        // Keep the last known active set on refresh failure.
      }
    )
  }

  function refreshProposals(): void {
    listExtensionEditProposals().then(
      (result) => setProposals(result),
      () => {}
    )
  }

  function refreshStatusItems(): void {
    getExtensionStatusItems().then(
      (items) => setStatusItems(items.map((item) => ({ itemId: item.itemId, owner: item.owner, text: item.text, command: item.command }))),
      () => {}
    )
  }

  useEffect(() => {
    refreshHostStatus()
    refreshActive()
    getExtensionAutoUpdate().then(
      (enabled) => setAutoUpdate(enabled),
      () => {}
    )
  }, [])

  useEffect(() => {
    if (view === 'installed') {
      refreshActive()
      refreshProposals()
      refreshStatusItems()
      listExtensionOutputChannels().then(
        (channels) => setOutputChannels(channels),
        () => {}
      )
      getSelectedExtensionThemes().then(
        (selected) => setSelectedEditorTheme(selected.editor === null ? null : `${selected.editor.extensionId}#${selected.editor.themeId}`),
        () => {}
      )
    }
  }, [view])

  // Session-once update checks (manual by default; staged when the
  // opt-in auto-update preference is on). Offline failures resolve
  // to no update — never errors, never retries.
  useEffect(() => {
    if (view !== 'installed') {
      return
    }
    for (const item of Object.values(installedByKey)) {
      const key = installedKeyOf(item.namespace, item.name, item.version)
      if (checkedUpdatesRef.current.has(key)) {
        continue
      }
      checkedUpdatesRef.current.add(key)
      checkExtensionUpdate({ namespace: item.namespace, name: item.name, version: item.version }).then(
        (result) => {
          setUpdateCache((cache) => ({ ...cache, [key]: result }))
          const latestVersion: string | null = result.latestVersion
          if (result.updateAvailable && latestVersion !== null && autoUpdate) {
            // Opt-in staging: install the new version alongside the
            // old one (never activated — trust is version-pinned),
            // then leave it disabled for explicit user review.
            installExtension({ namespace: item.namespace, name: item.name, version: latestVersion }).then(
              (staged) => {
                setExtensionEnabled(
                  { namespace: staged.namespace, name: staged.name, version: staged.version },
                  false
                ).then(
                  () => {
                    refreshInstalled()
                    setNotice(`Update staged for ${item.displayName} ${latestVersion}: enable it in Installed when ready.`)
                  },
                  () => {}
                )
              },
              () => {}
            )
          }
        },
        () => {}
      )
    }
  }, [view, installedByKey, autoUpdate])

  function loadDetails(item: InstalledExtensionEntry): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    if (detailsCache[key] !== undefined || detailsLoading.includes(key)) {
      return
    }
    setDetailsLoading((keys) => [...keys, key])
    getExtensionDetails({ namespace: item.namespace, name: item.name, version: item.version }).then(
      (details) => {
        setDetailsLoading((keys) => keys.filter((other) => other !== key))
        setDetailsCache((cache) => ({ ...cache, [key]: details }))
        if (details.themes.length > 0) {
          setThemeChoices((choices) => {
            const next = choices.filter((choice) => choice.extensionId !== key)
            for (const theme of details.themes) {
              next.push({ extensionId: key, themeId: theme.id, label: theme.label, displayName: details.displayName })
            }
            return next
          })
        }
      },
      () => {
        setDetailsLoading((keys) => keys.filter((other) => other !== key))
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
      const loaded = activeIds.includes(installKey(entry))
      return (
        <span className="extensions__installed-state">
          <button className="extensions__installed" type="button" disabled aria-label={`${entry.displayName} installed`}>
            Installed
          </button>
          <span className="extensions__state-label">
            {installed.enabled ? (loaded ? ' · Enabled · Loaded' : ' · Enabled') : ' · Disabled'}
          </span>
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
        refreshActive()
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
        refreshActive()
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

  function handleRun(item: InstalledExtensionEntry): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    if (runBusyKeys.includes(key)) {
      return
    }
    const details = detailsCache[key]
    if (details !== undefined && !details.trusted) {
      requestExtensionTrust({ namespace: item.namespace, name: item.name, version: item.version, displayName: item.displayName })
      return
    }
    setRunBusyKeys((keys) => [...keys, key])
    acknowledgeAndActivateExtension({ namespace: item.namespace, name: item.name, version: item.version }).then(
      () => {
        setRunBusyKeys((keys) => keys.filter((other) => other !== key))
        refreshActive()
        refreshHostStatus()
      },
      (error: unknown) => {
        setRunBusyKeys((keys) => keys.filter((other) => other !== key))
        if (error instanceof Error && error.message.includes('permission')) {
          requestExtensionTrust({ namespace: item.namespace, name: item.name, version: item.version, displayName: item.displayName })
          return
        }
        setDetailsCache((cache) => {
          const existing = cache[key]
          if (existing === undefined) {
            return cache
          }
          return { ...cache, [key]: { ...existing, failure: 'activation-failed' } }
        })
      }
    )
  }

  function handleRetryFailed(item: InstalledExtensionEntry): void {
    handleRun(item)
  }

  function handleToggleTrust(item: InstalledExtensionEntry, trusted: boolean): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    setExtensionTrust({ namespace: item.namespace, name: item.name, version: item.version }, trusted).then(
      () => {
        setDetailsCache((cache) => {
          const existing = cache[key]
          if (existing === undefined) {
            return cache
          }
          return { ...cache, [key]: { ...existing, trusted } }
        })
      },
      () => {
        setNotice('We couldn’t update trust for that extension.')
      }
    )
  }

  function handleUpdate(item: InstalledExtensionEntry): void {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    const pending = updateCache[key]
    if (pending === undefined || !pending.updateAvailable || pending.latestVersion === null || updatingKeys.includes(key)) {
      return
    }
    const latestVersion: string = pending.latestVersion
    setUpdatingKeys((keys) => [...keys, key])
    // Manual update: the new version installs alongside the old one
    // through the existing safe installer; only an explicit user
    // uninstall removes the old version (never in-place overwrite).
    installExtension({ namespace: item.namespace, name: item.name, version: latestVersion }).then(
      () => {
        setUpdatingKeys((keys) => keys.filter((other) => other !== key))
        checkedUpdatesRef.current.delete(installedKeyOf(item.namespace, item.name, latestVersion))
        refreshInstalled()
        setNotice(`Updated ${item.displayName} to ${latestVersion}. Uninstall the old version when ready.`)
      },
      () => {
        setUpdatingKeys((keys) => keys.filter((other) => other !== key))
        setNotice(`We couldn’t update ${item.displayName}.`)
      }
    )
  }

  function handleMassToggle(enabled: boolean): void {
    if (massBusy) {
      return
    }
    setMassBusy(true)
    setMassConfirm(null)
    const items = Object.values(installedByKey).filter((item) => item.enabled !== enabled)
    void (async () => {
      for (const item of items.slice(0, 512)) {
        try {
          await setExtensionEnabled({ namespace: item.namespace, name: item.name, version: item.version }, enabled)
        } catch {
          // Best effort per extension; failures surface per row.
        }
      }
      setMassBusy(false)
      refreshInstalled()
      refreshActive()
    })()
  }

  function handleEvaluateWorkspace(): void {
    fireExtensionTrigger({ kind: 'workspace' }).then(
      (outcome) => {
        refreshActive()
        for (const id of outcome.needsTrust) {
          const at = id.lastIndexOf('@')
          const head = id.slice(0, at)
          const dot = head.indexOf('.')
          const installed = installedByKey[id]
          requestExtensionTrust({
            namespace: head.slice(0, dot),
            name: head.slice(dot + 1),
            version: id.slice(at + 1),
            displayName: installed?.displayName ?? head
          })
        }
        if (outcome.activated.length > 0 || outcome.needsTrust.length > 0) {
          setNotice(`Workspace check: ${outcome.activated.length} activated, ${outcome.needsTrust.length} need permission.`)
        }
      },
      () => {}
    )
  }

  function handleAcceptProposal(proposalId: string, owner: string, edits: ExtensionEditProposal['edits']): void {
    if (proposalStates[proposalId]?.status === 'accepting') {
      return
    }
    setProposalStates((states) => ({ ...states, [proposalId]: { status: 'accepting', message: 'Creating review…' } }))
    void (async () => {
      try {
        const groups = groupProposalEditsByUri(edits)
        const filesApi = getWorkspaceFilesApi()
        if (filesApi === undefined) {
          throw new Error('Workspace files are unavailable.')
        }
        let created = 0
        for (const group of groups) {
          const relativePath = relativePathFromProposalUri(group.uri, rootPath)
          if (relativePath === null) {
            throw new Error(`That edit is outside the workspace (${group.uri.slice(0, 80)}).`)
          }
          const file = await filesApi.readTextFile(workspaceId, relativePath)
          const proposedContent = applyProposalEdits(file.content, group.edits)
          await createFileChange({ workspaceId, relativePath, expectedRevision: file.revision, proposedContent })
          created += 1
        }
        await dismissExtensionProposal(proposalId)
        setProposalStates((states) => {
          const next = { ...states }
          delete next[proposalId]
          return next
        })
        refreshProposals()
        setNotice(`Proposal from ${owner} is ready for review (${created} file${created === 1 ? '' : 's'}). Accept it in Changes.`)
      } catch (error: unknown) {
        setProposalStates((states) => ({
          ...states,
          [proposalId]: { status: 'failed', message: error instanceof Error ? error.message : 'Couldn’t create the review.' }
        }))
      }
    })()
  }

  function handleDismissProposal(proposalId: string): void {
    dismissExtensionProposal(proposalId).then(
      () => refreshProposals(),
      () => {}
    )
  }

  function loadConfig(extensionId: string): void {
    if (configCache[extensionId] !== undefined) {
      return
    }
    getExtensionConfig(extensionId).then(
      (values) => setConfigCache((cache) => ({ ...cache, [extensionId]: values })),
      () => {}
    )
  }

  function handleConfigChange(extensionId: string, key: string, value: string | number | boolean | null): void {
    updateExtensionConfig(extensionId, key, value).then(
      () => {
        setConfigCache((cache) => ({ ...cache, [extensionId]: { ...(cache[extensionId] ?? {}), [key]: value } }))
      },
      () => {
        setNotice('We couldn’t save that setting.')
      }
    )
  }

  function loadOutput(channel: string): void {
    getExtensionOutput(channel).then(
      (lines) => {
        setOutputCache((cache) => ({ ...cache, [channel]: lines }))
        setSelectedChannel(channel)
      },
      () => {}
    )
  }

  function renderCompatibility(details: ExtensionDetails | undefined, key: string): ReactElement {
    if (details === undefined) {
      if (detailsLoading.includes(key)) {
        return <span className="extensions__state-label">Checking compatibility…</span>
      }
      return <CompatBadge level="unknown" />
    }
    return (
      <span>
        <CompatBadge level={details.compatibility} />
        {details.reasons.length > 0 && (
          <ul className="extensions__reasons">
            {details.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </span>
    )
  }

  function renderInstalledRow(item: InstalledExtensionEntry): ReactElement {
    const key = installedKeyOf(item.namespace, item.name, item.version)
    const loaded = activeIds.includes(key)
    const details = detailsCache[key]
    const update = updateCache[key]
    return (
      <li key={key} className="extensions__installed-row">
        <ExtensionIcon iconUrl={item.iconUrl} />
        <span className="extensions__installed-details">
          <span className="extensions__installed-name">{item.displayName}</span>
          <span className="extensions__installed-meta">
            {item.namespace} · {item.version}
          </span>
          <span className="extensions__state-label">
            {details?.failure !== undefined && details?.failure !== null
              ? 'Failed'
              : item.enabled
                ? loaded
                  ? 'Enabled · Loaded'
                  : 'Enabled · Not loaded'
                : 'Disabled'}
          </span>
          {renderCompatibility(details, key)}
          {update?.updateAvailable === true && update.latestVersion !== null && (
            <span className="extensions__state-label">Update available: {update.latestVersion}</span>
          )}
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
            <button
              className="extensions__secondary"
              type="button"
              onClick={() => {
                setSelectedKey(selectedKey === key ? null : key)
                setSelectedCatalogId(null)
                loadDetails(item)
              }}
              aria-label={`Details for ${item.displayName}`}
            >
              {selectedKey === key ? 'Hide details' : 'Details'}
            </button>
            {details?.failure !== undefined && details?.failure !== null ? (
              <button
                className="extensions__secondary"
                type="button"
                disabled={runBusyKeys.includes(key)}
                onClick={() => handleRetryFailed(item)}
                aria-label={`Retry activation of ${item.displayName}`}
              >
                {runBusyKeys.includes(key) ? 'Retrying…' : 'Retry activation'}
              </button>
            ) : (
              <button
                className="extensions__secondary"
                type="button"
                disabled={runBusyKeys.includes(key)}
                onClick={() => handleRun(item)}
                aria-label={`Run ${item.displayName}`}
              >
                {runBusyKeys.includes(key) ? 'Running…' : 'Run'}
              </button>
            )}
            {renderStateAction(item)}
            {update?.updateAvailable === true && update.latestVersion !== null && (
              <button
                className="extensions__secondary"
                type="button"
                disabled={updatingKeys.includes(key)}
                onClick={() => handleUpdate(item)}
                aria-label={`Update ${item.displayName} to ${update.latestVersion}`}
              >
                {updatingKeys.includes(key) ? 'Updating…' : `Update to ${update.latestVersion}`}
              </button>
            )}
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
        {selectedKey === key && (
          <div className="extensions__detail">
            {details === undefined ? (
              <p className="extensions__detail-meta">Loading details…</p>
            ) : (
              <>
                <p className="extensions__detail-title">{details.displayName}</p>
                <p className="extensions__detail-meta">
                  {details.namespace} · {details.version} · {details.trusted ? 'Trusted' : 'Not trusted'}
                  {details.active ? ' · Active now' : ''}
                </p>
                {details.capabilities.length > 0 && (
                  <p className="extensions__detail-meta">Capabilities: {details.capabilities.join(' · ')}</p>
                )}
                <button
                  className="extensions__secondary"
                  type="button"
                  onClick={() => handleToggleTrust(item, !details.trusted)}
                  aria-label={`${details.trusted ? 'Remove trust from' : 'Trust'} ${details.displayName}`}
                >
                  {details.trusted ? 'Remove trust' : 'Trust this extension'}
                </button>
                {details.failure !== null && (
                  <p className="extensions__detail-meta">
                    Last activation failed ({details.failure}).
                    <button className="extensions__secondary" type="button" onClick={() => handleSetEnabled(item, false)} aria-label={`Disable ${details.displayName}`}>
                      Disable
                    </button>
                  </p>
                )}
                {details.commands.length > 0 && (
                  <>
                    <p className="extensions__detail-meta">Commands:</p>
                    <ul className="extensions__reasons">
                      {details.commands.slice(0, 32).map((command) => (
                        <li key={command.command}>
                          {command.title} ({command.command})
                          {details.keybindings.filter((binding) => binding.command === command.command).map((binding) => ` [${binding.key}]`).join('')}
                        </li>
                      ))}
                    </ul>
                    <p className="extensions__detail-meta">Run commands from the palette (Ctrl+Shift+P).</p>
                  </>
                )}
                {details.languages.length > 0 && (
                  <p className="extensions__detail-meta">Languages: {details.languages.join(', ')}</p>
                )}
                {details.themes.length > 0 && (
                  <p className="extensions__detail-meta">
                    Themes: {details.themes.map((theme) => theme.label).join(', ')}
                  </p>
                )}
                {details.hasConfiguration && (
                  <button
                    className="extensions__secondary"
                    type="button"
                    onClick={() => loadConfig(key)}
                    aria-label={`Settings for ${details.displayName}`}
                  >
                    Settings
                  </button>
                )}
                {configCache[key] !== undefined && (
                  <div>
                    {Object.entries(configCache[key]).map(([configKey, value]) => (
                      <label key={configKey} className="extensions__config-row">
                        {configKey}
                        {typeof value === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={value}
                            onChange={(event) => handleConfigChange(key, configKey, event.target.checked)}
                          />
                        ) : typeof value === 'number' ? (
                          <input
                            type="number"
                            value={value}
                            onChange={(event) => handleConfigChange(key, configKey, Number(event.target.value))}
                          />
                        ) : (
                          <input
                            type="text"
                            value={typeof value === 'string' ? value : ''}
                            onChange={(event) => handleConfigChange(key, configKey, event.target.value)}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                )}
                <button
                  className="extensions__secondary"
                  type="button"
                  onClick={() => loadOutput(`${details.displayName}`)}
                  aria-label={`Output for ${details.displayName}`}
                >
                  View output
                </button>
              </>
            )}
          </div>
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
      {notice !== null && (
        <p className="extensions__status" role="status">
          {notice}
        </p>
      )}
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
                    <button
                      className="extensions__secondary"
                      type="button"
                      onClick={() => setSelectedCatalogId(selectedCatalogId === entry.id ? null : entry.id)}
                      aria-label={`About ${entry.displayName}`}
                    >
                      {selectedCatalogId === entry.id ? 'Hide about' : 'About'}
                    </button>
                    {selectedCatalogId === entry.id && (
                      <div className="extensions__detail">
                        <p className="extensions__detail-meta">
                          {entry.namespace} · {entry.name} · {entry.version}
                        </p>
                        <CompatBadge level="unknown" />
                        <p className="extensions__detail-meta">
                          Install it to evaluate compatibility, commands, and settings.
                        </p>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="extensions__footnote">Installed packages run only on demand — nothing runs at startup.</p>
          <p className="extensions__group-name">Built-in</p>
          <ul className="extensions__list">
            {BUILT_IN.map((name) => (
              <li key={name} className="extensions__scope extensions__scope--builtin">
                {name}
              </li>
            ))}
          </ul>
          <p className="extensions__group-name">Extension Host</p>
          <p className="extensions__body">Extensions run on demand inside the isolated host.</p>
          <div className="extensions__host-row">
            <span className="extensions__host-status" role="status">
              Status: {hostState}
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="extensions__group-name">Installed</p>
          <p className="extensions__note">Extensions activate on demand only — nothing runs at startup.</p>
          <div className="extensions__row-actions">
            <button
              className="extensions__secondary"
              type="button"
              disabled={massBusy || installedItems.length === 0}
              onClick={() => setMassConfirm('disable')}
              aria-label="Disable all extensions"
            >
              Disable all
            </button>
            <button
              className="extensions__secondary"
              type="button"
              disabled={massBusy || installedItems.length === 0}
              onClick={() => setMassConfirm('enable')}
              aria-label="Enable all extensions"
            >
              Enable all
            </button>
            <button
              className="extensions__secondary"
              type="button"
              onClick={handleEvaluateWorkspace}
              aria-label="Check workspace extensions"
            >
              Check workspace
            </button>
            <label className="extensions__config-row">
              <input
                type="checkbox"
                checked={autoUpdate}
                onChange={(event) => {
                  const enabled = event.target.checked
                  setExtensionAutoUpdate(enabled).then(
                    (result) => setAutoUpdate(result),
                    () => {}
                  )
                }}
              />
              Automatically update extensions
            </label>
          </div>
          {massConfirm !== null && (
            <p className="extensions__confirm" role="alert">
              {massConfirm === 'disable' ? 'Disable' : 'Enable'} all {installedItems.length} extensions?
              <span className="extensions__confirm-actions">
                <button className="extensions__secondary" type="button" onClick={() => setMassConfirm(null)}>
                  Cancel
                </button>
                <button
                  className="extensions__secondary"
                  type="button"
                  onClick={() => handleMassToggle(massConfirm === 'enable')}
                  aria-label={`Confirm ${massConfirm} all`}
                >
                  Confirm
                </button>
              </span>
            </p>
          )}
          {themeChoices.length > 0 && (
            <>
              <p className="extensions__group-name">Editor theme</p>
              <select
                className="extensions__input"
                aria-label="Editor theme"
                value={selectedEditorTheme ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  if (value === '') {
                    setSelectedExtensionTheme('editor', null).then(
                      () => {
                        setSelectedEditorTheme(null)
                        notifyEditorThemeChanged()
                      },
                      () => {}
                    )
                    return
                  }
                  const [extensionId, themeId] = value.split('#')
                  if (extensionId !== undefined && themeId !== undefined) {
                    setSelectedExtensionTheme('editor', { extensionId, themeId }).then(
                      (selected) => {
                        setSelectedEditorTheme(selected.editor === null ? null : `${selected.editor.extensionId}#${selected.editor.themeId}`)
                        notifyEditorThemeChanged()
                      },
                      () => {}
                    )
                  }
                }}
              >
                <option value="">STARK default</option>
                {themeChoices.map((choice) => (
                  <option key={`${choice.extensionId}#${choice.themeId}`} value={`${choice.extensionId}#${choice.themeId}`}>
                    {choice.label} ({choice.displayName})
                  </option>
                ))}
              </select>
            </>
          )}
          {statusItems.length > 0 && (
            <>
              <p className="extensions__group-name">Extension status</p>
              <ul className="extensions__list">
                {statusItems.map((item) => (
                  <li key={item.itemId} className="extensions__scope">
                    {item.text}
                  </li>
                ))}
              </ul>
            </>
          )}
          {proposals.length > 0 && (
            <>
              <p className="extensions__group-name">Proposed edits ({proposals.length})</p>
              <p className="extensions__note">Review before anything is written. Accept creates a change transaction.</p>
              {proposals.map((proposal) => (
                <div key={proposal.proposalId} className="extensions__proposal">
                  <p className="extensions__detail-meta">
                    {proposal.owner} · {proposal.edits.length} edit{proposal.edits.length === 1 ? '' : 's'}
                  </p>
                  {proposalStates[proposal.proposalId]?.status === 'failed' && (
                    <p className="extensions__install-failed-copy" role="alert">
                      {proposalStates[proposal.proposalId]?.message}
                    </p>
                  )}
                  <span className="extensions__row-actions">
                    <button
                      className="extensions__secondary"
                      type="button"
                      disabled={proposalStates[proposal.proposalId]?.status === 'accepting'}
                      onClick={() => handleAcceptProposal(proposal.proposalId, proposal.owner, proposal.edits)}
                    >
                      {proposalStates[proposal.proposalId]?.status === 'accepting' ? 'Reviewing…' : 'Accept for review'}
                    </button>
                    <button className="extensions__secondary" type="button" onClick={() => handleDismissProposal(proposal.proposalId)}>
                      Reject
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}
          {outputChannels.length > 0 && (
            <>
              <p className="extensions__group-name">Extension output</p>
              <select
                className="extensions__input"
                aria-label="Extension output channel"
                value={selectedChannel ?? ''}
                onChange={(event) => loadOutput(event.target.value)}
              >
                <option value="">Choose a channel…</option>
                {outputChannels.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
              {selectedChannel !== null && outputCache[selectedChannel] !== undefined && (
                <pre className="extensions__detail-meta">{outputCache[selectedChannel].join('').slice(-4000)}</pre>
              )}
            </>
          )}
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
