'use client';

/**
 * An inline script that runs while the browser parses the HTML.
 *
 * The type flips to `text/plain` in the browser because React never executes a
 * script it creates during a client render; leaving it executable there would
 * only earn a dev warning while doing nothing. `suppressHydrationWarning`
 * covers the resulting type mismatch.
 *
 * A Client Component on purpose: a Server Component renders once, on the
 * server, so its `typeof window` test can never come out the other way and the
 * browser would keep seeing an executable script it refuses to run.
 *
 * From the Next.js "preventing flash before hydration" guide.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
