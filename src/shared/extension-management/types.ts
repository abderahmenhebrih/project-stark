/**
 * Shared extension-management domain contracts (Steps 8+9).
 *
 * ONE canonical contract for the renderer, preload, and main process.
 * Plain TypeScript only — no Node.js or DOM APIs.
 *
 * The renderer supplies normalized identities, bounded trigger
 * descriptors, and prompt resolutions only — never filesystem paths,
 * never manifest authority, never code. Main verifies installed +
 * enabled (+ trusted where execution is required), then acts inside
 * the isolated host with bounded timeouts. Review-before-write holds:
 * extension edits surface as proposals for human Accept/Reject, never
 * silent disk mutation.
 */

/** Compatibility badge levels (no percentages, ever). */
export type ExtensionCompatibility = 'compatible' | 'partial' | 'unsupported'

/** Narrow identity for one exact installed version (never a path). */
export interface ExtensionIdentity {
  readonly namespace: string
  readonly name: string
  readonly version: string
}

/** Renderer-safe extension detail surface (no paths, no raw manifest). */
export interface ExtensionDetails {
  readonly namespace: string
  readonly name: string
  readonly version: string
  readonly displayName: string
  readonly enabled: boolean
  readonly active: boolean
  readonly trusted: boolean
  readonly compatibility: ExtensionCompatibility
  readonly reasons: readonly string[]
  readonly commands: readonly { readonly command: string; readonly title: string; readonly category: string | null }[]
  readonly keybindings: readonly { readonly command: string; readonly key: string }[]
  readonly languages: readonly string[]
  readonly themes: readonly { readonly id: string; readonly label: string }[]
  readonly hasConfiguration: boolean
  readonly capabilities: readonly string[]
  readonly failure: string | null
  readonly updateAvailable: boolean
  readonly latestVersion: string | null
}

/** Demand-driven trigger descriptor (renderer supplies facts only). */
export interface ExtensionTrigger {
  readonly kind: 'language' | 'command' | 'workspace' | 'startup' | 'manual'
  readonly value?: string
  readonly rootEntries?: readonly string[]
  readonly identity?: ExtensionIdentity
}

/** Trigger outcome: activated ids + ids needing explicit trust. */
export interface ExtensionTriggerOutcome {
  readonly activated: readonly string[]
  readonly needsTrust: readonly string[]
}

/** One contributed command (palette source). */
export interface ExtensionCommand {
  readonly command: string
  readonly title: string
  readonly category: string | null
  readonly extensionId: string
}

/** Language-feature query kinds. */
export type ExtensionProviderKind =
  | 'completion'
  | 'hover'
  | 'definition'
  | 'references'
  | 'documentSymbols'
  | 'workspaceSymbols'
  | 'rename'
  | 'signatureHelp'
  | 'codeAction'
  | 'rangeFormat'
  | 'codeLens'
  | 'documentLink'
  | 'documentHighlight'
  | 'foldingRange'
  | 'selectionRange'
  | 'inlayHint'
  | 'documentColor'

/** Bounded provider query (snapshot text travels inline). */
export interface ExtensionProviderQuery {
  readonly kind: ExtensionProviderKind
  readonly filePath: string
  readonly languageId: string
  readonly text: string
  readonly position?: { readonly line: number; readonly character: number }
  readonly endPosition?: { readonly line: number; readonly character: number }
  readonly query?: string
  readonly newName?: string
}

/** One renderer-visible extension notification (bounded text). */
export interface ExtensionNotification {
  readonly id: string
  readonly owner: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
}

/** One review-before-write proposal from extension edits. */
export interface ExtensionEditProposal {
  readonly proposalId: string
  readonly owner: string
  readonly edits: readonly { readonly uri: string; readonly range: unknown; readonly newText: string }[]
}

/** One normalized diagnostic for editor display. */
export interface ExtensionDiagnostic {
  readonly owner: string
  readonly collection: string
  readonly uri: string
  readonly severity: number
  readonly message: string
  readonly source?: string
  readonly range: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } }
}

/** One normalized status-bar item rendered by STARK UI. */
export interface ExtensionStatusItem {
  readonly itemId: number
  readonly owner: string
  readonly text: string
  readonly tooltip?: string
  readonly command?: string
  readonly alignment: number
  readonly priority: number
  readonly visible: boolean
}

/** One pending renderer prompt (quick pick / input box). */
export interface ExtensionPrompt {
  readonly promptId: string
  readonly owner: string
  readonly kind: 'quickPick' | 'inputBox'
  readonly items?: readonly string[]
  readonly placeHolder?: string
  readonly prompt?: string
  readonly value?: string
  readonly password?: boolean
  readonly canPickMany?: boolean
}

/** Renderer prompt resolution (selection, value, or dismissal). */
export interface ExtensionPromptResolution {
  readonly promptId: string
  readonly selected?: unknown
  readonly value?: string
  readonly cancelled?: boolean
}

/** Document sync event from the renderer-owned editor. */
export interface ExtensionDocumentEvent {
  readonly kind: 'opened' | 'changed' | 'closed'
  readonly uri: string
  readonly languageId?: string
  readonly text?: string
  readonly version?: number
}

/** Update availability for one installed version. */
export interface ExtensionUpdateCheck {
  readonly updateAvailable: boolean
  readonly latestVersion: string | null
}

/** One contributed language (detection override source). */
export interface ExtensionLanguage {
  readonly id: string
  readonly extensions: readonly string[]
  readonly aliases: readonly string[]
}

/** One contributed snippet (Monaco completion source). */
export interface ExtensionSnippet {
  readonly language: string
  readonly prefix: string
  readonly body: string
  readonly description: string
}

/** Editor theme data mapped into Monaco only (never the app shell). */
export interface ExtensionThemeData {
  readonly uiTheme: string
  readonly colors: Record<string, string>
  readonly tokenColors: readonly { readonly scope?: string | readonly string[]; readonly settings: { readonly foreground?: string; readonly fontStyle?: string } }[]
}

/** Explorer icon theme (file/folder rows only, never STARK branding). */
export interface ExtensionIconTheme {
  readonly fileExtensions: Record<string, string>
  readonly fileNames: Record<string, string>
  readonly icons: Record<string, string>
}

/** Selected theme reference (null = STARK default). */
export interface SelectedThemeRef {
  readonly extensionId: string
  readonly themeId: string
}

/** Renderer-facing extension-management bridge (see StarkApi). */
export interface ExtensionManagementApi {
  getDetails: (identity: ExtensionIdentity) => Promise<ExtensionDetails>
  setTrust: (identity: ExtensionIdentity, trusted: boolean) => Promise<boolean>
  acknowledgeAndActivate: (identity: ExtensionIdentity) => Promise<{ extensionId: string; displayName: string }>
  fireTrigger: (trigger: ExtensionTrigger) => Promise<ExtensionTriggerOutcome>
  listCommands: () => Promise<readonly ExtensionCommand[]>
  invokeCommand: (command: string, args?: readonly unknown[]) => Promise<unknown>
  queryProviders: (query: ExtensionProviderQuery) => Promise<Record<string, unknown> | null>
  getDiagnostics: (uri?: string) => Promise<readonly ExtensionDiagnostic[]>
  getOutput: (channel: string) => Promise<readonly string[]>
  listOutputChannels: () => Promise<readonly string[]>
  getStatusItems: () => Promise<readonly ExtensionStatusItem[]>
  listNotifications: () => Promise<readonly ExtensionNotification[]>
  listEditProposals: () => Promise<readonly ExtensionEditProposal[]>
  dismissProposal: (proposalId: string) => Promise<boolean>
  getConfig: (extensionId: string) => Promise<Record<string, string | number | boolean | null | readonly string[]>>
  updateConfig: (extensionId: string, key: string, value: string | number | boolean | null) => Promise<void>
  checkUpdate: (identity: ExtensionIdentity) => Promise<ExtensionUpdateCheck>
  getAutoUpdate: () => Promise<boolean>
  setAutoUpdate: (enabled: boolean) => Promise<boolean>
  listPrompts: () => Promise<readonly ExtensionPrompt[]>
  resolvePrompt: (resolution: ExtensionPromptResolution) => Promise<boolean>
  pushDocumentEvent: (event: ExtensionDocumentEvent) => Promise<void>
  setActiveEditor: (editor: { uri: string; languageId: string } | null) => Promise<void>
  setWorkspaceFolders: (folders: readonly { uri: string; name: string }[] | null) => Promise<void>
  listLanguages: () => Promise<readonly ExtensionLanguage[]>
  getSnippets: (languageId?: string) => Promise<readonly ExtensionSnippet[]>
  getThemeData: (identity: ExtensionIdentity, themeId: string) => Promise<ExtensionThemeData | null>
  getIconTheme: (identity: ExtensionIdentity, themeId: string) => Promise<ExtensionIconTheme | null>
  getSelectedThemes: () => Promise<{ editor: SelectedThemeRef | null; icon: SelectedThemeRef | null }>
  setSelectedTheme: (kind: 'editor' | 'icon', ref: SelectedThemeRef | null) => Promise<{ editor: SelectedThemeRef | null; icon: SelectedThemeRef | null }>
  onEvent: (listener: (event: { kind: string; payload: Record<string, unknown> }) => void) => () => void
}
