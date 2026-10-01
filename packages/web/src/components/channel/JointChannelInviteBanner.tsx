import { useIntl } from "react-intl";
import { useChannelStore } from "../../store/channelStore";
import { useJointChannelInviteStore } from "../../store/jointChannelInviteStore";
import { acceptJointChannelInvite, jointInviteErrorText } from "../../utils/jointChannelInvites";

export function JointChannelInviteList({
  onOpenChannel,
  allowDismiss,
}: {
  onOpenChannel: (channelId: string) => void;
  allowDismiss: boolean;
}) {
  const { formatMessage } = useIntl();
  const invites = useJointChannelInviteStore((state) => state.invites);
  const dismissedIds = useJointChannelInviteStore((state) => state.dismissedIds);
  const acceptingId = useJointChannelInviteStore((state) => state.acceptingId);
  const errors = useJointChannelInviteStore((state) => state.errors);
  const visible = allowDismiss ? invites.filter((invite) => !dismissedIds.includes(invite.id)) : invites;
  if (visible.length === 0) return null;

  const accept = async (inviteId: string) => {
    const store = useJointChannelInviteStore.getState();
    store.setAccepting(inviteId);
    store.setError(inviteId, "");
    try {
      const channelId = await acceptJointChannelInvite(inviteId);
      store.remove(inviteId);
      if (channelId) {
        await useChannelStore.getState().ensureChannel(channelId);
        onOpenChannel(channelId);
      }
    } catch (err) {
      useJointChannelInviteStore.getState().setAccepting(null);
      useJointChannelInviteStore.getState().setError(
        inviteId,
        jointInviteErrorText(err, formatMessage({ id: "channel.jointInvite.failed" })),
      );
    }
  };

  return (
    <div className="space-y-2" data-testid={allowDismiss ? "joint-invite-banner" : "joint-invite-settings-list"}>
      {visible.map((invite) => {
        const busy = acceptingId === invite.id;
        const error = errors[invite.id];
        return (
          <div key={invite.id} className="space-y-1.5" data-testid="joint-invite-item">
            <p className="text-xs font-bold text-black">
              {formatMessage(
                { id: "channel.jointInvite.banner" },
                { server: invite.fromServerName, channel: invite.channelName },
              )}
            </p>
            {error ? <p className="text-[11px] font-bold text-black" data-testid="joint-invite-error">{error}</p> : null}
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy}
                data-testid="joint-invite-accept"
                className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs disabled:opacity-50"
                onClick={() => void accept(invite.id)}
              >
                {busy
                  ? formatMessage({ id: "channel.jointInvite.accepting" })
                  : formatMessage({ id: "channel.jointInvite.accept" })}
              </button>
              {allowDismiss ? (
                <button
                  type="button"
                  disabled={busy}
                  data-testid="joint-invite-later"
                  className="btn-brutal-sm bg-white px-2 py-1 text-xs disabled:opacity-50"
                  onClick={() => useJointChannelInviteStore.getState().dismiss(invite.id)}
                >
                  {formatMessage({ id: "channel.jointInvite.later" })}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function JointChannelInviteBanner({
  onOpenChannel,
}: {
  onOpenChannel: (channelId: string) => void;
}) {
  const invites = useJointChannelInviteStore((state) => state.invites);
  const dismissedIds = useJointChannelInviteStore((state) => state.dismissedIds);
  const visible = invites.some((invite) => !dismissedIds.includes(invite.id));
  if (!visible) return null;
  return (
    <div className="shrink-0 border-b-2 border-black bg-soft-signal px-3 py-2">
      <JointChannelInviteList onOpenChannel={onOpenChannel} allowDismiss />
    </div>
  );
}
