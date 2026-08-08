import type { Metadata } from 'next';
import './globals.css';

import { ThemeProvider } from '@/components/ThemeProvider';
import { THEME_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'redrob-eval',
  description:
    'Open-source LLM eval workbench: Compare shortlist, GEPA Evolve, Route dual-eval, Image prefs, and Preference (preview) — relative cost only.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `suppressHydrationWarning` because the inline script below writes `data-theme` onto
    // this element before React sees it, so the server markup and the DOM differ by
    // exactly that attribute. Scoped to <html>, so it hides nothing else.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before the stylesheet and before React: a dark-mode user must not be shown a
            white page that corrects itself a moment later, and no effect can prevent
            that, because effects run after paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css"
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
