// The home the built-in Computer host will control, computed WITHOUT creating the host. Launch-time migration
// recovery runs before the host exists and must look at the same home the host later picks: a saved deployment
// selection (socket-safe), else the environment/default home. `resolveRaftHome()` alone ignores the selection.
import { readDeploymentSelection } from "./deploymentConnection.js";
import { chooseSocketSafeHome } from "./socketSafeHome.js";

export async function resolveEmbeddedHome(deps: {
  storageDirectory: string;
  configuredOrigin: string;
  defaultHome: () => string;
  readSelection?: typeof readDeploymentSelection;
  socketSafe?: typeof chooseSocketSafeHome;
}): Promise<string> {
  try {
    const selected = await (deps.readSelection ?? readDeploymentSelection)(deps.storageDirectory, deps.configuredOrigin);
    if (selected) return (deps.socketSafe ?? chooseSocketSafeHome)(selected).home;
  } catch {
    // An unreadable selection is reported by the host itself; recovery falls back to the default home.
  }
  return deps.defaultHome();
}
