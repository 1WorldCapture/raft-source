import { ApiError } from "./client";

export async function checkRaftHealth(origin: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/health`, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError("网络不通，确认手机能访问这台服务器", 0, null);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) as unknown : null;
  } catch {
    body = text;
  }
  const status = body && typeof body === "object" && "status" in body ? body.status : null;
  if (!response.ok || status !== "ok") {
    throw new ApiError("这个地址没有返回 Raft 的健康检查，确认它是 Raft 服务", response.status, body);
  }
}
