import { create } from "zustand";
import { fetchPendingJointChannelInvites } from "../utils/jointChannelInvites";
import type { PendingJointChannelInvite } from "../utils/jointChannelInvites";

interface JointChannelInviteState {
  serverId: string | null;
  invites: PendingJointChannelInvite[];
  dismissedIds: string[];
  acceptingId: string | null;
  errors: Record<string, string>;
  load: (serverId: string) => Promise<void>;
  dismiss: (inviteId: string) => void;
  remove: (inviteId: string) => void;
  setAccepting: (inviteId: string | null) => void;
  setError: (inviteId: string, message: string) => void;
}

let loadSeq = 0;

export const useJointChannelInviteStore = create<JointChannelInviteState>((set, get) => ({
  serverId: null,
  invites: [],
  dismissedIds: [],
  acceptingId: null,
  errors: {},
  load: async (serverId) => {
    const seq = ++loadSeq;
    if (get().serverId !== serverId) {
      set({ serverId, invites: [], dismissedIds: [], errors: {}, acceptingId: null });
    }
    try {
      const invites = await fetchPendingJointChannelInvites();
      if (seq !== loadSeq) return;
      set({ serverId, invites });
    } catch {
      if (seq !== loadSeq) return;
      set({ serverId, invites: [] });
    }
  },
  dismiss: (inviteId) => set((state) => ({
    dismissedIds: state.dismissedIds.includes(inviteId) ? state.dismissedIds : [...state.dismissedIds, inviteId],
  })),
  remove: (inviteId) => set((state) => ({
    invites: state.invites.filter((invite) => invite.id !== inviteId),
    errors: Object.fromEntries(Object.entries(state.errors).filter(([id]) => id !== inviteId)),
    acceptingId: state.acceptingId === inviteId ? null : state.acceptingId,
  })),
  setAccepting: (inviteId) => set({ acceptingId: inviteId }),
  setError: (inviteId, message) => set((state) => ({
    errors: { ...state.errors, [inviteId]: message },
  })),
}));
