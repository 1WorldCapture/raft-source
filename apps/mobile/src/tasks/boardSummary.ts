// One-line activity summary for a board row: "Dev · 5 minutes ago: fixed the
// build" (zh: "Dev · 5 分钟前：修好了构建"). Pure composition so the fallback
// rules — task events carry no snippet, brand-new tasks have no activity,
// system actors have no name, zh vs en punctuation — are unit-testable while
// the component stays a thin render. Relative-time strings are injected so
// tests and the device share one path (see relativeTime.ts).

import type { TaskActivity } from "./board";
import { formatRelativeTime, type RelativeTimeStrings } from "./relativeTime";

export interface BoardSummaryStrings {
  /** Summary text for task events, which carry eventType but no snippet. */
  updatedTask: string;
  /** Fallback line when the task has no latestActivity yet. */
  createdAgo: (time: string) => string;
  /** Actor label when latestActivity.actorName is null (system events). */
  systemActor: string;
}

export function boardSummaryLine(
  activity: TaskActivity | null,
  createdAt: string | null,
  locale: string | string[],
  strings: BoardSummaryStrings,
  relative: RelativeTimeStrings,
  now: () => Date = () => new Date(Date.now()),
): string | null {
  const time = formatRelativeTime(activity?.at ?? createdAt, relative, now);
  if (!time) return null;
  if (!activity) return strings.createdAgo(time);
  const actor = activity.actorName ?? strings.systemActor;
  const text = activity.snippet ?? strings.updatedTask;
  const zh = (Array.isArray(locale) ? locale : [locale]).some((l) => String(l).toLowerCase().startsWith("zh"));
  return `${actor} · ${time}${zh ? "：" : ": "}${text}`;
}
