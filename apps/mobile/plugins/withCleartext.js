const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Android's network security config can name hosts, not a CIDR such as 100.64.0.0/10.
// Tailscale MagicDNS (*.ts.net) and loopback are the cleartext exceptions.
const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">ts.net</domain>
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
`;

function withTailnetCleartext(config) {
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "network_security_config.xml"), NETWORK_SECURITY_CONFIG);
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$["android:usesCleartextTraffic"] = "false";
    app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return cfg;
  });
}

module.exports = withTailnetCleartext;
