import { join } from 'node:path'

/**
 * Shared main-process locations.
 *
 * Note: every file under src/main is bundled into the single
 * out/main/index.js artifact, so __dirname is identical everywhere here.
 */

/** Vite dev-server URL when running unpackaged; undefined in production. */
export const RENDERER_DEV_URL: string | undefined = process.env['ELECTRON_RENDERER_URL']

/** Absolute directory containing the packaged renderer files. */
export const RENDERER_DIR: string = join(__dirname, '../renderer')

/** Absolute path of the packaged renderer entry document. */
export const RENDERER_ENTRY: string = join(RENDERER_DIR, 'index.html')

/** Origin of the Vite dev server, or null outside development. */
export function devServerOrigin(): string | null {
  if (RENDERER_DEV_URL === undefined || RENDERER_DEV_URL === '') {
    return null
  }
  try {
    return new URL(RENDERER_DEV_URL).origin
  } catch {
    return null
  }
}
