import assert from "node:assert/strict";
import { test } from "vitest";
import { buildMacosLoginCarrierSpec } from "./macosLoginCarrier.js";
import { plistsSemanticallyEqual } from "./plistCompare.js";

const spec = buildMacosLoginCarrierSpec({
  slockHome: "/Users/example/.slock",
  dispatcherPath: "/Users/example/.local/bin/raft-computer",
  userHome: "/Users/example",
  uid: 501,
});

// What `plutil -convert xml1` does to the generated definition: tab indent, keys sorted alphabetically.
const reserialized = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(spec.definition)![1]}</string>
		<key>RAFT_HOME</key>
		<string>/Users/example/.slock</string>
		<key>SLOCK_HOME</key>
		<string>/Users/example/.slock</string>
	</dict>
	<key>Label</key>
	<string>${spec.label}</string>
	<key>ProcessType</key>
	<string>Background</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/example/.local/bin/raft-computer</string>
		<string>__service</string>
		<string>--slock-home</string>
		<string>/Users/example/.slock</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>/Users/example/.slock/computer/run/service.log</string>
	<key>StandardOutPath</key>
	<string>/Users/example/.slock/computer/run/service.log</string>
</dict>
</plist>
`;

test("a re-serialized plist (tab indent, sorted keys) is the same definition", () => {
  assert.notEqual(reserialized, spec.definition);
  assert.equal(plistsSemanticallyEqual(spec.definition, reserialized), true);
});

test("a real difference is still a difference", () => {
  const other = reserialized.replace("/Users/example/.local/bin/raft-computer", "/elsewhere/raft-computer");
  assert.equal(plistsSemanticallyEqual(spec.definition, other), false);
  const extraEnv = reserialized.replace("<key>RAFT_HOME</key>", "<key>HOME</key>\n\t\t<string>/x</string>\n\t\t<key>RAFT_HOME</key>");
  assert.equal(plistsSemanticallyEqual(spec.definition, extraEnv), false, "an added HOME key (Anna's patch) is a real change");
  const reordered = reserialized.replace(
    "<string>__service</string>\n\t\t<string>--slock-home</string>",
    "<string>--slock-home</string>\n\t\t<string>__service</string>",
  );
  assert.equal(plistsSemanticallyEqual(spec.definition, reordered), false, "argument order matters");
});

test("entities are decoded and unparseable input is never considered equal", () => {
  assert.equal(plistsSemanticallyEqual("<plist><dict><key>a</key><string>x &amp; y</string></dict></plist>", "<plist><dict><key>a</key><string>x &#38; y</string></dict></plist>"), true);
  assert.equal(plistsSemanticallyEqual(spec.definition, "not a plist"), false);
  assert.equal(plistsSemanticallyEqual("<plist><dict><key>a</key><data>AAAA</data></dict></plist>", "<plist><dict><key>a</key><data>AAAA</data></dict></plist>"), true, "byte-identical text short-circuits");
  assert.equal(plistsSemanticallyEqual("<plist><dict><key>a</key><data>AAAA</data></dict></plist>", "<plist><dict><key>a</key><data>AAAB</data></dict></plist>"), false, "unsupported element types fall back to different");
});
