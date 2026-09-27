// One-line activity summary for a board row: "Dev · 5 minutes ago: fixed the
// build" (zh: "Dev · 5 分钟前：修好了构建"). Pure composition so the fallback
// rules — task events carry no snippet, brand-new tasks have no activity,
// system actors have no name, zh vs en punctuation — are unit-testable while
// the component stays a thin render.

import { formatRelativeTime } from "../../../../packages/web/src/utils/relativeTime";
import type { TaskActivity } from "./board";

export interface BoardSummaryStrings {
  /** Summary text for task events, which carry eventType but no snippet. */
  updatedTask: string;
  /** Fallback line when the task has no latestActivity yet. */
  createdAgo: (time: string) => string;
  /** Actor label when latestActivity.actorName is null (system events). */
  systemActor: string;
}

function isZhLocale(locale: string | string[]): boolean {
  return (Array.isArray(locale) ? locale : [locale]).some((l) => String(l).toLowerCase().startsWith("zh"));
}

export function boardSummaryLine(
  activity: TaskActivity | null,
  createdAt: string | null,
  locale: string | string[],
  strings: BoardSummaryStrings,
): string | null {
  const time = formatRelativeTime(activity?.at ?? createdAt, locale);
  if (!time) return null;
  if (!activity) return strings.createdAgo(time);
  const actor = activity.actorName ?? strings.systemActor;
  const text = activity.snippet ?? strings.updatedTask;
  return `${actor} · ${time}${isZhLocale(locale) ? "：" : ": "}${text}`;
}
