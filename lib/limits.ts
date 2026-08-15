import { resolve } from "node:path";
import { DATA_DIR, readJson, writeJson } from "./store";

/**
 * Guardrails for audio downloads.
 *
 * Captions are kilobytes; audio is megabytes, so the same pace that's polite
 * for one is heavy for the other. The defence that actually works is being
 * genuinely low-volume — one download at a time, minutes apart, a hard daily
 * ceiling, and stopping outright the first time YouTube pushes back. Nothing
 * here disguises traffic; it just keeps the traffic small.
 */

const USAGE_FILE = resolve(DATA_DIR, "audio-usage.json");

/** Deliberately conservative. Raise it if you know what you're doing, but a
 *  backfill spread over a fortnight is far safer than one big night. */
export const DEFAULT_DAILY_CAP = Number(process.env.AUDIO_DAILY_CAP ?? 40);

/** Randomised gap between downloads. Randomised because a fixed interval is a
 *  machine signature, and long because audio is heavy. */
export const MIN_GAP_MS = Number(process.env.AUDIO_MIN_GAP_MS ?? 30_000);
export const MAX_GAP_MS = Number(process.env.AUDIO_MAX_GAP_MS ?? 120_000);

interface Usage {
  /** YYYY-MM-DD in local time — the user's sense of "today". */
  date: string;
  count: number;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

async function read(): Promise<Usage> {
  const usage = await readJson<Usage>(USAGE_FILE, { date: today(), count: 0 });
  // A new day resets the counter; a stale file from last week doesn't block today.
  return usage.date === today() ? usage : { date: today(), count: 0 };
}

export async function remainingToday(cap = DEFAULT_DAILY_CAP): Promise<number> {
  const usage = await read();
  return Math.max(0, cap - usage.count);
}

/** Count one download. Persisted, so a scheduled job can't quietly blow the
 *  budget across several runs while you're asleep. */
export async function recordDownload(): Promise<number> {
  const usage = await read();
  usage.count += 1;
  await writeJson(USAGE_FILE, usage);
  return usage.count;
}

export function randomGapMs(): number {
  return MIN_GAP_MS + Math.random() * Math.max(0, MAX_GAP_MS - MIN_GAP_MS);
}

/** Does this error look like YouTube asking us to slow down or go away? */
export function isRateLimitSignal(message: string): boolean {
  return /\b429\b|too many requests|rate.?limit|\b403\b|forbidden|sign in to confirm|blocked/i.test(
    message
  );
}

/**
 * Tracks pushback across a run. The single most important behaviour here is
 * backing off on the first warning and stopping on the second — a client that
 * retries through warnings is exactly what abuse detection is built to catch.
 */
export class Backoff {
  private strikes = 0;

  /** Returns how long to wait, or null when the run should stop entirely. */
  hit(): { waitMs: number } | null {
    this.strikes += 1;
    if (this.strikes >= 2) return null;
    return { waitMs: 5 * 60_000 };
  }

  get tripped(): boolean {
    return this.strikes >= 2;
  }
}
