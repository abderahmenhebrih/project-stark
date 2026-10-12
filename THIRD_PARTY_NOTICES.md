# Third-Party Notices

This file records third-party assets redistributed with STARK.
STARK's own application license is unchanged by these notices.

---

## vscode-icons file and folder icons (MIT)

- **Source project:** vscode-icons — file and folder icon theme for Visual Studio Code
- **Repository:** https://github.com/vscode-icons/vscode-icons
- **License:** MIT License, Copyright (c) 2016 Roberto Huertas.
  Permission is granted to use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell copies of the Software, subject
  to including the copyright and permission notice. The full license
  text ships upstream at `LICENSE` in the source repository.
- **How the assets are used:** ten static SVG files were copied
  verbatim (no recoloring, no filters) into
  `src/renderer/src/assets/file-icons/` and are bundled with the
  renderer at build time. They load from packaged local assets only;
  STARK fetches nothing at runtime and works offline.
- **Exact icon assets used** (upstream names in `icons/`, local names
  in `src/renderer/src/assets/file-icons/`):

| Upstream file                | Local file        | Used for                                   |
| ---------------------------- | ----------------- | ------------------------------------------ |
| `default_folder.svg`         | `folder.svg`      | collapsed directories, project/folder CTA |
| `default_folder_opened.svg`  | `folder-open.svg` | expanded directories                       |
| `default_file.svg`           | `file.svg`        | generic fallback for unknown file types    |
| `file_type_markdown.svg`     | `markdown.svg`    | `.md` / `.markdown` (incl. README/AGENTS/CLAUDE) |
| `file_type_js.svg`           | `javascript.svg`  | `.js` / `.mjs` / `.cjs` / `.jsx`           |
| `file_type_typescript.svg`   | `typescript.svg`  | `.ts` / `.tsx` / `.mts` / `.cts` / `.d.ts` / `tsconfig*.json` |
| `file_type_json.svg`         | `json.svg`        | `.json` / `.jsonc`                         |
| `file_type_git.svg`          | `git.svg`         | `.gitignore` / `.gitattributes`            |
| `file_type_config.svg`       | `config.svg`      | dotfiles and config formats (`.env`, `.yaml`, `.toml`, …) |
| `file_type_npm.svg`          | `package.svg`     | `package.json` / `package-lock.json`       |

- **Trademark note:** the npm "N" mark (`package.svg`, upstream
  `file_type_npm.svg`) is a trademark of npm, Inc. It is reused here
  under the upstream repository's MIT grant solely to identify npm
  package manifests in the file explorer. The JavaScript/TypeScript
  letterform variants used here are the icon theme's own
  non-boxed renditions, chosen over the boxed official-logo variants.
- **STARK application license:** unchanged. These notices cover only
  the listed icon assets.

---

## yauzl ZIP reader (MIT)

- **Source project:** yauzl — a Node.js ZIP reader with lazy entry
  access used only to inspect and stream validated VSIX archives.
- **Repository:** https://github.com/thejoshwolfe/yauzl
- **License:** MIT License. The full license text ships in the
  installed package (`node_modules/yauzl/LICENSE`).
- **How the library is used:** declared as a direct runtime dependency
  (`yauzl`, MIT) plus type declarations (`@types/yauzl`, dev only).
  The main-process extension installer opens downloaded VSIX files
  with lazy entries, validates every entry name/mode/size before
  extracting, and streams file bytes through hard caps. No archive
  is ever trusted: traversal, absolute, drive-letter, symlink, and
  oversize entries are rejected.
- **STARK application license:** unchanged. This notice covers only
  the listed library.

---

## Code OSS extension-host architecture concepts (MIT)

- **Source project:** microsoft/vscode — Code - OSS (MIT License,
  Copyright (c) 2015 Microsoft Corporation).
- **Repository:** https://github.com/microsoft/vscode
- **Compatibility pin audited against:** 1.90.0
  (`src/main/extension-host/code-oss-compat.ts`).
- **Files/components reusing Code OSS concepts:** the isolated
  Node extension host (`src/main/extension-host/extension-host-manager.ts`),
  the generic activation pipeline (`generic-host.mjs`,
  `extension-activation-service.ts`, `extension-activation-events.ts`),
  the MainThread/ExtHost-style RPC split (`protocol.ts`,
  `HOST_REQUEST` / `HOST_NOTIFY`), extension manifest processing and
  contribution points (`extension-manifest.ts`,
  `extension-contributions.ts`), and the Code-OSS-compatible `vscode`
  API surface (`vscode-shim.mjs`: commands, workspace, window,
  languages, authentication, terminals, webviews, custom editors,
  filesystem providers, diagnostics, tasks, debug seams, tests,
  notebooks seams, SCM, configuration, chat/language-model seams,
  URI, EventEmitter, Disposable).
- **How the concepts are used:** clean-room TypeScript/JavaScript
  adapters at STARK boundaries shaped for behavior equivalence —
  no proprietary Microsoft VS Code product assets, Visual Studio
  Marketplace integration, Microsoft branding, proprietary built-in
  extensions, or closed components are copied. STARK uses Open VSX
  as the default public extension registry.
- **Modifications:** STARK safety boundaries differ intentionally
  (review-before-write for workspace edits, sandboxed filesystem
  scope, hardened terminal host, isolated per-provider auth storage,
  main-owned secrets, no proposed-API bypass, no private-API fakes).
- **STARK application license:** unchanged. This notice covers only
  the reused Code OSS architecture concepts under their MIT grant.
