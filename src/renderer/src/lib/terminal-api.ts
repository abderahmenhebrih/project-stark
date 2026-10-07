import type { TerminalApi } from '../../../shared/terminal/types'
import { getStarkApi } from './stark-api'

/**
 * Typed accessor for the human-terminal domain API.
 * Same Electron-only availability as the bridge itself.
 */
export function getTerminalApi(): TerminalApi | undefined {
  return getStarkApi()?.terminal
}
