import type { Metadata } from 'next';
import './globals.css';

import { InlineScript } from '@/components/InlineScript';
import { LocaleProvider } from '@/components/LocaleProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { LOCALE_SCRIPT } from '@/lib/i18n/locale';
import { THEME_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'redrob-eval',
  description:
    'Open-source LLM eval workbench: Compare shortlist, GEPA Evolve, Route dual-eval, Image prefs, and Preference (preview). Relative cost only.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `suppressHydrationWarning` because the inline scripts below write `data-theme`
    // and `lang` onto this element before React sees it, so the server markup and the
    // DOM differ by those attributes. Scoped to <html>, so it hides nothing else.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before the stylesheet and before React: a dark-mode user must not be shown a
            white page that corrects itself a moment later, and no effect can prevent
            that, because effects run after paint. */}
        <InlineScript html={THEME_SCRIPT} />
        <InlineScript html={LOCALE_SCRIPT} />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css"
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
