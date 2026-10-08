const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// packages/shared uses TypeScript NodeNext-style imports ("./x.js" that
// actually resolve to "./x.ts"). tsc understands the mapping; Metro does
// not, so bundle-time resolution fails on shared sources. When the ORIGINAL
// ".js" request fails, retry its ".ts"/".tsx" sibling — and only for files
// inside the workspace's packages/ tree, so node_modules packages that ship
// real ".js" builds (even alongside sources) always resolve as published.
const isWorkspaceSource = (filePath) => filePath.includes("/packages/");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    if (moduleName.endsWith(".js") && isWorkspaceSource(context.originModulePath ?? context.originModule ?? "")) {
      const base = moduleName.slice(0, -3);
      for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
        try {
          return context.resolveRequest(context, candidate, platform);
        } catch {
          // try the next candidate, then rethrow the original error
        }
      }
    }
    throw error;
  }
};

module.exports = config;
