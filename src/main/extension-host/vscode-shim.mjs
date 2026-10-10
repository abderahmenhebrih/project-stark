/**
 * STARK-owned VS Code compatibility shim (Step 8 generic runtime).
 *
 * This file is the ONLY `vscode` module the Extension Host can load:
 * the host loader maps the bare `vscode` specifier here for ESM, and
 * the generic host maps CommonJS loads of that same specifier here —
 * third-party extension code can never reach a real VS Code API.
 * Every export is explicit and enumerated — there is intentionally NO
 * Proxy and NO catch-all: touching anything unlisted below throws
 * `Unsupported VS Code API: <name>` instead of silently faking it.
 *
 * Layout mirrors the VS Code API surface by domain (commands,
 * workspace, window, languages, extensions, env, types): each section
 * below is one auditable unit. They live in this single
 * dependency-free file so the loader mapping stays trivially
 * auditable (one `vscode` -> one file URL).
 *
 * Ownership (Step 7, kept): every registration is attributed to the
 * activating extension instance id. The host sets the active id via
 * `__setActiveExtensionId` before calling `activate()` and clears it
 * after; registrations made while an id is active belong to that
 * extension. `__disposeOwner(id)` disposes ONLY that owner's
 * registrations — disposing A never removes B. Unknown APIs throw
 * normalized `Unsupported VS Code API: <name>`.
 *
 * Main cooperation (Step 8): some APIs need the workspace or the user
 * (findFiles, openTextDocument, quick picks, clipboard, cross-extension
 * activation). Those go through the host-request pointer set by the
 * generic host (`__setHostRequestHandler`); without a handler they
 * resolve to safe fallbacks (empty, undefined) and NEVER fabricate
 * data. Fire-and-forget host notifications (messages shown, output,
 * status items, diagnostics, edit proposals, watcher registrations,
 * storage/config write-through) go through the notify pointer
 * (`__setHostNotify`); without it they are local-only. Memento reads
 * are synchronous over host-supplied snapshots (`__setExtensionSnapshots`).
 *
 * Trust policy (kept): `workspace.isTrusted` is false, so cautious
 * extensions neutralize project config-file loading and use bundled
 * resources. Review-before-write is non-negotiable: WorkspaceEdit /
 * workspace.applyEdit NEVER touch disk — they queue serializable edit
 * proposals for STARK's human-review transaction pipeline, and
 * workspace.fs writes that cannot map to review throw Unsupported.
 *
 * Plain ESM, no imports: this module must stay dependency-free so the
 * loader mapping is trivially auditable.
 */

function unsupported(name) {
  throw new Error(`Unsupported VS Code API: ${name}`);
}

/** Maximum registrations per extension (bounded, deterministic). */
const MAX_COMMANDS_PER_EXTENSION = 256;
const MAX_PROVIDERS_PER_EXTENSION = 256;
const MAX_COMMAND_ID_LENGTH = 128;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** commands.executeCommand nesting bound (recursive loops fail closed). */
const MAX_COMMAND_NESTING = 8;

/** Maximum executeCommand arguments (bounded). */
const MAX_COMMAND_ARGS = 8;

/** Maximum output channels per extension + retained bytes per channel. */
const MAX_OUTPUT_CHANNELS_PER_EXTENSION = 16;
const MAX_OUTPUT_BYTES_PER_CHANNEL = 1024 * 1024;

/** Maximum status-bar items per extension. */
const MAX_STATUS_ITEMS_PER_EXTENSION = 16;

/** Maximum diagnostics per file / per extension. */
const MAX_DIAGNOSTICS_PER_FILE = 2000;
const MAX_DIAGNOSTICS_PER_EXTENSION = 10000;

/** Maximum watchers per extension. */
const MAX_WATCHERS_PER_EXTENSION = 32;

/** Maximum diagnostic collections per extension. */
const MAX_DIAG_COLLECTIONS_PER_EXTENSION = 16;

/** Maximum message/prompt text lengths. */
const MAX_MESSAGE_LENGTH = 2048;
const MAX_PROMPT_ITEMS = 32;

/** Currently activating extension id (host-set, cleared after activate). */
let activeExtensionId = null;

/** Owner -> Set(disposable) for full disposal. */
const disposablesByOwner = new Map();

/** Command id -> { owner, handler }. */
const commandOwners = new Map();

/** executeCommand re-entry depth (loop guard). */
let commandNestingDepth = 0;

/**
 * Host cooperation pointers (set by the generic host per host
 * process; safe local fallbacks otherwise so unit tests never hang).
 * - request: async (type, payload, timeoutMs) -> response object or null
 * - notify: (type, payload) -> void (fire-and-forget, never throws out)
 */
let hostRequestHandler = null;
let hostNotifyHandler = null;

/** Extension snapshots for synchronous reads (config/state/docs). */
const extensionSnapshots = new Map();

/** Document store (uri string -> synthetic document, host-tracked). */
const openDocuments = new Map();

/** Workspace-folder snapshot (fed by main pushes; undefined until then). */
let workspaceFoldersSnapshot = undefined;

/** Active editor snapshot (set by host on main pushes). */
let activeEditorSnapshot = null;

/** Registered extension infos for the extensions API. */
const extensionInfos = new Map();

/** File-watcher registry: watcherId -> { owner, pattern, listeners }. */
const watcherRegistry = new Map();
let nextWatcherId = 1;

/** Diagnostic collections: `${owner}\0${name}` -> { owner, name, entries }. */
const diagnosticCollections = new Map();

/** Status-bar items: id -> record (for notify + disposal). */
const statusBarItems = new Map();
let nextStatusItemId = 1;

/** Output channels: `${owner}\0${name}` -> record. */
const outputChannels = new Map();

function trackDisposable(owner, disposable) {
  if (owner === null || owner === undefined) {
    return disposable;
  }
  let set = disposablesByOwner.get(owner);
  if (set === undefined) {
    set = new Set();
    disposablesByOwner.set(owner, set);
  }
  set.add(disposable);
  return disposable;
}

function requireActiveOwner() {
  if (typeof activeExtensionId !== 'string' || activeExtensionId === '') {
    throw new Error('Extension registration outside activation is not supported.');
  }
  return activeExtensionId;
}

function countOwned(mapOrArray, owner) {
  let count = 0;
  if (mapOrArray instanceof Map) {
    for (const entry of mapOrArray.values()) {
      if (entry?.owner === owner) {
        count++;
      }
    }
    return count;
  }
  for (const entry of mapOrArray) {
    if (entry?.owner === owner) {
      count++;
    }
  }
  return count;
}

async function hostRequest(type, payload, timeoutMs) {
  const handler = hostRequestHandler;
  if (typeof handler !== 'function') {
    return null;
  }
  try {
    const result = await handler(type, payload, timeoutMs);
    return result === undefined ? null : result;
  } catch {
    return null;
  }
}

function hostNotify(type, payload) {
  const handler = hostNotifyHandler;
  if (typeof handler !== 'function') {
    return;
  }
  try {
    handler(type, payload);
  } catch {
    // Notifications never break extension execution.
  }
}

/** Best-effort attribution for host cooperation (unknown outside handlers). */
function currentOwner() {
  return typeof activeExtensionId === 'string' && activeExtensionId !== '' ? activeExtensionId : 'unknown';
}

/** Test/host: set the attributing extension id. */
export function __setActiveExtensionId(id) {
  activeExtensionId = id;
}

/** Test/host: clear the attributing extension id. */
export function __clearActiveExtensionId() {
  activeExtensionId = null;
}

/** Test/host: current attributing id (or null). */
export function __getActiveExtensionId() {
  return activeExtensionId;
}

/** Host: set the main-cooperation request handler. */
export function __setHostRequestHandler(handler) {
  hostRequestHandler = typeof handler === 'function' ? handler : null;
}

/** Host: set the fire-and-forget notify handler. */
export function __setHostNotify(handler) {
  hostNotifyHandler = typeof handler === 'function' ? handler : null;
}

/** Host: install synchronous snapshots for one extension. */
export function __setExtensionSnapshots(extensionId, snapshots) {
  if (typeof extensionId !== 'string' || extensionId === '') {
    throw new Error('Extension id is not valid.');
  }
  extensionSnapshots.set(extensionId, {
    config: snapshots?.config !== null && typeof snapshots?.config === 'object' ? { ...snapshots.config } : {},
    globalState: snapshots?.globalState !== null && typeof snapshots?.globalState === 'object' ? { ...snapshots.globalState } : {},
    workspaceState: snapshots?.workspaceState !== null && typeof snapshots?.workspaceState === 'object' ? { ...snapshots.workspaceState } : {}
  });
}

/** Host: register extension metadata for the extensions API. */
export function __registerExtensionInfo(extensionId, info) {
  if (typeof extensionId !== 'string' || extensionId === '') {
    return;
  }
  extensionInfos.set(extensionId, {
    id: typeof info?.id === 'string' ? info.id : extensionId,
    packageJSON: info?.packageJSON !== null && typeof info?.packageJSON === 'object' ? { ...info.packageJSON } : {},
    isActive: true
  });
  extensions.__emitter.fire(undefined);
}

/** Host: apply a main-pushed document event to the tracked store. */
export function __applyDocumentEvent(event) {
  if (event === null || typeof event !== 'object') {
    return;
  }
  const uri = typeof event.uri === 'string' ? event.uri : null;
  if (uri === null || uri === '' || uri.length > 4096) {
    return;
  }
  if (event.kind === 'closed') {
    const existing = openDocuments.get(uri);
    if (existing !== undefined) {
      openDocuments.delete(uri);
      workspace.__emitterClose.fire(existing);
    }
    return;
  }
  if (event.kind === 'opened' || event.kind === 'changed') {
    const text = typeof event.text === 'string' ? event.text.slice(0, 1024 * 1024) : '';
    const languageId = typeof event.languageId === 'string' ? event.languageId.slice(0, 64) : 'plaintext';
    const version = Number.isInteger(event.version) ? event.version : 1;
    const previous = openDocuments.get(uri);
    const document = makeTextDocument(uri, languageId, text, version);
    openDocuments.set(uri, document);
    if (event.kind === 'opened' && previous === undefined) {
      workspace.__emitterOpen.fire(document);
    } else {
      workspace.__emitterChange.fire({ document, contentChanges: [{ text }] });
    }
  }
}

/** Host: set the active-editor snapshot from a main push. */
export function __setActiveEditor(snapshot) {  if (snapshot === null || snapshot === undefined) {
    activeEditorSnapshot = null;
    window.__emitterActiveEditor.fire(undefined);
    return;
  }
  if (typeof snapshot !== 'object' || typeof snapshot.uri !== 'string') {
    return;
  }
  activeEditorSnapshot = {
    uri: String(snapshot.uri).slice(0, 4096),
    languageId: typeof snapshot.languageId === 'string' ? snapshot.languageId.slice(0, 64) : 'plaintext'
  };
  window.__emitterActiveEditor.fire(activeEditorSnapshot);
}

/** Host: set workspace folders from a main push (validated, bounded). */
export function __setWorkspaceFolders(folders) {
  if (folders === null || folders === undefined) {
    const removed = Array.isArray(workspaceFoldersSnapshot) ? [...workspaceFoldersSnapshot] : [];
    workspaceFoldersSnapshot = undefined;
    if (removed.length > 0) {
      workspace.__emitterWorkspaceFolders.fire({ added: [], removed });
    }
    return;
  }
  if (!Array.isArray(folders)) {
    return;
  }
  const next = [];
  for (const entry of folders.slice(0, 8)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const uri = entry.uri instanceof Uri ? entry.uri : typeof entry.uri === 'string' ? Uri.parse(entry.uri) : null;
    if (uri === null) {
      continue;
    }
    next.push({
      uri,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name.slice(0, 128) : uri.path,
      index: next.length
    });
  }
  const previous = Array.isArray(workspaceFoldersSnapshot) ? workspaceFoldersSnapshot : [];
  const previousUris = new Set(previous.map((folder) => folder.uri.toString()));
  const nextUris = new Set(next.map((folder) => folder.uri.toString()));
  workspaceFoldersSnapshot = next.length === 0 ? undefined : next;
  const added = next.filter((folder) => !previousUris.has(folder.uri.toString()));
  const removed = previous.filter((folder) => !nextUris.has(folder.uri.toString()));
  if (added.length > 0 || removed.length > 0) {
    workspace.__emitterWorkspaceFolders.fire({ added, removed });
  }
}

/** Host: dispatch a main-pushed watcher event to matching listeners. */
export function __dispatchWatcherEvent(watcherId, kind, uri) {
  const record = watcherRegistry.get(watcherId);
  if (record === undefined) {
    return;
  }
  const listeners = kind === 'create' ? record.onCreate : kind === 'delete' ? record.onDelete : record.onChange;
  const eventUri = Uri.parse(String(uri ?? ''));
  for (const listener of [...listeners]) {
    try {
      listener(eventUri);
    } catch {
      // Listener failures never break dispatch.
    }
  }
}

function makeTextDocument(uriString, languageId, text, version) {
  const snapshot = String(text);
  const uri = Uri.parse(uriString);
  return {
    uri,
    fileName: uri.path,
    languageId: String(languageId),
    version: Number.isInteger(version) ? version : 1,
    isClosed: false,
    isDirty: false,
    eol: snapshot.includes('\r\n') ? 2 : 1,
    lineCount: snapshot === '' ? 1 : snapshot.split('\n').length,
    getText() {
      return snapshot;
    },
    positionAt(offset) {
      const clamped = Math.max(0, Math.min(Math.floor(offset), snapshot.length));
      let line = 0;
      let character = clamped;
      for (let i = 0; i < clamped && i < snapshot.length; i++) {
        if (snapshot[i] === '\n') {
          line++;
          character = clamped - i - 1;
        }
      }
      return new Position(line, character);
    },
    offsetAt(position) {
      const line = Math.max(0, Math.floor(position?.line ?? 0));
      const character = Math.max(0, Math.floor(position?.character ?? 0));
      let current = 0;
      let offset = 0;
      while (current < line && offset < snapshot.length) {
        if (snapshot[offset] === '\n') {
          current++;
        }
        offset++;
      }
      return Math.min(offset + character, snapshot.length);
    }
  };
}

/**
 * Test/host: dispose ONLY one owner's registrations. Never touches
 * other owners. Idempotent.
 */
export function __disposeOwner(owner) {
  const set = disposablesByOwner.get(owner);
  if (set !== undefined) {
    for (const disposable of [...set]) {
      try {
        if (disposable !== null && typeof disposable === 'object' && typeof disposable.dispose === 'function') {
          disposable.dispose();
        }
      } catch {
        // Best effort per disposable.
      }
    }
    disposablesByOwner.delete(owner);
  }
  for (const [id, entry] of [...commandOwners]) {
    if (entry?.owner === owner) {
      commandOwners.delete(id);
    }
  }
  for (let i = registeredCommands.length - 1; i >= 0; i--) {
    if (registeredCommands[i]?.owner === owner) {
      registeredCommands.splice(i, 1);
    }
  }
  for (const list of [documentFormatters, rangeFormatters, codeActionProviders, completionProviders, hoverProviders, definitionProviders, referenceProviders, documentSymbolProviders, workspaceSymbolProviders, renameProviders, signatureHelpProviders, codeLensProviders, documentLinkProviders, documentHighlightProviders, foldingRangeProviders, selectionRangeProviders, inlayHintsProviders, documentColorProviders, callHierarchyProviders, typeHierarchyProviders]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.owner === owner) {
        list.splice(i, 1);
      }
    }
  }
  // Legacy single-capture view: clear only when the owning capture
  // is removed; otherwise keep the surviving provider.
  if (captured.documentFormatter?.owner === owner) {
    captured.documentFormatter = null;
  }
  if (captured.rangeFormatter?.owner === owner) {
    captured.rangeFormatter = null;
  }
  for (const [id, record] of [...watcherRegistry]) {
    if (record.owner === owner) {
      watcherRegistry.delete(id);
    }
  }
  for (const key of [...diagnosticCollections.keys()]) {
    if (key.startsWith(`${owner}\0`)) {
      diagnosticCollections.delete(key);
    }
  }
  for (const [id, item] of [...statusBarItems]) {
    if (item.owner === owner) {
      statusBarItems.delete(id);
    }
  }
  for (const key of [...outputChannels.keys()]) {
    if (key.startsWith(`${owner}\0`)) {
      outputChannels.delete(key);
    }
  }
  extensionSnapshots.delete(owner);
}

/** Test/host: owner registration summary (counts only, never handlers). */
export function __getOwnerRegistrations(owner) {  const commands = [];
  for (const [id, entry] of commandOwners) {
    if (entry?.owner === owner) {
      commands.push(id);
    }
  }
  return {
    commands,
    documentFormatters: countOwned(documentFormatters, owner),
    rangeFormatters: countOwned(rangeFormatters, owner),
    codeActions: countOwned(codeActionProviders, owner),
    completions: countOwned(completionProviders, owner),
    hovers: countOwned(hoverProviders, owner),
    definitions: countOwned(definitionProviders, owner),
    references: countOwned(referenceProviders, owner),
    documentSymbols: countOwned(documentSymbolProviders, owner),
    renames: countOwned(renameProviders, owner),
    signatureHelp: countOwned(signatureHelpProviders, owner),
    codeLens: countOwned(codeLensProviders, owner),
    documentLinks: countOwned(documentLinkProviders, owner),
    highlights: countOwned(documentHighlightProviders, owner),
    watchers: [...watcherRegistry.values()].filter((w) => w.owner === owner).length,
    childProcesses: 0
  };
}

/** Host: owning extension of one registered command (or null). */
export function __getCommandOwner(command) {
  const record = commandOwners.get(command);
  return record?.owner ?? null;
}

/** Test/host: reset all registries (isolated test modules only). */
export function __resetForTests() {  activeExtensionId = null;
  disposablesByOwner.clear();
  commandOwners.clear();
  commandNestingDepth = 0;
  hostRequestHandler = null;
  hostNotifyHandler = null;
  extensionSnapshots.clear();
  openDocuments.clear();
  workspaceFoldersSnapshot = undefined;
  activeEditorSnapshot = null;
  extensionInfos.clear();
  watcherRegistry.clear();
  nextWatcherId = 1;
  diagnosticCollections.clear();
  statusBarItems.clear();
  nextStatusItemId = 1;
  outputChannels.clear();
  registeredCommands.length = 0;
  documentFormatters.length = 0;
  rangeFormatters.length = 0;
  codeActionProviders.length = 0;
  completionProviders.length = 0;
  hoverProviders.length = 0;
  definitionProviders.length = 0;
  referenceProviders.length = 0;
  documentSymbolProviders.length = 0;
  workspaceSymbolProviders.length = 0;
  renameProviders.length = 0;
  signatureHelpProviders.length = 0;
  codeLensProviders.length = 0;
  documentLinkProviders.length = 0;
  documentHighlightProviders.length = 0;
  foldingRangeProviders.length = 0;
  selectionRangeProviders.length = 0;
  inlayHintsProviders.length = 0;
  documentColorProviders.length = 0;
  callHierarchyProviders.length = 0;
  typeHierarchyProviders.length = 0;
  captured.documentFormatter = null;
  captured.rangeFormatter = null;
}

// ---------------------------------------------------------------------------
// Disposable / EventEmitter / CancellationToken
// ---------------------------------------------------------------------------

export class Disposable {
  constructor(callOnDispose) {
    if (typeof callOnDispose !== 'function') {
      throw new Error('Disposable handler is not valid.');
    }
    this.callOnDispose = callOnDispose;
  }

  dispose() {
    try {
      this.callOnDispose();
    } catch {
      // Best effort.
    }
  }

  static from(...disposables) {
    return new Disposable(() => {
      for (const disposable of disposables) {
        try {
          disposable?.dispose();
        } catch {
          // Best effort per disposable.
        }
      }
    });
  }
}

export class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      if (typeof listener !== 'function') {
        throw new Error('Event listener is not valid.');
      }
      this.listeners.add(listener);
      return new Disposable(() => {
        this.listeners.delete(listener);
      });
    };
  }

  fire(data) {
    for (const listener of [...this.listeners].slice(0, 256)) {
      try {
        listener(data);
      } catch {
        // Listener failures never break dispatch.
      }
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

export class CancellationToken {
  constructor() {
    this.isCancellationRequested = false;
    this.emitter = new EventEmitter();
  }

  onCancellationRequested(listener) {
    if (this.isCancellationRequested) {
      try {
        listener();
      } catch {
        // Best effort.
      }
      return new Disposable(() => {});
    }
    return this.emitter.event(listener);
  }

  __cancel() {
    if (!this.isCancellationRequested) {
      this.isCancellationRequested = true;
      this.emitter.fire(undefined);
    }
  }
}

export class CancellationTokenSource {
  constructor() {
    this.token = new CancellationToken();
  }

  cancel() {
    this.token.__cancel();
  }

  dispose() {
    this.cancel();
  }
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
  constructor(scheme, path) {
    this.scheme = scheme;
    this.path = path;
  }

  static file(filePath) {
    return new Uri('file', String(filePath).replace(/\\/g, '/'));
  }

  static parse(value) {
    const text = String(value);
    const sep = text.indexOf(':');
    return sep === -1 ? new Uri('', text) : new Uri(text.slice(0, sep), text.slice(sep + 1));
  }

  static joinPath(base, ...parts) {
    const scheme = base?.scheme ?? '';
    const root = base?.path ?? '';
    return new Uri(scheme, [root, ...parts.map((part) => String(part))].join('/'));
  }

  with(change) {
    if (change === null || typeof change !== 'object') {
      throw new Error('Uri change is not valid.');
    }
    return new Uri(
      change.scheme !== undefined ? String(change.scheme) : this.scheme,
      change.path !== undefined ? String(change.path) : this.path
    );
  }

  get fsPath() {
    return this.path;
  }

  get authority() {
    return '';
  }

  get query() {
    return '';
  }

  get fragment() {
    return '';
  }

  toString() {
    return `${this.scheme}:${this.path}`;
  }

  toJSON() {
    return { scheme: this.scheme, path: this.path };
  }
}

// ---------------------------------------------------------------------------
// Positions, ranges, locations, diagnostics
// ---------------------------------------------------------------------------

export class Position {
  constructor(line, character) {
    if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
      throw new Error('Position is not valid.');
    }
    this.line = line;
    this.character = character;
  }

  isBefore(other) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isAfter(other) {
    return this.line > other.line || (this.line === other.line && this.character > other.character);
  }

  isEqual(other) {
    return this.line === other?.line && this.character === other?.character;
  }

  translate(lineDelta, characterDelta) {
    return new Position(this.line + (lineDelta ?? 0), this.character + (characterDelta ?? 0));
  }

  with(line, character) {
    return new Position(line ?? this.line, character ?? this.character);
  }
}

export class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = a instanceof Position ? a : new Position(a, b);
      this.end = c instanceof Position ? c : new Position(c, d);
    } else {
      this.start = a instanceof Position ? a : new Position(a?.line ?? 0, a?.character ?? 0);
      this.end = b instanceof Position ? b : new Position(b?.line ?? 0, b?.character ?? 0);
    }
  }

  get isEmpty() {
    return this.start.isEqual(this.end);
  }

  contains(positionOrRange) {
    if (positionOrRange instanceof Range) {
      return !positionOrRange.start.isBefore(this.start) && !positionOrRange.end.isAfter(this.end);
    }
    return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
  }

  isEqual(other) {
    return other instanceof Range && this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
}

export class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d);
    this.anchor = this.start;
    this.active = this.end;
  }

  get isReversed() {
    return false;
  }
}

export class Location {
  constructor(uri, rangeOrPosition) {
    if (!(uri instanceof Uri)) {
      throw new Error('Location uri is not valid.');
    }
    this.uri = uri;
    this.range = rangeOrPosition instanceof Position
      ? new Range(rangeOrPosition, rangeOrPosition)
      : rangeOrPosition;
  }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
  constructor(range, message, severity) {
    if (!(range instanceof Range)) {
      throw new Error('Diagnostic range is not valid.');
    }
    if (typeof message !== 'string' || message === '' || message.length > 4096) {
      throw new Error('Diagnostic message is not valid.');
    }
    this.range = range;
    this.message = message;
    this.severity = severity ?? DiagnosticSeverity.Error;
    this.source = undefined;
    this.code = undefined;
  }
}

export class MarkdownString {
  constructor(value) {
    this.value = typeof value === 'string' ? value.slice(0, 8192) : '';
    this.isTrusted = false;
    this.supportThemeIcons = false;
  }

  appendText(value) {
    this.value = (this.value + String(value)).slice(0, 8192);
    return this;
  }

  appendMarkdown(value) {
    return this.appendText(value);
  }
}

export class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents.slice(0, 8) : [contents];
    this.range = range;
  }
}

export class CodeLens {
  constructor(range, command) {
    if (!(range instanceof Range)) {
      throw new Error('Code lens range is not valid.');
    }
    this.range = range;
    this.command = command;
    this.isResolved = false;
  }
}

export class DocumentLink {
  constructor(range, target) {
    if (!(range instanceof Range)) {
      throw new Error('Document link range is not valid.');
    }
    this.range = range;
    this.target = target;
    this.tooltip = undefined;
  }
}

export class DocumentHighlight {
  constructor(range, kind) {
    if (!(range instanceof Range)) {
      throw new Error('Document highlight range is not valid.');
    }
    this.range = range;
    this.kind = kind ?? 0;
  }
}

export const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };

export class FoldingRange {
  constructor(start, end, kind) {
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start) {
      throw new Error('Folding range is not valid.');
    }
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

export const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 };

export class SelectionRange {
  constructor(range, parent) {
    if (!(range instanceof Range)) {
      throw new Error('Selection range is not valid.');
    }
    this.range = range;
    this.parent = parent;
  }
}

export const InlayHintKind = { Type: 1, Parameter: 2 };

export class InlayHint {
  constructor(position, label, kind) {
    if (!(position instanceof Position)) {
      throw new Error('Inlay hint position is not valid.');
    }
    this.position = position;
    this.label = typeof label === 'string' ? label.slice(0, 512) : label;
    this.kind = kind;
    this.textEdits = undefined;
    this.tooltip = undefined;
    this.paddingLeft = undefined;
    this.paddingRight = undefined;
  }
}

export class CallHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) {
    this.kind = kind ?? 0;
    this.name = String(name).slice(0, 256);
    this.detail = typeof detail === 'string' ? detail.slice(0, 512) : undefined;
    if (!(uri instanceof Uri) || !(range instanceof Range) || !(selectionRange instanceof Range)) {
      throw new Error('Call hierarchy item is not valid.');
    }
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class TypeHierarchyItem extends CallHierarchyItem {}

export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CancellationError';
  }
}

export const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 };

export const SymbolTag = { Deprecated: 1 };

export const CompletionItemTag = { Deprecated: 1 };

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

export const FileChangeType = { Changed: 0, Created: 1, Deleted: 2 };

export const TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };

export const SignatureHelpTriggerKind = { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 };

export const InsertTextMode = { asIs: 1, adjustIndentation: 2 };

export const EndOfLine = { LF: 1, CRLF: 2 };

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };

export const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5,
  Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11,
  Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17,
  Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
  Operator: 23, TypeParameter: 24
};

export class CompletionItem {
  constructor(label, kind) {
    if (typeof label !== 'string' && (label === null || typeof label !== 'object')) {
      throw new Error('Completion label is not valid.');
    }
    this.label = label;
    this.kind = kind ?? CompletionItemKind.Text;
  }
}

export class CompletionList {
  constructor(items, isIncomplete) {
    this.items = Array.isArray(items) ? items.slice(0, 256) : [];
    this.isIncomplete = isIncomplete === true;
  }
}

export class SnippetString {
  constructor(value) {
    this.value = typeof value === 'string' ? value.slice(0, 8192) : '';
  }

  appendText(value) {
    this.value = (this.value + String(value)).slice(0, 8192);
    return this;
  }

  appendTabstop() {
    return this;
  }

  appendPlaceholder(value) {
    return this.appendText(value);
  }
}

export class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }

  static replace(range, newText) {
    return new TextEdit(range, newText);
  }

  static insert(position, newText) {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range) {
    return new TextEdit(range, '');
  }
}

/**
 * WorkspaceEdit collects serializable edits as DATA ONLY. It never
 * touches the filesystem: `workspace.applyEdit` validates the entries
 * and queues them as a human-review proposal (never silent disk
 * mutation). Entries are bounded (64 edits, bounded text).
 */
export class WorkspaceEdit {
  constructor() {
    this.entries = [];
  }

  replace(uri, range, newText) {
    this.assertEdit(uri, range, newText);
    this.entries.push({ uri: uri.toString(), range: toSerializableRange(range), newText: String(newText) });
  }

  insert(uri, position, newText) {
    this.replace(uri, new Range(position, position), newText);
  }

  delete(uri, range) {
    this.replace(uri, range, '');
  }

  set(uri, edits) {
    if (!(uri instanceof Uri)) {
      throw new Error('Workspace edit uri is not valid.');
    }
    if (!Array.isArray(edits)) {
      throw new Error('Workspace edits are not valid.');
    }
    for (const edit of edits.slice(0, 64)) {
      this.replace(uri, edit?.range, edit?.newText);
    }
  }

  get(uri) {
    const key = uri instanceof Uri ? uri.toString() : String(uri);
    return this.entries.filter((entry) => entry.uri === key);
  }

  has(uri) {
    return this.get(uri).length > 0;
  }

  get size() {
    return this.entries.length;
  }

  assertEdit(uri, range, newText) {
    if (!(uri instanceof Uri)) {
      throw new Error('Workspace edit uri is not valid.');
    }
    if (!(range instanceof Range)) {
      throw new Error('Workspace edit range is not valid.');
    }
    if (typeof newText !== 'string' || newText.length > 1024 * 1024) {
      throw new Error('Workspace edit text is not valid.');
    }
    if (this.entries.length >= 64) {
      throw new Error('Too many workspace edits.');
    }
  }
}

function toSerializableRange(range) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

export class CodeAction {
  constructor(title, kind) {
    if (typeof title !== 'string' || title === '' || title.length > 512) {
      throw new Error('Code action title is not valid.');
    }
    this.title = title;
    this.kind = kind;
  }
}

export const CodeActionKind = {
  Empty: { value: '' },
  QuickFix: { value: 'quickfix' },
  Refactor: { value: 'refactor' },
  Source: { value: 'source' },
  SourceFixAll: {
    value: 'source.fixAll',
    append(part) {
      return { value: `source.fixAll.${part}` };
    }
  }
};

export class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

export class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }

  static get File() {
    return new ThemeIcon('file');
  }

  static get Folder() {
    return new ThemeIcon('folder');
  }
}

export class RelativePattern {
  constructor(base, pattern) {
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > 256 || pattern.includes('\0')) {
      throw new Error('Relative pattern is not valid.');
    }
    this.baseUri = base instanceof Uri ? base : undefined;
    this.base = typeof base === 'string' ? base : undefined;
    this.pattern = pattern;
    if (this.baseUri === undefined && this.base === undefined) {
      throw new Error('Relative pattern base is not valid.');
    }
  }
}

export class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = String(name).slice(0, 256);
    this.detail = typeof detail === 'string' ? detail.slice(0, 512) : '';
    this.kind = kind ?? 0;
    this.range = range;
    this.selectionRange = selectionRange ?? range;
    this.children = [];
  }
}

export class SymbolInformation {
  constructor(name, kind, containerName, location) {
    this.name = String(name).slice(0, 256);
    this.kind = kind ?? 0;
    this.containerName = typeof containerName === 'string' ? containerName.slice(0, 256) : '';
    this.location = location;
  }
}

export const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
  Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
  Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20,
  EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25
};

export class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}

export class ParameterInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
  }
}

export const LanguageStatusSeverity = { Information: 0, Warning: 1, Error: 2 };

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const registeredCommands = [];

function assertCommandArgs(args) {
  if (args.length > MAX_COMMAND_ARGS) {
    throw new Error('Too many command arguments.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(args) ?? '';
  } catch {
    throw new Error('Command arguments are not serializable.');
  }
  if (serialized.length > 64 * 1024) {
    throw new Error('Command arguments exceed their bound.');
  }
  return args;
}

export const commands = {
  registerCommand(id, handler) {
    const owner = requireActiveOwner('commands.registerCommand');
    if (typeof id !== 'string' || id === '' || id.length > MAX_COMMAND_ID_LENGTH || !COMMAND_ID_PATTERN.test(id)) {
      throw new Error('Command id is not valid.');
    }
    if (typeof handler !== 'function') {
      throw new Error('Command handler is not valid.');
    }
    if (commandOwners.has(id)) {
      throw new Error(`Command ${id} is already registered.`);
    }
    if (countOwned(commandOwners, owner) >= MAX_COMMANDS_PER_EXTENSION) {
      throw new Error('Too many commands are registered.');
    }
    commandOwners.set(id, { owner, handler });
    const entry = { id, handler, owner };
    registeredCommands.push(entry);
    const disposable = {
      dispose() {
        const current = commandOwners.get(id);
        if (current?.owner === owner) {
          commandOwners.delete(id);
        }
        const index = registeredCommands.indexOf(entry);
        if (index !== -1) {
          registeredCommands.splice(index, 1);
        }
      }
    };
    return trackDisposable(owner, disposable);
  },
  registerTextEditorCommand(id, handler) {
    const disposable = commands.registerCommand(id, (...args) => handler(activeEditorSnapshot, undefined, ...args));
    return disposable;
  },
  async executeCommand(id, ...args) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_COMMAND_ID_LENGTH) {
      throw new Error('Command id is not valid.');
    }
    assertCommandArgs(args);
    if (commandNestingDepth >= MAX_COMMAND_NESTING) {
      throw new Error('Command nesting limit reached.');
    }
    let record = commandOwners.get(id);
    if (record === undefined) {
      // Demand-driven onCommand activation: ask the host to activate
      // the owning extension once, then re-resolve. Without a host
      // the command is honestly missing.
      const activated = await hostRequest('activateForCommand', { command: id }, 10_000);
      if (activated !== null && typeof activated === 'object' && activated.activated === true) {
        record = commandOwners.get(id);
      }
    }
    if (record === undefined || typeof record.handler !== 'function') {
      throw new Error(`Command ${id} is not found.`);
    }
    commandNestingDepth += 1;
    try {
      return await record.handler(...args);
    } finally {
      commandNestingDepth -= 1;
    }
  },
  async getCommands() {
    return [...commandOwners.keys()].sort().slice(0, 1024);
  },
  /** Test/host introspection only: registrations (id + owner). */
  __registeredCommands: registeredCommands
};

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

/**
 * Real defaults audited from esbenp.prettier-vscode 12.4.0
 * contributes.configuration (35 properties). Unknown sections yield
 * an empty config whose .get falls back to the caller default.
 */
const PRETTIER_DEFAULTS = {
  enable: true,
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: 'all',
  bracketSpacing: true,
  singleAttributePerLine: false,
  bracketSameLine: false,
  jsxBracketSameLine: false,
  requirePragma: false,
  insertPragma: false,
  proseWrap: 'preserve',
  arrowParens: 'always',
  jsxSingleQuote: false,
  htmlWhitespaceSensitivity: 'css',
  vueIndentScriptAndStyle: false,
  endOfLine: 'lf',
  quoteProps: 'as-needed',
  embeddedLanguageFormatting: 'auto',
  experimentalTernaries: false,
  objectWrap: 'preserve',
  experimentalOperatorPosition: 'end',
  requireConfig: false,
  ignorePath: '.prettierignore',
  useEditorConfig: true,
  resolveGlobalModules: false,
  withNodeModules: false,
  configPath: '',
  prettierPath: '',
  enableDebugLogs: false,
  disableLanguages: [],
  documentSelectors: [],
  packageManager: 'npm'
};

function snapshotConfigFor(owner) {
  const snapshots = extensionSnapshots.get(owner);
  const stored = snapshots?.config;
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function makeConfig(section, values, stored, owner) {
  // Plain data object: extensions spread it ({...config}), so known
  // values must be own enumerable properties. Reads consult the live
  // snapshot every call so update() echoes within the session even
  // when snapshots arrive after the config object was created.
  const config = { ...values };
  function liveStored() {
    const live = snapshotConfigFor(owner);
    return live !== null && typeof live === 'object' ? live : stored;
  }
  config.get = (key, dflt) => {
    const fullKey = `${section}.${key}`;
    const live = liveStored();
    if (Object.prototype.hasOwnProperty.call(live, fullKey)) {
      return live[fullKey];
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key];
    }
    return dflt;
  };
  config.has = (key) => Object.prototype.hasOwnProperty.call(liveStored(), `${section}.${key}`) ||
    Object.prototype.hasOwnProperty.call(values, key);
  config.inspect = (key) => ({
    key: `${section}.${key}`,
    defaultValue: Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined,
    globalValue: Object.prototype.hasOwnProperty.call(liveStored(), `${section}.${key}`) ? liveStored()[`${section}.${key}`] : undefined
  });
  config.update = async (key, value) => {
    if (typeof key !== 'string' || key === '' || key.length > 256) {
      throw new Error('Configuration key is not valid.');
    }
    const valid = value === null || typeof value === 'string' || typeof value === 'number' ||
      typeof value === 'boolean' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
    if (!valid) {
      throw new Error('Configuration value is not valid.');
    }
    // Main-owned persistence: write-through notification, never a
    // settings-file write from extension code.
    hostNotify('CONFIG_UPDATE', { owner, key: `${section}.${key}`, value });
    let snapshots = extensionSnapshots.get(owner);
    if (snapshots === undefined) {
      snapshots = { config: {}, globalState: {}, workspaceState: {} };
      extensionSnapshots.set(owner, snapshots);
    }
    snapshots.config[`${section}.${key}`] = value;
    workspace.__emitterConfig.fire({ affectsConfiguration: () => true });
  };
  return config;
}

function validateWatcherPattern(pattern) {
  const text = pattern instanceof RelativePattern ? pattern.pattern : pattern;
  if (typeof text !== 'string' || text === '' || text.length > 256 || text.includes('\0')) {
    throw new Error('File watcher pattern is not valid.');
  }
  if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.includes('..')) {
    throw new Error('File watcher pattern escapes the workspace.');
  }
  return text;
}

function makeWatcher(owner, pattern) {
  const id = nextWatcherId++;
  const record = {
    id,
    owner,
    pattern,
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    onCreate: new Set(),
    onChange: new Set(),
    onDelete: new Set()
  };
  watcherRegistry.set(id, record);
  hostNotify('WATCHER_REGISTER', { owner, watcherId: id, pattern });
  const watcher = {
    get ignoreCreateEvents() {
      return record.ignoreCreateEvents;
    },
    set ignoreCreateEvents(value) {
      record.ignoreCreateEvents = value === true;
    },
    get ignoreChangeEvents() {
      return record.ignoreChangeEvents;
    },
    set ignoreChangeEvents(value) {
      record.ignoreChangeEvents = value === true;
    },
    get ignoreDeleteEvents() {
      return record.ignoreDeleteEvents;
    },
    set ignoreDeleteEvents(value) {
      record.ignoreDeleteEvents = value === true;
    },
    onDidCreate(listener) {
      return addWatcherListener(record, 'onCreate', listener, owner);
    },
    onDidChange(listener) {
      return addWatcherListener(record, 'onChange', listener, owner);
    },
    onDidDelete(listener) {
      return addWatcherListener(record, 'onDelete', listener, owner);
    },
    dispose() {
      watcherRegistry.delete(id);
      hostNotify('WATCHER_DISPOSE', { owner, watcherId: id });
    }
  };
  return trackDisposable(owner, watcher);
}

function addWatcherListener(record, kind, listener, owner) {
  if (typeof listener !== 'function') {
    throw new Error('Watcher listener is not valid.');
  }
  record[kind].add(listener);
  const disposable = {
    dispose() {
      record[kind].delete(listener);
    }
  };
  return owner !== null ? trackDisposable(owner, disposable) : disposable;
}

function serializableEditProposal(edit) {
  if (edit === null || typeof edit !== 'object') {
    return null;
  }
  if (edit instanceof WorkspaceEdit) {
    if (edit.entries.length > 64) {
      return null;
    }
    return { edits: edit.entries.map((entry) => ({ uri: entry.uri, range: entry.range, newText: entry.newText })) };
  }
  return null;
}

export const workspace = {
  /** Untrusted, so extensions use bundled resources only. */
  isTrusted: false,
  /** Workspace folders from the latest main push (undefined until then). */
  get workspaceFolders() {
    return workspaceFoldersSnapshot === undefined ? undefined : [...workspaceFoldersSnapshot];
  },
  getWorkspaceFolder(uri) {
    const folders = workspaceFoldersSnapshot;
    if (!Array.isArray(folders) || folders.length === 0) {
      return undefined;
    }
    const key = uri instanceof Uri ? uri.toString() : String(uri ?? '');
    let best = undefined;
    for (const folder of folders) {
      const prefix = folder.uri.toString();
      if ((key === prefix || key.startsWith(`${prefix}/`)) && (best === undefined || prefix.length > best.uri.toString().length)) {
        best = folder;
      }
    }
    return best;
  },
  onDidChangeWorkspaceFolders(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Workspace listener is not valid.');
    }
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : null;
    const disposable = workspace.__emitterWorkspaceFolders.event(listener);
    return owner !== null ? trackDisposable(owner, disposable) : disposable;
  },
  getConfiguration(section) {
    const name = typeof section === 'string' && section !== '' ? section : '';
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : 'unknown';
    const stored = snapshotConfigFor(owner);
    if (name === 'prettier') {
      return makeConfig(name, { ...PRETTIER_DEFAULTS }, stored, owner);
    }
    // Extension-declared defaults would merge here once the host
    // ships contribution defaults; unknown sections read stored
    // values only (never fabricated). The live snapshot stays shared
    // so update() echoes within the session.
    return makeConfig(name, {}, stored, owner);
  },
  onDidChangeConfiguration(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Configuration listener is not valid.');
    }
    return workspace.__emitterConfig.event(listener);
  },
  get textDocuments() {
    return [...openDocuments.values()].slice(0, 128);
  },
  onDidOpenTextDocument(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Document listener is not valid.');
    }
    return workspace.__emitterOpen.event(listener);
  },
  onDidCloseTextDocument(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Document listener is not valid.');
    }
    return workspace.__emitterClose.event(listener);
  },
  onDidChangeTextDocument(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Document listener is not valid.');
    }
    return workspace.__emitterChange.event(listener);
  },
  createFileSystemWatcher(pattern) {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : null;
    if (owner !== null) {
      const owned = [...watcherRegistry.values()].filter((w) => w.owner === owner).length;
      if (owned >= MAX_WATCHERS_PER_EXTENSION) {
        throw new Error('Too many file watchers.');
      }
    }
    return makeWatcher(owner, validateWatcherPattern(pattern));
  },
  async findFiles(include, exclude, maxResults) {
    const pattern = include instanceof RelativePattern ? include.pattern : include;
    if (typeof pattern !== 'string' || pattern === '' || pattern.length > 256) {
      throw new Error('Find pattern is not valid.');
    }
    const limit = maxResults === undefined ? 100 : Math.max(1, Math.min(100, Math.floor(maxResults)));
    const response = await hostRequest('findFiles', { owner: currentOwner(), pattern, exclude: typeof exclude === 'string' ? exclude : null, maxResults: limit }, 5000);
    if (response === null || typeof response !== 'object' || !Array.isArray(response.uris)) {
      return [];
    }
    return response.uris.slice(0, limit).filter((uri) => typeof uri === 'string').map((uri) => Uri.parse(uri));
  },
  async openTextDocument(uriOrPath) {
    const key = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath instanceof Uri ? uriOrPath.toString() : null;
    if (key === null) {
      throw new Error('Document uri is not valid.');
    }
    const existing = openDocuments.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const response = await hostRequest('openDocument', { owner: currentOwner(), uri: key.slice(0, 4096) }, 5000);
    if (response === null || typeof response !== 'object' || typeof response.text !== 'string') {
      unsupported('workspace.openTextDocument (no workspace connection)');
    }
    const document = makeTextDocument(key, typeof response.languageId === 'string' ? response.languageId : 'plaintext', response.text, 1);
    openDocuments.set(key, document);
    workspace.__emitterOpen.fire(document);
    return document;
  },
  async applyEdit(edit) {
    const proposal = serializableEditProposal(edit);
    if (proposal === null) {
      throw new Error('Workspace edit is not valid.');
    }
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : 'unknown';
    // Review-before-write: the proposal queues for STARK's human
    // Accept/Reject pipeline via the host; nothing is written here.
    // Resolves true once accepted FOR REVIEW (not yet applied).
    hostNotify('EDIT_PROPOSAL', { owner, edits: proposal.edits });
    return true;
  },
  fs: {
    async readFile(uri) {
      const key = uri instanceof Uri ? uri.toString() : String(uri ?? '');
      const response = await hostRequest('fsRead', { owner: currentOwner(), uri: key.slice(0, 4096) }, 5000);
      if (response === null || typeof response !== 'object' || typeof response.content !== 'string') {
        unsupported('workspace.fs.readFile (no workspace connection)');
      }
      return Uint8Array.from(globalThis.Buffer.from(response.content, 'base64'));
    },
    async stat(uri) {
      const key = uri instanceof Uri ? uri.toString() : String(uri ?? '');
      const response = await hostRequest('fsStat', { owner: currentOwner(), uri: key.slice(0, 4096) }, 5000);
      if (response === null || typeof response !== 'object' || typeof response.type !== 'number') {
        unsupported('workspace.fs.stat (no workspace connection)');
      }
      return { type: response.type, ctime: 0, mtime: Date.now(), size: 0 };
    },
    async writeFile() {
      unsupported('workspace.fs.writeFile (use review-before-write proposals)');
    },
    async delete() {
      unsupported('workspace.fs.delete (use review-before-write proposals)');
    },
    async rename() {
      unsupported('workspace.fs.rename (use review-before-write proposals)');
    },
    async copy() {
      unsupported('workspace.fs.copy (use review-before-write proposals)');
    }
  },
  /** Host/test emitters (not part of the VS Code surface). */
  __emitterConfig: new EventEmitter(),
  __emitterOpen: new EventEmitter(),
  __emitterClose: new EventEmitter(),
  __emitterChange: new EventEmitter(),
  __emitterWorkspaceFolders: new EventEmitter()
};

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function validateMessage(message) {
  if (typeof message !== 'string' || message === '' || message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('Message text is not valid.');
  }
  return message;
}

function validateMessageItems(items) {
  const list = items.slice(0, MAX_PROMPT_ITEMS);
  for (const item of list) {
    if (typeof item !== 'string' || item === '' || item.length > 128) {
      throw new Error('Message item is not valid.');
    }
  }
  return list;
}

function makeOutputChannel(owner, name) {
  if (typeof name !== 'string' || name === '' || name.length > 128 || name.includes('\0')) {
    throw new Error('Output channel name is not valid.');
  }
  const key = `${owner ?? 'unknown'}\0${name}`;
  const existing = outputChannels.get(key);
  if (existing !== undefined) {
    return existing.channel;
  }
  if (owner !== null) {
    const owned = [...outputChannels.keys()].filter((entry) => entry.startsWith(`${owner}\0`)).length;
    if (owned >= MAX_OUTPUT_CHANNELS_PER_EXTENSION) {
      throw new Error('Too many output channels.');
    }
  }
  const record = { owner, name, retained: 0 };
  const append = (value, line) => {
    const text = line ? `${String(value)}\n` : String(value);
    const bounded = text.slice(0, 8192);
    record.retained = Math.min(MAX_OUTPUT_BYTES_PER_CHANNEL, record.retained + bounded.length);
    hostNotify('OUTPUT_APPEND', { owner, channel: name.slice(0, 128), text: bounded });
  };
  const channel = {
    get name() {
      return name;
    },
    append(value) {
      append(value, false);
    },
    appendLine(value) {
      append(value, true);
    },
    replace() {},
    clear() {
      record.retained = 0;
      hostNotify('OUTPUT_CLEAR', { owner, channel: name.slice(0, 128) });
    },
    show() {},
    hide() {},
    dispose() {
      outputChannels.delete(key);
    }
  };
  record.channel = channel;
  outputChannels.set(key, record);
  if (owner !== null) {
    trackDisposable(owner, channel);
  }
  return channel;
}

function makeStatusItem(owner, id, alignment, priority) {
  if (owner !== null) {
    const owned = [...statusBarItems.values()].filter((item) => item.owner === owner).length;
    if (owned >= MAX_STATUS_ITEMS_PER_EXTENSION) {
      throw new Error('Too many status bar items.');
    }
  }
  const itemId = nextStatusItemId++;
  const record = {
    id: itemId,
    owner,
    itemId: typeof id === 'string' ? id.slice(0, 128) : undefined,
    alignment: alignment === 1 ? 1 : 2,
    priority: typeof priority === 'number' && Number.isFinite(priority) ? priority : 0,
    text: '',
    tooltip: undefined,
    command: undefined,
    visible: false
  };
  const push = () => {
    hostNotify('STATUSBAR_UPDATE', {
      owner,
      itemId,
      text: String(record.text).slice(0, 256),
      tooltip: record.tooltip === undefined ? undefined : String(record.tooltip).slice(0, 512),
      command: record.command === undefined ? undefined : String(record.command).slice(0, 128),
      alignment: record.alignment,
      priority: record.priority,
      visible: record.visible
    });
  };
  const item = {
    get text() {
      return record.text;
    },
    set text(value) {
      record.text = String(value ?? '').slice(0, 256);
      push();
    },
    get tooltip() {
      return record.tooltip;
    },
    set tooltip(value) {
      record.tooltip = value === undefined ? undefined : String(value).slice(0, 512);
      push();
    },
    get command() {
      return record.command;
    },
    set command(value) {
      record.command = value === undefined ? undefined : String(value).slice(0, 128);
      push();
    },
    show() {
      record.visible = true;
      push();
    },
    hide() {
      record.visible = false;
      push();
    },
    dispose() {
      statusBarItems.delete(itemId);
      hostNotify('STATUSBAR_DISPOSE', { owner, itemId });
    }
  };
  statusBarItems.set(itemId, record);
  if (owner !== null) {
    trackDisposable(owner, item);
  }
  return item;
}

export const window = {
  get activeTextEditor() {
    return activeEditorSnapshot === null ? undefined : { document: openDocuments.get(activeEditorSnapshot.uri) };
  },
  get visibleTextEditors() {
    return [];
  },
  async showInformationMessage(message, ...items) {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : 'unknown';
    hostNotify('MESSAGE_SHOWN', { owner, severity: 'info', message: validateMessage(message), items: validateMessageItems(items) });
    return undefined;
  },
  async showWarningMessage(message, ...items) {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : 'unknown';
    hostNotify('MESSAGE_SHOWN', { owner, severity: 'warning', message: validateMessage(message), items: validateMessageItems(items) });
    return undefined;
  },
  async showErrorMessage(message, ...items) {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : 'unknown';
    hostNotify('MESSAGE_SHOWN', { owner, severity: 'error', message: validateMessage(message), items: validateMessageItems(items) });
    return undefined;
  },
  async showQuickPick(items, options) {
    const list = Array.isArray(items) ? items.slice(0, MAX_PROMPT_ITEMS) : [];
    const labels = list.map((entry) => (typeof entry === 'string' ? entry : entry?.label)).filter((label) => typeof label === 'string');
    const response = await hostRequest(
      'showQuickPick',
      {
        owner: currentOwner(),
        items: labels.map((label) => String(label).slice(0, 256)),
        placeHolder: options?.placeHolder !== undefined ? String(options.placeHolder).slice(0, 256) : undefined,
        canPickMany: options?.canPickMany === true
      },
      120_000
    );
    if (response === null || typeof response !== 'object') {
      return undefined;
    }
    return response.selected ?? undefined;
  },
  async showInputBox(options) {
    const response = await hostRequest(
      'showInputBox',
      {
        owner: currentOwner(),
        prompt: options?.prompt !== undefined ? String(options.prompt).slice(0, 512) : undefined,
        placeHolder: options?.placeHolder !== undefined ? String(options.placeHolder).slice(0, 256) : undefined,
        value: options?.value !== undefined ? String(options.value).slice(0, 2048) : undefined,
        password: options?.password === true
      },
      120_000
    );
    if (response === null || typeof response !== 'object' || typeof response.value !== 'string') {
      return undefined;
    }
    return response.value.slice(0, 2048);
  },
  async withProgress(options, task) {
    if (typeof task !== 'function') {
      throw new Error('Progress task is not valid.');
    }
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : 'unknown';
    const title = options !== null && typeof options === 'object' && options.title !== undefined
      ? String(options.title).slice(0, 256)
      : '';
    hostNotify('PROGRESS_START', { owner, title });
    const progress = {
      report() {}
    };
    const token = new CancellationToken();
    try {
      return await task(progress, token);
    } finally {
      hostNotify('PROGRESS_END', { owner, title });
    }
  },
  createOutputChannel(name) {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : null;
    return makeOutputChannel(owner, name);
  },
  createStatusBarItem(arg1, arg2) {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : null;
    if (typeof arg1 === 'string') {
      return makeStatusItem(owner, arg1, 1, 0);
    }
    return makeStatusItem(owner, undefined, arg1, arg2);
  },
  showTextDocument(document) {
    return hostRequest('showTextDocument', { owner: currentOwner(), uri: document?.uri?.toString?.()?.slice(0, 4096) ?? '' }, 5000).then(() => undefined);
  },
  showOpenDialog() {
    unsupported('window.showOpenDialog');
  },
  showSaveDialog() {
    unsupported('window.showSaveDialog');
  },
  createTerminal() {
    unsupported('window.createTerminal (terminal access needs approval)');
  },
  onDidChangeActiveTextEditor(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Editor listener is not valid.');
    }
    return window.__emitterActiveEditor.event(listener);
  },
  onDidChangeVisibleTextEditors() {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : null;
    const disposable = { dispose() {} };
    if (owner !== null) {
      trackDisposable(owner, disposable);
    }
    return disposable;
  },
  /** Host/test emitter (not part of the VS Code surface). */
  __emitterActiveEditor: new EventEmitter()
};

// ---------------------------------------------------------------------------
// languages (owner-scoped provider registries)
// ---------------------------------------------------------------------------

const captured = {
  documentFormatter: null,
  rangeFormatter: null
};

const documentFormatters = [];
const rangeFormatters = [];
const codeActionProviders = [];
const completionProviders = [];
const hoverProviders = [];
const definitionProviders = [];
const referenceProviders = [];
const documentSymbolProviders = [];
const workspaceSymbolProviders = [];
const renameProviders = [];
const signatureHelpProviders = [];
const codeLensProviders = [];
const documentLinkProviders = [];
const documentHighlightProviders = [];
const foldingRangeProviders = [];
const selectionRangeProviders = [];
const inlayHintsProviders = [];
const documentColorProviders = [];
const callHierarchyProviders = [];
const typeHierarchyProviders = [];

function validateSelector(selector) {
  if (typeof selector === 'string') {
    if (selector === '' || selector.length > 256) {
      throw new Error('Language selector is not valid.');
    }
    return selector;
  }
  if (Array.isArray(selector)) {
    if (selector.length > 32) {
      throw new Error('Language selector is not valid.');
    }
    return selector;
  }
  if (selector !== null && typeof selector === 'object') {
    return selector;
  }
  throw new Error('Language selector is not valid.');
}

function registerProvider(list, method, selector, provider, methodName) {
  const owner = requireActiveOwner(method);
  const validatedSelector = validateSelector(selector);
  if (provider === null || typeof provider !== 'object' || typeof provider[methodName] !== 'function') {
    throw new Error(`${methodName} provider is not valid.`);
  }
  if (countOwned(list, owner) >= MAX_PROVIDERS_PER_EXTENSION) {
    throw new Error('Too many language providers are registered.');
  }
  const entry = { owner, selector: validatedSelector, provider };
  list.push(entry);
  const disposable = {
    dispose() {
      const index = list.indexOf(entry);
      if (index !== -1) {
        list.splice(index, 1);
      }
    }
  };
  return trackDisposable(owner, disposable);
}

function copyProviders(list) {
  return [...list];
}

export const languages = {
  registerDocumentFormattingEditProvider(selector, provider) {
    const disposable = registerProvider(
      documentFormatters,
      'languages.registerDocumentFormattingEditProvider',
      selector,
      provider,
      'provideDocumentFormattingEdits'
    );
    const entry = documentFormatters[documentFormatters.length - 1];
    // Legacy single-capture view for the pilot path.
    captured.documentFormatter = entry;
    const inner = entry;
    const original = disposable.dispose.bind(disposable);
    disposable.dispose = () => {
      original();
      if (captured.documentFormatter === inner) {
        captured.documentFormatter = documentFormatters.length > 0 ? documentFormatters[documentFormatters.length - 1] : null;
      }
    };
    return disposable;
  },
  registerDocumentRangeFormattingEditProvider(selector, provider) {
    const disposable = registerProvider(
      rangeFormatters,
      'languages.registerDocumentRangeFormattingEditProvider',
      selector,
      provider,
      'provideDocumentRangeFormattingEdits'
    );
    const inner = rangeFormatters[rangeFormatters.length - 1];
    captured.rangeFormatter = inner;
    const original = disposable.dispose.bind(disposable);
    disposable.dispose = () => {
      original();
      if (captured.rangeFormatter === inner) {
        captured.rangeFormatter = rangeFormatters.length > 0 ? rangeFormatters[rangeFormatters.length - 1] : null;
      }
    };
    return disposable;
  },
  registerCodeActionsProvider(selector, provider) {
    return registerProvider(
      codeActionProviders,
      'languages.registerCodeActionsProvider',
      selector,
      provider,
      'provideCodeActions'
    );
  },
  registerCompletionItemProvider(selector, provider) {
    return registerProvider(
      completionProviders,
      'languages.registerCompletionItemProvider',
      selector,
      provider,
      'provideCompletionItems'
    );
  },
  registerHoverProvider(selector, provider) {
    return registerProvider(
      hoverProviders,
      'languages.registerHoverProvider',
      selector,
      provider,
      'provideHover'
    );
  },
  registerDefinitionProvider(selector, provider) {
    return registerProvider(
      definitionProviders,
      'languages.registerDefinitionProvider',
      selector,
      provider,
      'provideDefinition'
    );
  },
  registerReferenceProvider(selector, provider) {
    return registerProvider(
      referenceProviders,
      'languages.registerReferenceProvider',
      selector,
      provider,
      'provideReferences'
    );
  },
  registerDocumentSymbolProvider(selector, provider) {
    return registerProvider(
      documentSymbolProviders,
      'languages.registerDocumentSymbolProvider',
      selector,
      provider,
      'provideDocumentSymbols'
    );
  },
  registerWorkspaceSymbolProvider(provider) {
    const owner = requireActiveOwner('languages.registerWorkspaceSymbolProvider');
    if (provider === null || typeof provider !== 'object' || typeof provider.provideWorkspaceSymbols !== 'function') {
      throw new Error('provideWorkspaceSymbols provider is not valid.');
    }
    if (countOwned(workspaceSymbolProviders, owner) >= MAX_PROVIDERS_PER_EXTENSION) {
      throw new Error('Too many language providers are registered.');
    }
    const entry = { owner, selector: '*', provider };
    workspaceSymbolProviders.push(entry);
    const disposable = {
      dispose() {
        const index = workspaceSymbolProviders.indexOf(entry);
        if (index !== -1) {
          workspaceSymbolProviders.splice(index, 1);
        }
      }
    };
    return trackDisposable(owner, disposable);
  },
  registerRenameProvider(selector, provider) {
    return registerProvider(
      renameProviders,
      'languages.registerRenameProvider',
      selector,
      provider,
      'provideRenameEdits'
    );
  },
  registerSignatureHelpProvider(selector, provider) {
    return registerProvider(
      signatureHelpProviders,
      'languages.registerSignatureHelpProvider',
      selector,
      provider,
      'provideSignatureHelp'
    );
  },
  registerCodeLensProvider(selector, provider) {
    return registerProvider(
      codeLensProviders,
      'languages.registerCodeLensProvider',
      selector,
      provider,
      'provideCodeLenses'
    );
  },
  registerDocumentLinkProvider(selector, provider) {
    return registerProvider(
      documentLinkProviders,
      'languages.registerDocumentLinkProvider',
      selector,
      provider,
      'provideDocumentLinks'
    );
  },
  registerDocumentHighlightProvider(selector, provider) {
    return registerProvider(
      documentHighlightProviders,
      'languages.registerDocumentHighlightProvider',
      selector,
      provider,
      'provideDocumentHighlights'
    );
  },
  registerFoldingRangeProvider(selector, provider) {
    return registerProvider(
      foldingRangeProviders,
      'languages.registerFoldingRangeProvider',
      selector,
      provider,
      'provideFoldingRanges'
    );
  },
  registerSelectionRangeProvider(selector, provider) {
    return registerProvider(
      selectionRangeProviders,
      'languages.registerSelectionRangeProvider',
      selector,
      provider,
      'provideSelectionRanges'
    );
  },
  registerInlayHintsProvider(selector, provider) {
    return registerProvider(
      inlayHintsProviders,
      'languages.registerInlayHintsProvider',
      selector,
      provider,
      'provideInlayHints'
    );
  },
  registerColorProvider(selector, provider) {
    return registerProvider(
      documentColorProviders,
      'languages.registerColorProvider',
      selector,
      provider,
      'provideDocumentColors'
    );
  },
  registerCallHierarchyProvider(selector, provider) {
    return registerProvider(
      callHierarchyProviders,
      'languages.registerCallHierarchyProvider',
      selector,
      provider,
      'prepareCallHierarchy'
    );
  },
  registerTypeHierarchyProvider(selector, provider) {
    return registerProvider(
      typeHierarchyProviders,
      'languages.registerTypeHierarchyProvider',
      selector,
      provider,
      'prepareTypeHierarchy'
    );
  },
  createDiagnosticCollection(name) {
    const owner = requireActiveOwner('languages.createDiagnosticCollection');
    if (typeof name !== 'string' || name === '' || name.length > 128) {
      throw new Error('Diagnostic collection name is not valid.');
    }
    const owned = [...diagnosticCollections.keys()].filter((key) => key.startsWith(`${owner}\0`)).length;
    if (owned >= MAX_DIAG_COLLECTIONS_PER_EXTENSION) {
      throw new Error('Too many diagnostic collections.');
    }
    const key = `${owner}\0${name}`;
    const record = { owner, name, entries: new Map() };
    diagnosticCollections.set(key, record);
    const push = () => {
      const snapshot = [];
      for (const [uri, diagnostics] of record.entries) {
        snapshot.push({ uri, diagnostics: diagnostics.map((entry) => ({ ...entry })) });
      }
      hostNotify('DIAGNOSTICS_CHANGED', { owner, collection: name.slice(0, 128), entries: snapshot.slice(0, 256) });
    };
    const collection = {
      get name() {
        return name;
      },
      set(uri, diagnostics) {
        const uriString = uri instanceof Uri ? uri.toString() : String(uri ?? '');
        if (diagnostics === undefined) {
          record.entries.delete(uriString);
          push();
          return;
        }
        if (!Array.isArray(diagnostics)) {
          throw new Error('Diagnostics are not valid.');
        }
        if (diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
          throw new Error('Too many diagnostics for this file.');
        }
        let total = 0;
        for (const entries of record.entries.values()) {
          total += entries.length;
        }
        if (total + diagnostics.length > MAX_DIAGNOSTICS_PER_EXTENSION) {
          throw new Error('Too many diagnostics for this extension.');
        }
        const normalized = [];
        for (const diagnostic of diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
          if (!(diagnostic instanceof Diagnostic)) {
            throw new Error('Diagnostics are not valid.');
          }
          normalized.push({
            range: toSerializableRange(diagnostic.range),
            severity: diagnostic.severity,
            message: String(diagnostic.message).slice(0, 2048),
            source: diagnostic.source === undefined ? undefined : String(diagnostic.source).slice(0, 128),
            code: diagnostic.code === undefined ? undefined : String(diagnostic.code).slice(0, 128)
          });
        }
        record.entries.set(uriString, normalized);
        push();
      },
      delete(uri) {
        const uriString = uri instanceof Uri ? uri.toString() : String(uri ?? '');
        record.entries.delete(uriString);
        push();
      },
      clear() {
        record.entries.clear();
        push();
      },
      dispose() {
        diagnosticCollections.delete(key);
        push();
      }
    };
    return trackDisposable(owner, collection);
  },
  createLanguageStatusItem() {
    const owner = typeof activeExtensionId === 'string' ? activeExtensionId : null;
    return makeStatusItem(owner, undefined, 2, 0);
  },
  match() {
    unsupported('languages.match');
  },
  getLanguages() {
    return [];
  },
  /** Test/host introspection only: captured registrations (legacy view). */
  __captured: captured,
  /** Host introspection: all document formatters with owners. */
  __getDocumentFormatters() {
    return copyProviders(documentFormatters);
  },
  /** Host introspection: all range formatters with owners. */
  __getRangeFormatters() {
    return copyProviders(rangeFormatters);
  },
  /** Host introspection: all code-action providers with owners. */
  __getCodeActionProviders() {
    return copyProviders(codeActionProviders);
  },
  /** Host introspection: completion providers with owners. */
  __getCompletionProviders() {
    return copyProviders(completionProviders);
  },
  /** Host introspection: hover providers with owners. */
  __getHoverProviders() {
    return copyProviders(hoverProviders);
  },
  /** Host introspection: definition providers with owners. */
  __getDefinitionProviders() {
    return copyProviders(definitionProviders);
  },
  /** Host introspection: reference providers with owners. */
  __getReferenceProviders() {
    return copyProviders(referenceProviders);
  },
  /** Host introspection: document-symbol providers with owners. */
  __getDocumentSymbolProviders() {
    return copyProviders(documentSymbolProviders);
  },
  /** Host introspection: workspace-symbol providers with owners. */
  __getWorkspaceSymbolProviders() {
    return copyProviders(workspaceSymbolProviders);
  },
  /** Host introspection: rename providers with owners. */
  __getRenameProviders() {
    return copyProviders(renameProviders);
  },
  /** Host introspection: signature-help providers with owners. */
  __getSignatureHelpProviders() {
    return copyProviders(signatureHelpProviders);
  },
  /** Host introspection: code-lens providers with owners. */
  __getCodeLensProviders() {
    return copyProviders(codeLensProviders);
  },
  /** Host introspection: document-link providers with owners. */
  __getDocumentLinkProviders() {
    return copyProviders(documentLinkProviders);
  },
  /** Host introspection: highlight providers with owners. */
  __getDocumentHighlightProviders() {
    return copyProviders(documentHighlightProviders);
  },
  /** Host introspection: folding providers with owners. */
  __getFoldingRangeProviders() {
    return copyProviders(foldingRangeProviders);
  },
  /** Host introspection: selection-range providers with owners. */
  __getSelectionRangeProviders() {
    return copyProviders(selectionRangeProviders);
  },
  /** Host introspection: inlay-hint providers with owners. */
  __getInlayHintsProviders() {
    return copyProviders(inlayHintsProviders);
  },
  /** Host introspection: color providers with owners. */
  __getDocumentColorProviders() {
    return copyProviders(documentColorProviders);
  }
};

/** Host introspection: every diagnostic entry across collections. */
export function __getAllDiagnostics() {
  const out = [];
  for (const record of diagnosticCollections.values()) {
    for (const [uri, diagnostics] of record.entries) {
      out.push({ owner: record.owner, collection: record.name, uri, diagnostics: [...diagnostics] });
    }
    if (out.length >= 1024) {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Memento (extension storage, synchronous reads over host snapshots)
// ---------------------------------------------------------------------------

export class Memento {
  constructor(owner, scope, initial) {
    this.owner = owner;
    this.scope = scope;
    this.values = initial !== null && typeof initial === 'object' && !Array.isArray(initial) ? { ...initial } : {};
  }

  get(key, dflt) {
    if (typeof key !== 'string' || key === '') {
      return dflt;
    }
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : dflt;
  }

  keys() {
    return Object.keys(this.values).slice(0, 1024);
  }

  async update(key, value) {
    if (typeof key !== 'string' || key === '' || key.length > 256 || key.includes('\0')) {
      throw new Error('Storage key is not valid.');
    }
    if (value === undefined) {
      delete this.values[key];
    } else {
      const valid = value === null || typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'boolean' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
      if (!valid) {
        throw new Error('Storage value is not valid.');
      }
      this.values[key] = value;
    }
    const snapshots = extensionSnapshots.get(this.owner);
    if (snapshots !== undefined) {
      if (this.scope === 'global') {
        snapshots.globalState = { ...this.values };
      } else {
        snapshots.workspaceState = { ...this.values };
      }
    }
    // Main-owned persistence via write-through notification.
    hostNotify('STORAGE_WRITE', { owner: this.owner, scope: this.scope, key, value: value === undefined ? null : value, deleted: value === undefined });
  }
}

// ---------------------------------------------------------------------------
// extensions (normalized metadata + demand-driven activation)
// ---------------------------------------------------------------------------

export const extensions = {
  get all() {
    return [...extensionInfos.values()].map((info) => ({
      id: info.id,
      packageJSON: { ...info.packageJSON },
      isActive: info.isActive,
      exports: undefined,
      activate: () => extensions.getExtension(info.id)?.activate() ?? Promise.resolve(undefined)
    })).slice(0, 512);
  },
  getExtension(id) {
    if (typeof id !== 'string' || id === '') {
      return undefined;
    }
    const info = extensionInfos.get(id);
    if (info === undefined) {
      // Also match `<publisher>.<name>` without version.
      for (const candidate of extensionInfos.values()) {
        if (candidate.id === id || candidate.id.startsWith(`${id}@`)) {
          return extensions.getExtension(candidate.id);
        }
      }
      return undefined;
    }
    return {
      id: info.id,
      packageJSON: { ...info.packageJSON },
      isActive: info.isActive,
      exports: undefined,
      activate: async () => {
        const response = await hostRequest('activateExtension', { owner: currentOwner(), extensionId: info.id }, 10_000);
        if (response !== null && typeof response === 'object' && response.activated === true) {
          return undefined;
        }
        throw new Error(`Extension ${info.id} could not be activated.`);
      }
    };
  },
  onDidChange(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Extension listener is not valid.');
    }
    return extensions.__emitter.event(listener);
  },
  /** Host/test emitter (not part of the VS Code surface). */
  __emitter: new EventEmitter()
};

// ---------------------------------------------------------------------------
// env / tasks / debug / scm (honest subsets)
// ---------------------------------------------------------------------------

export const env = {
  appName: 'STARK',
  uiKind: 1,
  get isTelemetryEnabled() {
    return false;
  },
  get clipboard() {
    return {
      async readText() {
        const response = await hostRequest('clipboardRead', { owner: currentOwner() }, 5000);
        if (response !== null && typeof response === 'object' && typeof response.text === 'string') {
          return response.text.slice(0, 65536);
        }
        return '';
      },
      async writeText(value) {
        if (typeof value !== 'string' || value.length > 65536) {
          throw new Error('Clipboard text is not valid.');
        }
        hostNotify('CLIPBOARD_WRITE', { text: value });
      }
    };
  },
  openExternal() {
    unsupported('env.openExternal');
  }
};

export const tasks = {
  fetchTasks() {
    unsupported('tasks.fetchTasks (task execution needs approval)');
  },
  executeTask() {
    unsupported('tasks.executeTask (task execution needs approval)');
  },
  registerTaskProvider() {
    unsupported('tasks.registerTaskProvider (task execution needs approval)');
  },
  onDidStartTask() {
    unsupported('tasks.onDidStartTask');
  },
  onDidEndTask() {
    unsupported('tasks.onDidEndTask');
  }
};

export const debug = {
  startDebugging() {
    unsupported('debug.startDebugging');
  },
  registerDebugConfigurationProvider() {
    unsupported('vscode.debug');
  },
  onDidStartDebugSession() {
    unsupported('vscode.debug');
  }
};

export const scm = {
  createSourceControl() {
    unsupported('scm.createSourceControl');
  }
};

export const notebooks = {
  registerNotebookSerializer() {
    unsupported('notebooks.registerNotebookSerializer');
  }
};

export const authentication = {
  getSession() {
    unsupported('authentication.getSession');
  }
};

export const timeline = {
  createTimelineProvider() {
    unsupported('timeline.createTimelineProvider');
  }
};

/** Host: remove extension metadata (deactivation). */
export function __unregisterExtensionInfo(extensionId) {
  if (extensionInfos.delete(extensionId)) {
    extensions.__emitter.fire(undefined);
  }
}

/** Compatibility target of this shim (not a real VS Code version). */
export const version = '1.90.0';
