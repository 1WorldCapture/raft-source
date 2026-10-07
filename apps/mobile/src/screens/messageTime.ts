import { normalizeTimeFormatPreference } from "@botiverse/raft-shared/src/timeFormatPreference.ts";

export interface MessageTimeOptions {
  now: Date;
  hour12?: boolean;
  timeZone?: string;
  yesterdayLabel: string;
  locale?: string;
  todayLabel?: string;
}

export function formatMessageStamp(value: string, options: MessageTimeOptions): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const current = zonedParts(date, options.timeZone);
  const now = zonedParts(options.now, options.timeZone);
  const yesterday = zonedParts(new Date(options.now.getTime() - 24 * 60 * 60 * 1000), options.timeZone);
  const time = clock(current, options.hour12 === true);
  if (current.dayKey === now.dayKey) return time;
  if (current.dayKey === yesterday.dayKey) return `${options.yesterdayLabel} ${time}`;
  if (current.year === now.year) return `${current.month}/${current.day} ${time}`;
  return `${current.year}/${current.month}/${current.day} ${time}`;
}

export function formatDayLabel(value: string, options: MessageTimeOptions): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const current = zonedParts(date, options.timeZone);
  const now = zonedParts(options.now, options.timeZone);
  const yesterday = zonedParts(new Date(options.now.getTime() - 24 * 60 * 60 * 1000), options.timeZone);
  if (current.dayKey === now.dayKey) return options.todayLabel ?? "Today";
  if (current.dayKey === yesterday.dayKey) return options.yesterdayLabel;
  return date.toLocaleDateString(options.locale ?? "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(current.year === now.year ? {} : { year: "numeric" }),
    timeZone: options.timeZone,
  });
}

function clock(parts: ZonedParts, hour12: boolean): string {
  if (!hour12) return `${parts.hour}:${parts.minute}`;
  const hour = Number(parts.hour);
  const period = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 || 12;
  return `${String(twelve).padStart(2, "0")}:${parts.minute} ${period}`;
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  dayKey: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone?: string): ZonedParts {
  const key = timeZone ?? "";
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(key, formatter);
  }
  const parts = formatter.formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return { year, month, day, hour: read("hour"), minute: read("minute"), dayKey: `${year}-${month}-${day}` };
}

/** User preference wins. Otherwise follow the locale the way the web client does. */
export function resolveHour12(preferred: unknown, locale?: string): boolean {
  const format = normalizeTimeFormatPreference(preferred);
  if (format === "12h") return true;
  if (format === "24h") return false;
  const resolved = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
  if (resolved.hour12 === false || resolved.hourCycle === "h23" || resolved.hourCycle === "h24") return false;
  return true;
}

export function resolveTimeZone(preferred: string | null | undefined): string | undefined {
  const trimmed = preferred?.trim();
  if (trimmed) return trimmed;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
