import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";

import type { DeploymentLinks } from "./deploymentMode";

/**
 * The effective legal URLs (task #7): official by default (PM decision —
 * license/privacy links are factual statements and stay); a private
 * deployment replaces them when the operator configured RAFT_PUBLIC_*.
 */
export function effectiveLegalUrls(links: DeploymentLinks | null): {
  termsUrl: string;
  privacyUrl: string;
} {
  return {
    termsUrl: links?.legal?.termsUrl ?? CURRENT_LEGAL_ACCEPTANCE.termsUrl,
    privacyUrl: links?.legal?.privacyUrl ?? CURRENT_LEGAL_ACCEPTANCE.privacyUrl,
  };
}
