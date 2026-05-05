/**
 * SDK-version compatibility helper.
 *
 * @module @openclaw/plugin-sdk/lkg/compat
 */

/**
 * Compare a tracker-declared SDK version against the host's version.
 * Major mismatch is a hard incompatibility; minor/patch is fine
 * (additive changes by semver convention).
 *
 * Returns `null` if compatible, or a human-readable warning string
 * if not. The host decides whether to refuse registration or merely
 * log.
 */
export function checkSdkCompat(
  hostVersion: string,
  trackerRequires: string,
): string | null {
  const hostMajor = hostVersion.split('.')[0];
  const trackerMajor = trackerRequires.split('.')[0];
  if (hostMajor !== trackerMajor) {
    return `LKG SDK major version mismatch: host=${hostVersion}, tracker requires=${trackerRequires}`;
  }
  return null;
}
