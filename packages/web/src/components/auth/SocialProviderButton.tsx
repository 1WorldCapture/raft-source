import { useIntl } from "react-intl";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { AppleLogo, GitHubLogo, GoogleLogo } from "../icons/ProviderLogos";

const SOCIAL_BUTTON_BASE = "flex w-full items-center justify-center gap-3 border theme-brutal:border-2 border-line-strong theme-brutal:border-black px-3 py-2 text-sm font-bold shadow-raft-xs theme-brutal:shadow-brutal-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-raft-sm theme-brutal:hover:shadow-brutal active:translate-x-[2px] active:translate-y-[2px] active:shadow-none theme-brutal:active:shadow-brutal-active";

export default function SocialProviderButton({
  providerId,
  label,
  onClick,
}: {
  providerId: SocialAuthProviderId;
  label: string;
  onClick: (providerId: SocialAuthProviderId) => void;
}) {
  const { formatMessage } = useIntl();
  const logo = providerId === "google"
    ? <GoogleLogo />
    : providerId === "github"
      ? <GitHubLogo />
      : <AppleLogo />;

  return (
    <button
      type="button"
      onClick={() => onClick(providerId)}
      className={`${SOCIAL_BUTTON_BASE} bg-layer-panel theme-brutal:bg-white text-foreground-strong theme-brutal:text-black`}
    >
      {logo}
      <span>{formatMessage({ id: "auth.social.continueWith" }, { provider: label })}</span>
    </button>
  );
}
