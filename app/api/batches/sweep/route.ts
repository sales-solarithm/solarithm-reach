import { NextRequest, NextResponse } from 'next/server';
import {
  NIGHTLY_SWEEP_CRON_CONFIG,
  executeFirestoreNightlySweep,
} from '@/lib/batchResetCron';
import { getTodayIstDateString } from '@/types/batch';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const targetDate = body.date || getTodayIstDateString();
    const nowIso = new Date().toISOString();

    await executeFirestoreNightlySweep(targetDate, nowIso);

    return NextResponse.json({
      ok: true,
      cron: NIGHTLY_SWEEP_CRON_CONFIG,
      sweptAt: nowIso,
      date: targetDate,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Sweep failed',
      },
      { status: 500 }
    );
  }
}
