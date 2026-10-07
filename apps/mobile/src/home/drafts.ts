/** Local composer drafts. Task #15 replaces the body of this module; the home list only asks whether a row has one. */
const drafts = new Set<string>();

export function channelHasDraft(channelId: string): boolean {
  return drafts.has(channelId);
}
