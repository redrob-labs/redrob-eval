import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getRepoRoot } from '@redrob/harness';

/** Serve the committed offline Evolve sample (no provider keys). */
export async function GET() {
  try {
    const file = path.join(getRepoRoot(), 'exports', 'samples', 'optimize-report.json');
    const raw = await readFile(file, 'utf8');
    return NextResponse.json(JSON.parse(raw) as unknown, {
      headers: {
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : 'Sample report missing — run yarn export:samples',
      },
      { status: 404 },
    );
  }
}
