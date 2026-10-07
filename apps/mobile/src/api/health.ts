import { ApiError } from "./client";
import { mobileEn } from "../i18n/catalog";

export async function checkRaftHealth(origin: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/health`, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError(mobileEn["mobile.health.offline"], 0, null);
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
    throw new ApiError(mobileEn["mobile.health.notRaft"], response.status, body);
  }
}
