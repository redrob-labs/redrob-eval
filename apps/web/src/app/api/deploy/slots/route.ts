import { NextResponse } from 'next/server';
import {
  listSlots,
  MAX_DEPLOY_SLOTS,
  nextFreeSlotIndex,
  removeSlotRecord,
  resolveSlotIndex,
  slotFor,
  upsertSlot,
} from '@/lib/deploy/slots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/deploy/slots — local slot registry (gitignored).
 * POST /api/deploy/slots — allocate the next free slot, or upsert a given index.
 * DELETE /api/deploy/slots — clear a local slot record (body: { index }).
 */
export async function GET() {
  const slots = await listSlots();
  const next = await nextFreeSlotIndex();
  return NextResponse.json({
    slots,
    nextFree: next,
    max: MAX_DEPLOY_SLOTS,
  });
}

export async function POST(request: Request) {
  let body: { index?: number; hf?: string; label?: string; allocate?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    if (body.allocate || body.index === undefined) {
      const index = await nextFreeSlotIndex();
      if (index === null) {
        return NextResponse.json(
          { error: `All ${MAX_DEPLOY_SLOTS} slots are allocated` },
          { status: 409 },
        );
      }
      const slot = slotFor(index);
      const hf = body.hf?.trim() || '';
      if (hf) {
        const record = await upsertSlot({ index, hf, label: body.label });
        return NextResponse.json({ ok: true, slot: record, paths: slot });
      }
      // Allocate an empty registry entry so the UI can show the card.
      const record = await upsertSlot({
        index,
        hf: body.hf?.trim() || 'unassigned',
        label: body.label ?? `Slot ${index}`,
      });
      return NextResponse.json({ ok: true, slot: record, paths: slot });
    }

    const index = resolveSlotIndex(body.index);
    const hf = body.hf?.trim();
    if (!hf) {
      return NextResponse.json({ error: 'hf is required when upserting a slot' }, { status: 400 });
    }
    const record = await upsertSlot({ index, hf, label: body.label });
    return NextResponse.json({ ok: true, slot: record, paths: slotFor(index) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'slot update failed' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  let body: { index?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  try {
    const index = resolveSlotIndex(body.index);
    await removeSlotRecord(index);
    return NextResponse.json({ ok: true, index });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'slot delete failed' },
      { status: 400 },
    );
  }
}
