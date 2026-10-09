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
