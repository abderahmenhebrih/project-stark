import type { LocalProfile } from '../../../shared/profile/types'

/**
 * Explicit renderer boot state. The main shell never renders before the
 * profile load resolves, so first launch shows onboarding — never a
 * flash of the greeting shell.
 */
export type BootState = 'loading' | 'onboarding' | 'ready' | 'error'

/**
 * Pure boot decision: loading dominates while the profile request is in
 * flight, a load failure is an error, otherwise profile presence decides
 * between the main shell and onboarding. No React imports — unit-tested
 * with the Node runner like the main-process modules.
 */
export function resolveBootState(args: {
  loading: boolean
  profile: LocalProfile | null
  loadError: boolean
}): BootState {
  if (args.loading) {
    return 'loading'
  }
  if (args.loadError) {
    return 'error'
  }
  return args.profile === null ? 'onboarding' : 'ready'
}
