// Private-deployment desktop download entry (task #12, phase 3-3).
//
// Rendered in settings ONLY when deployment-info reports desktop artifacts
// from THIS deployment (private mode + populated /downloads/desktop tree).
// URLs come from the server's SERVER_URL-derived payload — never the
// browser's location — matching every other private install surface. The
// offer is hidden inside the desktop app itself (you are already running
// it; the in-app update pill owns that flow).
import { useIntl } from "react-intl";
import { Monitor } from "lucide-react";
import { useDeploymentDownloads } from "../../utils/deploymentMode";
import { isElectronDesktopShell } from "../../utils/desktopShell";

function macArch(): "arm64" | "x64" {
  // Rosetta-reported Intel on Apple Silicon still installs the x64 build
  // fine; this only picks the highlighted default.
  return /Intel|x86_64/i.test(navigator.userAgent) ? "x64" : "arm64";
}

export function DesktopDownloadSection() {
  const { formatMessage } = useIntl();
  const downloads = useDeploymentDownloads();
  const desktop = downloads?.desktop;
  if (!desktop || isElectronDesktopShell()) return null;

  const preferred = macArch();
  const links: Array<{ key: "arm64" | "x64"; url: string }> = [
    { key: preferred, url: desktop.dmg[preferred] },
    ...(preferred === "arm64" ? [{ key: "x64" as const, url: desktop.dmg.x64 }] : []),
  ];

  return (
    <div
      data-testid="desktop-download-section"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="inline-flex items-center gap-1.5 text-sm text-neutral-600">
        <Monitor size={15} />
        {formatMessage({ id: "settings.desktopDownload.title" }, { version: desktop.version })}
      </span>
      {links.map(({ key, url }) => (
        <a
          key={key}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`desktop-download-${key}`}
          className="border-2 border-black bg-white px-2.5 py-1 text-sm font-medium text-black shadow-brutal-sm transition-all hover:bg-soft-signal"
        >
          {key === "arm64"
            ? formatMessage({ id: "settings.desktopDownload.appleSilicon" })
            : formatMessage({ id: "settings.desktopDownload.intel" })}
        </a>
      ))}
      <span className="w-full text-xs text-neutral-500">
        {formatMessage({ id: "settings.desktopDownload.hint" })}
      </span>
    </div>
  );
}
