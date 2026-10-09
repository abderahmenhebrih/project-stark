import { FATAL_START_GUIDANCE, FATAL_START_MESSAGE, type FatalStartCategory } from './startup-failure'

/** Electron dialog surface seam (sync message box + quit). */
export interface FatalDialogSurface {
  showFatalSync(options: { title: string; message: string; detail: string }): void
  quit(): void
}

/**
 * Exactly-once fatal-startup presentation (Stage 30).
 *
 * Shows one minimal safe dialog ("STARK could not start." + category +
 * guidance) and quits. No relaunch loop, no retry button, no second
 * presentation per process no matter how many fatal paths fire.
 */
export class FatalStartupPresenter {
  private presented = false

  constructor(private readonly surface: FatalDialogSurface) {}

  /** True after the single presentation has been shown. */
  get hasPresented(): boolean {
    return this.presented
  }

  /** Shows the fatal dialog once; later calls only ensure quit. */
  presentFatal(category: FatalStartCategory): void {
    if (this.presented) {
      try {
        this.surface.quit()
      } catch {
        // Best effort: quit must never throw.
      }
      return
    }
    this.presented = true
    try {
      this.surface.showFatalSync({
        title: FATAL_START_MESSAGE,
        message: `${FATAL_START_MESSAGE} (${category})`,
        detail: FATAL_START_GUIDANCE
      })
    } catch {
      // Best effort: a dialog failure still ends in quit below.
    } finally {
      try {
        this.surface.quit()
      } catch {
        // Best effort.
      }
    }
  }
}
