import configUrl from '../../assets/file-icons/config.svg'
import fileUrl from '../../assets/file-icons/file.svg'
import folderOpenUrl from '../../assets/file-icons/folder-open.svg'
import folderUrl from '../../assets/file-icons/folder.svg'
import gitUrl from '../../assets/file-icons/git.svg'
import javascriptUrl from '../../assets/file-icons/javascript.svg'
import jsonUrl from '../../assets/file-icons/json.svg'
import markdownUrl from '../../assets/file-icons/markdown.svg'
import packageUrl from '../../assets/file-icons/package.svg'
import typescriptUrl from '../../assets/file-icons/typescript.svg'
import type { FileIconKind } from './fileIconForName'

/**
 * Local vscode-icons asset URLs for the explorer tree (see
 * THIRD_PARTY_NOTICES.md). Vite bundles these SVGs into the packaged
 * renderer output, so the explorer works fully offline — no CDN, no
 * marketplace dependency, no runtime fetch. Every FileIconKind has
 * exactly one entry here; the node test project never imports this
 * module (it exercises the pure `getFileIconKind` mapping instead).
 */
export const FILE_ICON_URLS: Record<FileIconKind, string> = {
  markdown: markdownUrl,
  javascript: javascriptUrl,
  typescript: typescriptUrl,
  json: jsonUrl,
  package: packageUrl,
  git: gitUrl,
  config: configUrl,
  document: fileUrl
}

export const FOLDER_ICON_URL = folderUrl
export const FOLDER_OPEN_ICON_URL = folderOpenUrl
