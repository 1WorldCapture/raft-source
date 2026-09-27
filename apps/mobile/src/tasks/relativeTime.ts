// Mobile-local relative-time formatter (task #2 board rows).
//
// Deliberately NOT imported from packages/web: the web helper pulls the
// @botiverse/raft-shared package ROOT, whose `.js`-suffixed imports the
// mobile expo export cannot resolve (mobile only ever imports specific
// shared files — see apps/mobile/tsconfig.json paths). Same output contract
// as the web helper: minute/hour/day buckets via Intl.RelativeTimeFormat
// with numeric:"auto", plus the 盘古之白 rule — a space between ASCII digits
// and CJK in zh ("5分钟前" → "5 分钟前"). `now` is injectable for tests.

export function formatRelativeTime(
  value: string | null | undefined,
  locale: string | string[],
  now: () => Date = () => new Date(Date.now()),
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - now().getTime();
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let rendered: string;
  if (absMs < hour) rendered = rtf.format(Math.round(diffMs / minute), "minute");
  else if (absMs < day) rendered = rtf.format(Math.round(diffMs / hour), "hour");
  else rendered = rtf.format(Math.round(diffMs / day), "day");
  return isZhLocale(locale) ? zhMixedScriptSpacing(rendered) : rendered;
}

function isZhLocale(locale: string | string[]): boolean {
  return (Array.isArray(locale) ? locale : [locale]).some((l) => String(l).toLowerCase().startsWith("zh"));
}

/** Insert a space between ASCII digits and CJK ("5分钟后" -> "5 分钟后"). */
function zhMixedScriptSpacing(value: string): string {
  return value
    .replace(/(\d)\s*([一-鿿㐀-䶿])/g, "$1 $2")
    .replace(/([一-鿿㐀-䶿])\s*(\d)/g, "$1 $2");
}
