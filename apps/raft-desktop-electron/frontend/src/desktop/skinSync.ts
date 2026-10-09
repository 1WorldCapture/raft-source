// Account sync for the desktop skin (#mobile-skin task #2).
//
// The account's `preferredSkin` (server) and this device's localStorage value
// are reconciled like this:
//   - first paint ALWAYS uses the local value (initSkin) - no flash, offline works;
//   - after login the server value wins when it is a known skin id: apply it and
//     remember it locally;
//   - no server value: keep the local pick and write it to the account ONCE (only
//     if the user actually picked one on this device), so other devices get it;
//   - a user pick is written locally AND to the account (PATCH /auth/me); when
//     that fails (offline) a pending flag remembers it and the local pick wins
//     until it is written (retry on login, `online`, or the next pick).

export interface SkinSyncStorage {
  getPending(): boolean;
  setPending(value: boolean): void;
}

export interface SkinSyncDeps {
  storage: SkinSyncStorage;
  isKnown(id: string): boolean;
  /** The skin the user picked on THIS device (null when never chosen). */
  localExplicit(): string | null;
  /** The skin currently applied. */
  current(): string;
  /** Apply + remember a skin that came from the account; must not count as a user pick. */
  adopt(id: string): void;
  /** PATCH /auth/me { preferredSkin }. Rejects when the account cannot be reached. */
  push(id: string): Promise<void>;
}

export function createSkinSync(deps: SkinSyncDeps) {
  const { storage } = deps;
  let inFlight: Promise<void> | null = null;

  async function push(id: string): Promise<void> {
    storage.setPending(true);
    try {
      await deps.push(id);
      // A newer pick may have been made meanwhile; only clear when the account has the latest.
      if (deps.localExplicit() === id) storage.setPending(false);
    } catch {
      // Offline or server error: stays pending, retried later.
    }
  }

  function serialized(task: () => Promise<void>): Promise<void> {
    const next = (inFlight ?? Promise.resolve()).then(task);
    inFlight = next.catch(() => undefined);
    return next;
  }

  return {
    /** Account became known (login / session restore). `serverSkin` is user.preferredSkin. */
    onLogin(serverSkin: string | null | undefined): Promise<void> {
      return serialized(async () => {
        const local = deps.localExplicit();
        if (storage.getPending() && local && deps.isKnown(local)) {
          await push(local); // an offline pick is newer than whatever the account has
          return;
        }
        if (serverSkin && deps.isKnown(serverSkin)) {
          if (serverSkin !== deps.current() || serverSkin !== local) deps.adopt(serverSkin);
          return;
        }
        if (local && deps.isKnown(local)) await push(local); // first time this account has a skin
      });
    },

    /** The user picked a skin in the switcher (already applied + stored locally). */
    onUserPick(id: string): Promise<void> {
      return serialized(() => push(id));
    },

    /** Connectivity came back: write a pick that could not be written earlier. */
    onOnline(): Promise<void> {
      return serialized(async () => {
        const local = deps.localExplicit();
        if (storage.getPending() && local && deps.isKnown(local)) await push(local);
      });
    },

    /** The account's value changed while running (e.g. another device, a refreshed profile). */
    onServerValue(serverSkin: string | null | undefined): void {
      if (storage.getPending()) return; // our own unsent pick wins
      if (serverSkin && deps.isKnown(serverSkin) && serverSkin !== deps.current()) deps.adopt(serverSkin);
    },
  };
}
