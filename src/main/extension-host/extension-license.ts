/**
 * Extension license metadata (main-side, pure).
 *
 * Preserves `license` field/file metadata from the manifest. Where a
 * clearly incompatible host-use restriction is detectable from obvious
 * metadata (without legal interpretation), surfaces
 * `License may restrict use outside VS Code`. STARK never bypasses or
 * patches host checks intended to enforce those licenses.
 */

export interface LicenseInfo {
  readonly licenseField: string | null
  readonly restrictsAlternateHosts: boolean
  readonly notice: string | null
}

const RESTRICTIVE_PATTERN =
  /(for use with (microsoft )?visual studio code only|only (be|to be) used (with|in) (microsoft )?visual studio( code)?|may only be used (with|in).*vs ?code|prohibited.*other.*(editor|host)|not licensed for (use in|use with) other)/i

/**
 * Inspects the license field text (pure, bounded). Returns a notice
 * only for obvious host-use restrictions; everything else is neutral.
 * Never attempts legal interpretation beyond the pattern above.
 */
export function inspectExtensionLicense(licenseField: unknown): LicenseInfo {
  if (typeof licenseField !== 'string' || licenseField === '' || licenseField.length > 512) {
    return { licenseField: null, restrictsAlternateHosts: false, notice: null }
  }
  const field = licenseField.slice(0, 512)
  if (RESTRICTIVE_PATTERN.test(field)) {
    return {
      licenseField: field,
      restrictsAlternateHosts: true,
      notice: 'License may restrict use outside VS Code'
    }
  }
  return { licenseField: field, restrictsAlternateHosts: false, notice: null }
}
