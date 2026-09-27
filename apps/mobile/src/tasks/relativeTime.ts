// Mobile-local relative-time formatter (task #2 board rows).
//
// Deliberately NOT imported from packages/web (the web helper pulls the
// @botiverse/raft-shared package ROOT, whose `.js`-suffixed imports the
// mobile expo export cannot resolve), and deliberately NOT using
// Intl.RelativeTimeFormat: Hermes on Android implements only Collator,
// DateTimeFormat, and NumberFormat, so the RTF constructor would throw and
// take the whole tasks page down. Instead the strings come from the i18n
// catalog through react-intl's ICU plural (PluralRules is polyfilled in
// apps/mobile/index.js), injected as a plain object so unit tests and the
// device run the exact same path.

export interface RelativeTimeStrings {
  /** Future timestamps and anything under a minute (also absorbs clock skew). */
  justNow: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
}

/** Build the strings from any intl-style `format(id, values)` (react-intl's t). */
export function relativeTimeStrings<T extends string>(format: (id: T, values?: Record<string, string | number>) => string): RelativeTimeStrings {
  return {
    justNow: format("mobile.time.justNow" as T),
    minutesAgo: (n) => format("mobile.time.minutesAgo" as T, { n }),
    hoursAgo: (n) => format("mobile.time.hoursAgo" as T, { n }),
    daysAgo: (n) => format("mobile.time.daysAgo" as T, { n }),
  };
}

export function formatRelativeTime(
  value: string | null | undefined,
  strings: RelativeTimeStrings,
  now: () => Date = () => new Date(Date.now()),
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = now().getTime() - date.getTime();
  if (diffMs < 60_000) return strings.justNow;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return strings.minutesAgo(minutes);
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 24) return strings.hoursAgo(hours);
  return strings.daysAgo(Math.round(diffMs / 86_400_000));
}
