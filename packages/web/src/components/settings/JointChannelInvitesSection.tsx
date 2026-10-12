import { Link2 } from "lucide-react";
import { useIntl } from "react-intl";
import { JointChannelInviteList } from "../channel/JointChannelInviteBanner";
import SectionHeader from "../ui/SectionHeader";
import { useJointChannelInviteStore } from "../../store/jointChannelInviteStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";

export function JointChannelInvitesSection() {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const invites = useJointChannelInviteStore((state) => state.invites);
  if (invites.length === 0) return null;

  return (
    <div className="mb-6" data-testid="joint-invite-settings">
      <SectionHeader
        className="mb-3"
        icon={<Link2 size={16} />}
        label={formatMessage({ id: "settings.jointInvites.sectionLabel" })}
        count={invites.length}
      />
      <p className="mb-2 text-xs text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "settings.jointInvites.description" })}</p>
      <div className="border theme-brutal:border-2 border-line-strong theme-brutal:border-black bg-layer-panel theme-brutal:bg-white p-3 shadow-raft-xs theme-brutal:shadow-brutal-sm">
        <JointChannelInviteList allowDismiss={false} onOpenChannel={(channelId) => nav.toChannel(channelId)} />
      </div>
    </div>
  );
}
