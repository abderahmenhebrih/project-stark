/**
 * STARK-owned minimal VS Code compatibility shim (Prettier pilot).
 *
 * This file is the ONLY `vscode` module the Extension Host can load:
 * the host loader maps the bare `vscode` specifier here, so third-party
 * extension code can never reach a real VS Code API. Every export is
 * explicit and enumerated — there is intentionally NO Proxy and NO
 * catch-all: touching anything unlisted below throws
 * `Unsupported VS Code API: <name>` instead of silently faking it.
 *
 * Audited against the real esbenp.prettier-vscode 12.4.0 bundle
 * (`dist/extension.js`, `"type": "module"`). The bundle's named
 * `vscode` imports are exactly: commands, workspace, window, Uri,
 * Range, TextEdit, languages, CodeAction, CodeActionKind,
 * WorkspaceEdit, LanguageStatusSeverity, StatusBarAlignment,
 * ThemeColor. Activation plus one document-format call provably touch
 * only:
 *
 * - workspace.getConfiguration('prettier') (real audited defaults),
 *   onDidChangeConfiguration, createFileSystemWatcher,
 *   workspaceFolders (undefined), getWorkspaceFolder (-> undefined),
 *   isTrusted (false — see below)
 * - window.createOutputChannel, createStatusBarItem,
 *   onDidChangeActiveTextEditor, activeTextEditor (undefined)
 * - languages.registerDocumentFormattingEditProvider (captured),
 *   registerDocumentRangeFormattingEditProvider (captured),
 *   registerCodeActionsProvider, createLanguageStatusItem
 * - commands.registerCommand (captured)
 * - Uri.file/parse/joinPath + scheme/fsPath
 * - Range, TextEdit.replace, CodeActionKind.SourceFixAll.append
 *
 * Pilot trust policy (documented, mínimo): `workspace.isTrusted` is
 * false, so the extension itself neutralizes prettierPath,
 * configPath, resolveGlobalModules, useEditorConfig, and
 * withNodeModules, always uses its bundled Prettier, and skips
 * project config-file loading. Formatting therefore runs with
 * Prettier defaults (baked below from the extension's own
 * contributes.configuration). No global-module search, no workspace
 * prettier loading, no config-file execution. The host supplies the
 * real file path only for parser inference (documented in the
 * formatter service).
 *
 * Plain ESM, no imports: this module must stay dependency-free so the
 * loader mapping is trivially auditable.
 */

function unsupported(name) {
  throw new Error(`Unsupported VS Code API: ${name}`);
}

/** No-op disposable for registrations the pilot never fires. */
function disposable() {
  return { dispose() {} };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const registeredCommands = [];

export const commands = {
  registerCommand(id, handler) {
    registeredCommands.push({ id, handler });
    return disposable();
  },
  executeCommand() {
    unsupported('commands.executeCommand');
  },
  /** Test/host introspection only: ids registered by the extension. */
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

function makeConfig(values) {
  // Plain data object: the extension spreads it ({...config}) when
  // untrusted, so defaults must be own enumerable properties.
  const config = { ...values };
  config.get = (key, dflt) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : dflt);
  config.has = (key) => Object.prototype.hasOwnProperty.call(values, key);
  config.update = () => unsupported('workspace.getConfiguration().update');
  return config;
}

function makeWatcher() {
  return {
    onDidChange() {},
    onDidCreate() {},
    onDidDelete() {},
    dispose() {}
  };
}

export const workspace = {
  /** Pilot policy: untrusted, so the extension uses bundled Prettier only. */
  isTrusted: false,
  /** No workspace folders are exposed to the extension. */
  workspaceFolders: undefined,
  getWorkspaceFolder() {
    return undefined;
  },
  getConfiguration(section) {
    if (section === 'prettier') {
      return makeConfig({ ...PRETTIER_DEFAULTS });
    }
    return makeConfig({});
  },
  onDidChangeConfiguration() {
    return disposable();
  },
  createFileSystemWatcher() {
    return makeWatcher();
  },
  fs: {
    writeFile() {
      unsupported('workspace.fs.writeFile');
    },
    readFile() {
      unsupported('workspace.fs.readFile');
    },
    stat() {
      unsupported('workspace.fs.stat');
    }
  }
};

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function makeOutputChannel() {
  return {
    append() {},
    appendLine() {},
    replace() {},
    clear() {},
    show() {},
    hide() {},
    dispose() {}
  };
}

function makeStatusItem() {
  return {
    show() {},
    hide() {},
    dispose() {}
  };
}

export const window = {
  activeTextEditor: undefined,
  createOutputChannel() {
    return makeOutputChannel();
  },
  createStatusBarItem() {
    return makeStatusItem();
  },
  showInformationMessage() {
    unsupported('window.showInformationMessage');
  },
  showWarningMessage() {
    unsupported('window.showWarningMessage');
  },
  showErrorMessage() {
    unsupported('window.showErrorMessage');
  },
  showOpenDialog() {
    unsupported('window.showOpenDialog');
  },
  onDidChangeActiveTextEditor() {
    return disposable();
  }
};

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
    return new Uri(base.scheme, [base.path, ...parts].join('/'));
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
}

// ---------------------------------------------------------------------------
// Range / TextEdit
// ---------------------------------------------------------------------------

export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
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

// ---------------------------------------------------------------------------
// languages (formatter registration is captured, never exposed)
// ---------------------------------------------------------------------------

const captured = {
  documentFormatter: null,
  rangeFormatter: null
};

export const languages = {
  registerDocumentFormattingEditProvider(selector, provider) {
    captured.documentFormatter = { selector, provider };
    return disposable();
  },
  registerDocumentRangeFormattingEditProvider(selector, provider) {
    captured.rangeFormatter = { selector, provider };
    return disposable();
  },
  registerCodeActionsProvider() {
    return disposable();
  },
  createLanguageStatusItem() {
    return makeStatusItem();
  },
  match() {
    unsupported('languages.match');
  },
  /** Test/host introspection only: captured registrations. */
  __captured: captured
};

// ---------------------------------------------------------------------------
// CodeAction / WorkspaceEdit / enums
// ---------------------------------------------------------------------------

export class CodeAction {
  constructor(title) {
    this.title = title;
  }
}

export const CodeActionKind = {
  Empty: { value: '' },
  QuickFix: { value: 'quickfix' },
  Source: { value: 'source' },
  SourceFixAll: {
    value: 'source.fixAll',
    append(part) {
      return { value: `source.fixAll.${part}` };
    }
  }
};

export class WorkspaceEdit {
  constructor() {
    unsupported('WorkspaceEdit');
  }
}

export const LanguageStatusSeverity = { Information: 0, Warning: 1, Error: 2 };

export const StatusBarAlignment = { Left: 1, Right: 2 };

export class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
