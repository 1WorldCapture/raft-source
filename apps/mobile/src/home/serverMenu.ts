import type { RaftServer } from "../model/messages";
import { serverInitial } from "./serverInitial";

export type ServerMenuItem = {
  id: string;
  name: string;
  initial: string;
  current: boolean;
  /** Unread count for OTHER servers only; the current one never shows unread here. */
  unread: number;
};

export type ServerMenu = {
  items: ServerMenuItem[];
  /** With a single server there is nothing to switch to: no ▾, the title is not tappable. */
  switchable: boolean;
  /** Another server has unread: the little dot next to ▾. */
  otherUnread: boolean;
};

/** View model for the top-bar server dropdown (Rethink UI, replaces the left rail). */
export function buildServerMenu(
  servers: readonly RaftServer[],
  currentId: string | null,
  unreadByServer: Record<string, number>,
): ServerMenu {
  const items = servers.map((server) => ({
    id: server.id,
    name: server.name,
    initial: serverInitial(server.name),
    current: server.id === currentId,
    unread: server.id === currentId ? 0 : Math.max(0, unreadByServer[server.id] ?? 0),
  }));
  return {
    items,
    switchable: items.length > 1,
    otherUnread: items.some((item) => item.unread > 0),
  };
}
