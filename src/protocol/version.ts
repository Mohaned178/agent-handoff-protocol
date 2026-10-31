/** The protocol version; every schema carries it as `schemaVersion`. The protocol stays 0.x (design doc §3). */
export const PROTOCOL_VERSION = "0.1.0";

/**
 * Whether a run recorded under protocol `version` is newer than this AHP can read: a higher major, or, while the major
 * is 0, a higher minor (0.x may break at a minor version). A newer patch, or any older version, is read: replay reads
 * fields an older ledger lacks as absent (`?? null`).
 */
export function isNewerProtocol(version: string, current: string = PROTOCOL_VERSION): boolean {
  const [major, minor] = version.split(".").map(Number);
  const [currentMajor, currentMinor] = current.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return true;
  if (major !== currentMajor) return major > currentMajor!;
  return currentMajor === 0 && minor > currentMinor!;
}
