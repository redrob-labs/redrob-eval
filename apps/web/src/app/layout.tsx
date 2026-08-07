import type { Metadata } from 'next';
import './globals.css';

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
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
