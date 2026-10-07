/** Save a composer draft 250ms after typing pauses, and never later than 3s into a burst. */
export class DraftScheduler {
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly save: (value: string) => void,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly cancelTimer: (id: ReturnType<typeof setTimeout>) => void = clearTimeout,
    private readonly delayMs = 250,
    private readonly maxWaitMs = 3000,
  ) {}

  update(value: string, now = Date.now()) {
    if (this.startedAt === null) this.startedAt = now;
    const wait = Math.max(0, Math.min(this.delayMs, this.startedAt + this.maxWaitMs - now));
    if (this.timer) this.cancelTimer(this.timer);
    this.timer = this.schedule(() => {
      this.startedAt = null;
      this.timer = null;
      this.save(value);
    }, wait);
  }

  dispose() {
    if (this.timer) this.cancelTimer(this.timer);
    this.timer = null;
    this.startedAt = null;
  }
}

export function draftKey(channelId: string): string {
  return `raft.draft.${channelId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export async function loadDraft(channelId: string): Promise<string> {
  const SecureStore = await import("expo-secure-store");
  const value = await SecureStore.getItemAsync(draftKey(channelId)).catch(() => null);
  return value ?? "";
}

export async function persistDraft(channelId: string, value: string): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  const key = draftKey(channelId);
  if (!value) await SecureStore.deleteItemAsync(key).catch(() => undefined);
  else await SecureStore.setItemAsync(key, value).catch(() => undefined);
}
