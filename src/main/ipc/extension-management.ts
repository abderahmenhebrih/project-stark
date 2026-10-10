import { IPC_CHANNELS } from '../../shared/constants'
import {
  InvalidExtensionActivationRequestError,
  toPublicExtensionActivationError
} from '../extension-host/extension-activation-errors'
import type { ExtensionRuntimeService } from '../extension-host/extension-runtime-service'
import { validatedInstallIdentity } from '../extension-install/extension-install-service'
import type { IpcBinding } from './binding'

function readIdentity(payload: unknown): { namespace: string; name: string; version: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const keys = Object.keys(payload)
  if (keys.length !== 3 || !keys.includes('namespace') || !keys.includes('name') || !keys.includes('version')) {
    throw new InvalidExtensionActivationRequestError()
  }
  return validatedInstallIdentity(payload)
}

function readTrustRequest(payload: unknown): { namespace: string; name: string; version: string; trusted: boolean } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4 || !keys.includes('namespace') || !keys.includes('name') || !keys.includes('version') || !keys.includes('trusted')) {
    throw new InvalidExtensionActivationRequestError()
  }
  const identity = validatedInstallIdentity({ namespace: record['namespace'], name: record['name'], version: record['version'] })
  if (typeof record['trusted'] !== 'boolean') {
    throw new InvalidExtensionActivationRequestError()
  }
  return { ...identity, trusted: record['trusted'] }
}

function readTrigger(payload: unknown): {
  kind: 'language' | 'command' | 'workspace' | 'startup' | 'manual'
  value?: string
  rootEntries?: readonly string[]
  identity?: { namespace: string; name: string; version: string }
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'language' && kind !== 'command' && kind !== 'workspace' && kind !== 'startup' && kind !== 'manual') {
    throw new InvalidExtensionActivationRequestError()
  }
  const out: {
    kind: 'language' | 'command' | 'workspace' | 'startup' | 'manual'
    value?: string
    rootEntries?: readonly string[]
    identity?: { namespace: string; name: string; version: string }
  } = { kind }
  if (record['value'] !== undefined) {
    if (typeof record['value'] !== 'string' || record['value'] === '' || record['value'].length > 128) {
      throw new InvalidExtensionActivationRequestError()
    }
    out.value = record['value']
  }
  if (record['rootEntries'] !== undefined) {
    if (!Array.isArray(record['rootEntries'])) {
      throw new InvalidExtensionActivationRequestError()
    }
    const entries = record['rootEntries'].slice(0, 1024).filter((entry): entry is string => typeof entry === 'string' && entry !== '' && entry.length <= 256)
    out.rootEntries = entries
  }
  if (record['identity'] !== undefined) {
    out.identity = readIdentity(record['identity'])
  }
  return out
}

function readInvokeCommand(payload: unknown): { command: string; args: readonly unknown[] } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (typeof record['command'] !== 'string' || record['command'] === '' || record['command'].length > 128) {
    throw new InvalidExtensionActivationRequestError()
  }
  const args = record['args'] === undefined ? [] : record['args']
  if (!Array.isArray(args) || args.length > 8) {
    throw new InvalidExtensionActivationRequestError()
  }
  return { command: record['command'], args }
}

function readProviderQuery(payload: unknown): {
  kind: string
  filePath: string
  languageId: string
  text: string
  position?: { line: number; character: number }
  endPosition?: { line: number; character: number }
  query?: string
  newName?: string
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (typeof record['kind'] !== 'string' || typeof record['filePath'] !== 'string' || typeof record['languageId'] !== 'string' || typeof record['text'] !== 'string') {
    throw new InvalidExtensionActivationRequestError()
  }
  if (record['filePath'] === '' || record['filePath'].length > 4096 || record['languageId'] === '' || record['languageId'].length > 64) {
    throw new InvalidExtensionActivationRequestError()
  }
  if (Buffer.byteLength(record['text'], 'utf8') > 1024 * 1024) {
    throw new InvalidExtensionActivationRequestError()
  }
  return {
    kind: record['kind'],
    filePath: record['filePath'],
    languageId: record['languageId'],
    text: record['text'],
    position: readPosition(record['position']),
    endPosition: readPosition(record['endPosition']),
    query: typeof record['query'] === 'string' ? record['query'].slice(0, 128) : undefined,
    newName: typeof record['newName'] === 'string' ? record['newName'].slice(0, 256) : undefined
  }
}

function readPosition(value: unknown): { line: number; character: number } | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = value as Record<string, unknown>
  if (typeof record['line'] !== 'number' || typeof record['character'] !== 'number') {
    throw new InvalidExtensionActivationRequestError()
  }
  return { line: Math.max(0, Math.floor(record['line'])), character: Math.max(0, Math.floor(record['character'])) }
}

function readExtensionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record['extensionId'] !== 'string' || record['extensionId'] === '' || record['extensionId'].length > 321) {
    throw new InvalidExtensionActivationRequestError()
  }
  return record['extensionId']
}

function readConfigUpdate(payload: unknown): { extensionId: string; key: string; value: string | number | boolean | null } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (typeof record['extensionId'] !== 'string' || typeof record['key'] !== 'string') {
    throw new InvalidExtensionActivationRequestError()
  }
  const value = record['value']
  if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new InvalidExtensionActivationRequestError()
  }
  return { extensionId: record['extensionId'], key: record['key'], value: value as string | number | boolean | null }
}

function readPromptResolution(payload: unknown): { promptId: string; selected?: unknown; value?: string; cancelled?: boolean } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (typeof record['promptId'] !== 'string' || record['promptId'] === '') {
    throw new InvalidExtensionActivationRequestError()
  }
  return {
    promptId: record['promptId'],
    selected: record['selected'],
    value: typeof record['value'] === 'string' ? record['value'].slice(0, 2048) : undefined,
    cancelled: record['cancelled'] === true
  }
}

function readDocumentEvent(payload: unknown): { kind: 'opened' | 'changed' | 'closed'; uri: string; languageId?: string; text?: string; version?: number } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (record['kind'] !== 'opened' && record['kind'] !== 'changed' && record['kind'] !== 'closed') {
    throw new InvalidExtensionActivationRequestError()
  }
  if (typeof record['uri'] !== 'string' || record['uri'] === '' || record['uri'].length > 4096) {
    throw new InvalidExtensionActivationRequestError()
  }
  const text = record['text']
  if (text !== undefined && (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024)) {
    throw new InvalidExtensionActivationRequestError()
  }
  return {
    kind: record['kind'],
    uri: record['uri'],
    languageId: typeof record['languageId'] === 'string' ? record['languageId'].slice(0, 64) : undefined,
    text: typeof text === 'string' ? text : undefined,
    version: typeof record['version'] === 'number' && Number.isInteger(record['version']) ? record['version'] : undefined
  }
}

function readWorkspaceFolders(payload: unknown): { uri: string; name: string }[] | null {
  if (payload === null) {
    return null
  }
  if (!Array.isArray(payload)) {
    throw new InvalidExtensionActivationRequestError()
  }
  const out: { uri: string; name: string }[] = []
  for (const entry of payload.slice(0, 8)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InvalidExtensionActivationRequestError()
    }
    const record = entry as Record<string, unknown>
    if (typeof record['uri'] !== 'string' || record['uri'] === '' || record['uri'].length > 4096) {
      throw new InvalidExtensionActivationRequestError()
    }
    out.push({
      uri: record['uri'],
      name: typeof record['name'] === 'string' ? record['name'].slice(0, 128) : ''
    })
  }
  return out
}

function readActiveEditor(payload: unknown): { uri: string; languageId: string } | null {  if (payload === null) {
    return null
  }
  if (typeof payload !== 'object') {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (typeof record['uri'] !== 'string' || typeof record['languageId'] !== 'string') {
    throw new InvalidExtensionActivationRequestError()
  }
  return { uri: record['uri'].slice(0, 4096), languageId: record['languageId'].slice(0, 64) }
}

function requireEmpty(payload: unknown): void {
  if (payload === undefined) {
    return
  }
  if (typeof payload === 'object' && payload !== null && Object.keys(payload).length === 0) {
    return
  }
  throw new InvalidExtensionActivationRequestError()
}

function readChannel(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record['channel'] !== 'string' || record['channel'] === '') {
    throw new InvalidExtensionActivationRequestError()
  }
  return record['channel'].slice(0, 128)
}

function readUri(payload: unknown): string | undefined {
  if (payload === undefined) {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record['uri'] !== 'string') {
    throw new InvalidExtensionActivationRequestError()
  }
  return record['uri'].slice(0, 4096)
}

function readProposalId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record['proposalId'] !== 'string' || record['proposalId'] === '') {
    throw new InvalidExtensionActivationRequestError()
  }
  return record['proposalId']
}

function readAutoUpdate(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record['enabled'] !== 'boolean') {
    throw new InvalidExtensionActivationRequestError()
  }
  return record['enabled']
}

function readThemeRef(payload: unknown): { namespace: string; name: string; version: string; themeId: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4 || !keys.includes('namespace') || !keys.includes('name') || !keys.includes('version') || !keys.includes('themeId')) {
    throw new InvalidExtensionActivationRequestError()
  }
  const identity = validatedInstallIdentity({ namespace: record['namespace'], name: record['name'], version: record['version'] })
  if (typeof record['themeId'] !== 'string' || record['themeId'] === '' || record['themeId'].length > 256) {
    throw new InvalidExtensionActivationRequestError()
  }
  return { ...identity, themeId: record['themeId'] }
}

function readSelectedTheme(payload: unknown): { kind: 'editor' | 'icon'; ref: { extensionId: string; themeId: string } | null } {
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (record['kind'] !== 'editor' && record['kind'] !== 'icon') {
    throw new InvalidExtensionActivationRequestError()
  }
  const ref = record['ref']
  if (ref === null) {
    return { kind: record['kind'], ref: null }
  }
  if (typeof ref !== 'object' || Array.isArray(ref)) {
    throw new InvalidExtensionActivationRequestError()
  }
  const refRecord = ref as Record<string, unknown>
  if (typeof refRecord['extensionId'] !== 'string' || typeof refRecord['themeId'] !== 'string' || refRecord['extensionId'] === '' || refRecord['themeId'] === '') {
    throw new InvalidExtensionActivationRequestError()
  }
  return {
    kind: record['kind'],
    ref: { extensionId: refRecord['extensionId'].slice(0, 321), themeId: refRecord['themeId'].slice(0, 256) }
  }
}

function readLanguageFilter(payload: unknown): string | undefined {
  if (payload === undefined) {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new InvalidExtensionActivationRequestError()
  }
  const record = payload as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record['languageId'] !== 'string') {
    throw new InvalidExtensionActivationRequestError()
  }
  return record['languageId'].slice(0, 64)
}

/**
 * Extension-management IPC bindings (Steps 8+9): narrow invoke
 * channels for details, trust, triggers, palette, providers,
 * diagnostics, output, status items, proposals, config, updates,
 * prompts, and document sync. Every payload is shape-validated here;
 * the runtime service re-validates. No generic spawn, send, exec, or
 * write surface — edit proposals are cached for human review, never
 * applied. Registration through handleSecureIpc happens in ./index.ts.
 */
export function createExtensionManagementBindings(runtime: ExtensionRuntimeService): readonly IpcBinding[] {
  return [
    {
      channel: IPC_CHANNELS.extensionsGetDetails,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) => runtime.getDetails(identity))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsSetTrust,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readTrustRequest(payload))
          .then((request) => runtime.setTrusted({ namespace: request.namespace, name: request.name, version: request.version }, request.trusted))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsAcknowledgeAndActivate,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) => runtime.activateExtension(identity, { acknowledged: true }))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsFireTrigger,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readTrigger(payload))
          .then((trigger) => runtime.fireTrigger(trigger))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListCommands,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listCommands())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsInvokeCommand,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readInvokeCommand(payload))
          .then((request) => runtime.invokeCommand(request.command, request.args))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsQueryProviders,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readProviderQuery(payload))
          .then((query) => runtime.queryProviders(query))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetDiagnostics,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readUri(payload))
          .then((uri) => runtime.listDiagnostics(uri))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetOutput,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readChannel(payload))
          .then((channel) => runtime.getOutput(channel))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListOutputChannels,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listOutputChannels())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetStatusItems,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listStatusItems())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListNotifications,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listNotifications())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListEditProposals,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listEditProposals())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsDismissProposal,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readProposalId(payload))
          .then((proposalId) => runtime.dismissProposal(proposalId))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetConfig,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readExtensionId(payload))
          .then((extensionId) => runtime.getConfig(extensionId))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsUpdateConfig,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readConfigUpdate(payload))
          .then((request) => runtime.updateConfig(request.extensionId, request.key, request.value))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsCheckUpdate,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readIdentity(payload))
          .then((identity) => runtime.checkUpdate(identity))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetAutoUpdate,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.getAutoUpdate())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsSetAutoUpdate,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readAutoUpdate(payload))
          .then((enabled) => runtime.setAutoUpdate(enabled))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListPrompts,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listPrompts())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsResolvePrompt,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readPromptResolution(payload))
          .then((resolution) => runtime.resolvePrompt(resolution.promptId, resolution))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsPushDocumentEvent,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readDocumentEvent(payload))
          .then((event) => runtime.pushDocumentEvent(event))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsSetActiveEditor,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readActiveEditor(payload))
          .then((editor) => runtime.setActiveEditor(editor))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsSetWorkspaceFolders,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readWorkspaceFolders(payload))
          .then((folders) => runtime.pushWorkspaceFolders(folders))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsListLanguages,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.listLanguages())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetSnippets,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readLanguageFilter(payload))
          .then((languageId) => runtime.getSnippets(languageId))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetThemeData,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readThemeRef(payload))
          .then((request) => runtime.getThemeData({ namespace: request.namespace, name: request.name, version: request.version }, request.themeId))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetIconTheme,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readThemeRef(payload))
          .then((request) => runtime.getIconTheme({ namespace: request.namespace, name: request.name, version: request.version }, request.themeId))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsGetSelectedThemes,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => {
            requireEmpty(payload)
          })
          .then(() => runtime.getSelectedThemes())
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    },
    {
      channel: IPC_CHANNELS.extensionsSetSelectedTheme,
      invoke: (payload): Promise<unknown> =>
        Promise.resolve()
          .then(() => readSelectedTheme(payload))
          .then((request) => runtime.setSelectedTheme(request.kind, request.ref))
          .catch((error: unknown) => {
            throw toPublicExtensionActivationError(error)
          })
    }
  ]
}
