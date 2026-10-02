// Explicit recovery uses a fresh root and its own device authorization. Never
// migrate credentials or attachments from an unrelated Computer deployment.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { userSessionPath } from "@botiverse/raft-computer/lib";
import { checkSessionOrigin } from "./sessionOriginGuard.js";

export interface DeploymentConnectionPlan {
  currentOrigin: string;
  targetOrigin: string;
  currentHome: string;
  storageDirectory: string;
  connections: string[];
  targetUserId?: string;
}

export async function readDeploymentSelection(directory: string, origin: string): Promise<string | null> {
  try {
    const selected = JSON.parse(await readFile(path.join(directory, "selected-root.json"), "utf8")) as { home?: unknown; origin?: unknown };
    if (!selected || typeof selected.origin !== "string" || typeof selected.home !== "string" ||
      !path.isAbsolute(selected.home) || !path.resolve(selected.home).startsWith(path.resolve(directory) + path.sep)) {
      throw new SyntaxError("桌面 Computer 状态目录选择无效，请重新连接当前部署。");
    }
    if (selected.origin !== origin) return null;
    return selected.home;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function connectDeployment(plan: DeploymentConnectionPlan, deps: {
  confirm(plan: DeploymentConnectionPlan): Promise<boolean>;
  authenticate(home: string, origin: string): Promise<void>;
  signal?: AbortSignal;
}): Promise<string | null> {
  // No files or credentials change before the user confirms.
  deps.signal?.throwIfAborted();
  if (!(await deps.confirm(plan))) return null;
  deps.signal?.throwIfAborted();
  let selected: string | null = null;
  try { selected = await readDeploymentSelection(plan.storageDirectory, plan.targetOrigin); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  if (selected && (await checkSessionOrigin(selected, plan.targetOrigin)).status === "ok") {
    const session = JSON.parse(await readFile(userSessionPath(selected), "utf8")) as { userId?: unknown; accessToken?: unknown; refreshToken?: unknown };
    if (typeof session.accessToken === "string" && session.accessToken.length > 0 &&
      typeof session.refreshToken === "string" && session.refreshToken.length > 0 &&
      (!plan.targetUserId || session.userId === plan.targetUserId)) {
      deps.signal?.throwIfAborted();
      return selected;
    }
  }
  await mkdir(plan.storageDirectory, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(path.join(plan.storageDirectory, "computer-"));
  let committed = false;
  const selection = path.join(plan.storageDirectory, "selected-root.json");
  const temporarySelection = `${selection}.${process.pid}.tmp`;
  try {
    await deps.authenticate(home, plan.targetOrigin);
    deps.signal?.throwIfAborted();
    const check = await checkSessionOrigin(home, plan.targetOrigin);
    const authorized = JSON.parse(await readFile(userSessionPath(home), "utf8")) as { userId?: unknown };
    if (plan.targetUserId && authorized.userId !== plan.targetUserId) throw new Error("Computer 授权账号与当前桌面账号不同，原状态已保留，请用当前账号重新认证。");
    if (check.status !== "ok") throw new Error("设备认证未返回当前部署的有效登录信息，原 Computer 状态已保留。");
    deps.signal?.throwIfAborted();
    await writeFile(temporarySelection, JSON.stringify({ origin: plan.targetOrigin, home }), { mode: 0o600 });
    deps.signal?.throwIfAborted();
    await rename(temporarySelection, selection);
    committed = true;
    return home;
  } finally {
    await rm(temporarySelection, { force: true }).catch(() => {});
    if (!committed) await rm(home, { recursive: true, force: true });
  }
}
