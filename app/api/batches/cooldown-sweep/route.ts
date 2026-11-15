import { NextRequest, NextResponse } from 'next/server';
import {
  COOLDOWN_SWEEPER_CRON_SCHEDULE,
  executeCooldownSweeperFirestore,
} from '@/functions/src/cron/cooldownSweeper';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const now = body.nowIso ? new Date(body.nowIso) : new Date();

    const summary = await executeCooldownSweeperFirestore(now);

    return NextResponse.json({
      ok: true,
      cron: COOLDOWN_SWEEPER_CRON_SCHEDULE,
      summary,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Cooldown sweep failed',
      },
      { status: 500 }
    );
  }
}
