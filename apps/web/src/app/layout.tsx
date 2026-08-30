import type { Metadata } from 'next';
import './globals.css';

import { InlineScript } from '@/components/InlineScript';
import { LocaleProvider } from '@/components/LocaleProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { LOCALE_SCRIPT } from '@/lib/i18n/locale';
import { THEME_SCRIPT } from '@/lib/theme';

/**
 * Pretendard, from the same CDN and at the same pin as every other Redrob product, so the
 * type cannot shift under one of them without a commit saying so. This is the one place the
 * version is named; `--font-sans` in `globals.css` names the family it registers.
 *
 * The variable dynamic subset, specifically. It carries the whole weight axis the design
 * uses and splits the face into slices the browser fetches only when a page actually renders
 * glyphs from them, where the full file is mostly Hangul that an English screen never draws.
 */
const PRETENDARD_CSS =
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';

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
        {/* Opening the connection early matters more than usual here: the stylesheet and the
            font slices it names are two round trips to a third party before any text is in
            its real face. */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link rel="stylesheet" href={PRETENDARD_CSS} crossOrigin="anonymous" />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
