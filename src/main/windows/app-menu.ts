/**
 * Native application-menu policy (single-AppChrome invariant).
 *
 * STARK renders exactly one in-window application bar: the STARK
 * AppChrome. Electron shows a default File/Edit/View/Window menu on
 * Windows/Linux when no application menu is set — `autoHideMenuBar`
 * only hides it until Alt reveals it, which reads as a second native
 * bar above STARK content. Removing the application menu on
 * Windows/Linux leaves AppChrome as the only bar and makes Alt a
 * no-op. macOS keeps the normal OS-level system menu (it never
 * renders inside STARK content).
 */

export interface NativeMenuDeps {
  readonly platform: string
  readonly setApplicationMenu: (menu: null) => void
}

/** True on platforms where the native menu must be removed. */
export function shouldRemoveNativeApplicationMenu(platform: string = process.platform): boolean {
  return platform !== 'darwin'
}

/** Removes the native application menu except on macOS. Never throws. */
export function configureNativeApplicationMenu(deps: NativeMenuDeps): void {
  if (!shouldRemoveNativeApplicationMenu(deps.platform)) {
    return
  }
  try {
    deps.setApplicationMenu(null)
  } catch {
    // Best effort: AppChrome remains the visible chrome regardless.
  }
}
