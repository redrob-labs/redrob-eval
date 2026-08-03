import type { Metadata } from 'next';
import { IBM_Plex_Sans, Syne } from 'next/font/google';
import './globals.css';

const syne = Syne({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['600', '700', '800'],
});

const plex = IBM_Plex_Sans({
  variable: '--font-body',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

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
      <body className={`${syne.variable} ${plex.variable} antialiased`}>{children}</body>
    </html>
  );
}
