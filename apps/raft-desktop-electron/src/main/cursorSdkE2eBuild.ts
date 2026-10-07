// The local validation artifact must not replace itself from the production
// updater before its E2E session is complete. Production versions are unchanged.
export function isCursorSdkE2eBuild(version: string): boolean {
  return /^\d+\.\d+\.\d+-cursor-sdk\.\d+$/.test(version);
}
