import { useMemo, type ReactNode } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { getLocales } from "expo-localization";
import { useSession } from "../state/session";
import { messagesFor, resolveLocale, type AppMessageId } from "./catalog";

export function LocaleProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const preferred = session.user?.displayLanguage;
  const system = getLocales()[0]?.languageTag ?? null;
  const locale = resolveLocale(preferred, system);
  const messages = useMemo(() => messagesFor(locale), [locale]);
  return (
    <IntlProvider defaultLocale="en" locale={locale === "zh-cn" ? "zh" : "en"} messages={messages}>
      {children}
    </IntlProvider>
  );
}

export function useT() {
  const intl = useIntl();
  return (id: AppMessageId, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
}
