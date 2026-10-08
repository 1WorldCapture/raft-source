const { withAppBuildGradle } = require("expo/config-plugins");

// Release signing reads a properties file outside the repo. The file is never
// committed. Without RAFT_ANDROID_KEYSTORE_PROPERTIES, release keeps the debug
// keystore so a normal prebuild still runs.
const RELEASE_SIGNING = `        release {
            def propsFile = System.getenv("RAFT_ANDROID_KEYSTORE_PROPERTIES")
            if (propsFile != null && !propsFile.isEmpty()) {
                def props = new Properties()
                def propsPath = new File(propsFile)
                if (!propsPath.isAbsolute()) {
                    throw new GradleException("RAFT_ANDROID_KEYSTORE_PROPERTIES must be an absolute path")
                }
                propsPath.withInputStream { props.load(it) }
                storeFile file(props.getProperty("storeFile"))
                storePassword props.getProperty("storePassword")
                keyAlias props.getProperty("keyAlias")
                keyPassword props.getProperty("keyPassword")
            }
        }
`;

function withReleaseKeystore(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (contents.includes("RAFT_ANDROID_KEYSTORE_PROPERTIES")) return cfg;
    if (!contents.includes("signingConfigs {")) {
      throw new Error("app/build.gradle has no signingConfigs block");
    }
    contents = contents.replace("signingConfigs {", `signingConfigs {\n${RELEASE_SIGNING}`);
    const releaseBlock = /release \{\s*(?:\/\/[^\n]*\n\s*)*signingConfig signingConfigs\.debug/;
    if (!releaseBlock.test(contents)) {
      throw new Error("app/build.gradle release signingConfig was not the expected debug fallback");
    }
    contents = contents.replace(
      releaseBlock,
      (match) => match.replace("signingConfig signingConfigs.debug", "signingConfig System.getenv(\"RAFT_ANDROID_KEYSTORE_PROPERTIES\") ? signingConfigs.release : signingConfigs.debug"),
    );
    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = withReleaseKeystore;
