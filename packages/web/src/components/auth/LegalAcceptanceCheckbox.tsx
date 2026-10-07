import { useDeploymentLinks } from "../../utils/deploymentMode";
import { effectiveLegalUrls } from "../../utils/legalLinks";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";

import Checkbox from "../ui/Checkbox";

export default function LegalAcceptanceCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const legalUrls = effectiveLegalUrls(useDeploymentLinks());
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <Checkbox
        size="md"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span className="leading-5 text-black/70">
        {formatMessage(
          { id: "auth.legalAcceptance.agreement" },
          {
            terms: (c: ReactNode) => (
              <a
                key="terms"
                href={legalUrls.termsUrl}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-black underline hover:text-brutal-pink"
              >
                {c}
              </a>
            ),
            privacy: (c: ReactNode) => (
              <a
                key="privacy"
                href={legalUrls.privacyUrl}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-black underline hover:text-brutal-pink"
              >
                {c}
              </a>
            ),
          },
        )}
      </span>
    </label>
  );
}
