import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInnertube } from "./youtube";
import { fetchTranscript, safeFilename, type VideoMeta } from "./captions";
import { masterTranscript } from "./merge";
import { transcribeAudio } from "./audio";
import {
  Backoff,
  DEFAULT_DAILY_CAP,
  isRateLimitSignal,
  randomGapMs,
  recordDownload,
  remainingToday,
} from "./limits";

/**
 * Background runner for downloads started from the web UI.
 *
 * A Whisper pass takes minutes per video, so a request that did the work
 * inline would hang the page for an hour. Instead the browser starts a job and
 * polls it, which also means closing the tab doesn't kill the run.
 *
 * Jobs live in memory: this is a single-user app you start and stop yourself,
 * and the durable output is the .txt files on disk, not the job record.
 */

export type JobState = "running" | "done" | "failed" | "stopped";

export interface JobItem {
  id: string;
  title: string;
  status: "pending" | "working" | "saved" | "skipped";
  detail?: string;
  file?: string;
}

export interface Job {
  id: string;
  state: JobState;
  outDir: string;
  useWhisper: boolean;
  startedAt: string;
  /** Human-readable note about the whole run (why it stopped, mostly). */
  message?: string;
  items: JobItem[];
  /** Set while waiting between audio downloads, so the UI can explain a pause. */
  waitingUntil?: number;
}

const jobs = new Map<string, Job>();
const cancelled = new Set<string>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function stopJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.state !== "running") return false;
  cancelled.add(id);
  return true;
}

/** Expand `~` and make the path absolute, so the UI can accept what a person
 *  would actually type ("~/Desktop/xrp"). */
export function resolveOutDir(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Pick a folder to save into");
  const expanded = trimmed.startsWith("~")
    ? resolve(homedir(), trimmed.slice(1).replace(/^[/\\]/, ""))
    : trimmed;
  return resolve(expanded);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StartOptions {
  videos: { id: string; title?: string }[];
  outDir: string;
  useWhisper: boolean;
  /** Re-download videos already present in the folder. */
  force?: boolean;
}

export async function startJob(opts: StartOptions): Promise<Job> {
  const outDir = resolveOutDir(opts.outDir);
  await mkdir(outDir, { recursive: true });

  // The folder is the record of what's already downloaded — same rule the CLI
  // uses, so the two stay consistent and files can be moved by hand.
  const have = new Set<string>();
  if (!opts.force) {
    for (const name of await readdir(outDir)) {
      const m = name.match(/\[([\w-]{11})\]\.txt$/);
      if (m) have.add(m[1]);
    }
  }

  const job: Job = {
    id: randomUUID(),
    state: "running",
    outDir,
    useWhisper: opts.useWhisper,
    startedAt: new Date().toISOString(),
    items: opts.videos.map((v) => ({
      id: v.id,
      title: v.title ?? v.id,
      status: have.has(v.id) ? "skipped" : "pending",
      detail: have.has(v.id) ? "already in folder" : undefined,
    })),
  };
  jobs.set(job.id, job);

  // Deliberately not awaited: the HTTP response returns immediately and the
  // work continues in the background.
  void runJob(job, opts).catch((err) => {
    job.state = "failed";
    job.message = err?.message ?? String(err);
  });

  return job;
}

async function runJob(job: Job, opts: StartOptions): Promise<void> {
  const yt = await createInnertube();
  const backoff = new Backoff();
  let audioBudget = job.useWhisper ? await remainingToday() : Infinity;
  let didAudioLast = false;

  for (const item of job.items) {
    if (cancelled.has(job.id)) {
      job.state = "stopped";
      job.message = "Stopped by you.";
      break;
    }
    if (item.status === "skipped") continue;

    item.status = "working";

    // Space out audio downloads. Captions are light enough not to need this;
    // audio is megabytes and gets a long, randomised gap.
    if (job.useWhisper && didAudioLast && audioBudget > 0) {
      const gap = randomGapMs();
      job.waitingUntil = Date.now() + gap;
      item.detail = `waiting ${Math.round(gap / 1000)}s before next audio download`;
      await sleep(gap);
      job.waitingUntil = undefined;
      if (cancelled.has(job.id)) {
        job.state = "stopped";
        job.message = "Stopped by you.";
        break;
      }
    }

    let meta: VideoMeta | null = null;
    let captionText: string | null = null;
    let captionKind: string | null = null;

    // 1. Captions — cheap, and the cross-check for the audio pass.
    try {
      item.detail = "fetching captions";
      const result = await fetchTranscript(yt, item.id, item.title);
      meta = result.meta;
      captionText = result.text;
      captionKind = result.meta.caption_kind;
    } catch (err: any) {
      const reason = (err?.message ?? "unknown").split(" Details:")[0];
      if (isRateLimitSignal(reason)) {
        const back = backoff.hit();
        if (!back) {
          item.status = "skipped";
          item.detail = reason;
          job.state = "stopped";
          job.message =
            "YouTube pushed back twice — stopped so this doesn't escalate. Try again later.";
          break;
        }
        item.detail = `YouTube pushed back; waiting ${back.waitMs / 60_000} min`;
        await sleep(back.waitMs);
      }
      // No captions isn't fatal when Whisper can still run.
      item.detail = reason;
    }

    // 2. Audio + Whisper, if asked for and still within today's ceiling.
    let whisper: { text: string; engine: string; seconds: number } | undefined;
    if (job.useWhisper) {
      if (audioBudget <= 0) {
        item.detail = `daily audio limit reached (${DEFAULT_DAILY_CAP}/day) — captions only`;
      } else {
        try {
          item.detail = "downloading audio and transcribing (this takes a few minutes)";
          whisper = await transcribeAudio(item.id);
          await recordDownload();
          audioBudget -= 1;
          didAudioLast = true;
        } catch (err: any) {
          const reason = err?.message ?? "audio failed";
          if (isRateLimitSignal(reason)) {
            const back = backoff.hit();
            if (!back) {
              job.state = "stopped";
              job.message =
                "YouTube pushed back twice on audio — stopped. Wait a few hours before retrying.";
              item.status = "skipped";
              item.detail = reason;
              break;
            }
            item.detail = `pushed back; waiting ${back.waitMs / 60_000} min`;
            await sleep(back.waitMs);
          } else {
            item.detail = `audio failed: ${reason}`;
          }
        }
      }
    }

    // 3. One master file per video. The audio is already gone by now.
    if (!meta && !whisper) {
      item.status = "skipped";
      item.detail = item.detail ?? "nothing to save";
      continue;
    }

    const finalMeta: VideoMeta =
      meta ??
      ({
        id: item.id,
        title: item.title,
        published: null,
        published_at: null,
        duration_seconds: null,
        view_count: null,
        like_count: null,
        channel: null,
        channel_id: null,
        is_live_content: null,
        description: null,
        caption_kind: null,
        caption_language: null,
      } as VideoMeta);

    const { text } = masterTranscript(finalMeta, {
      captions: captionText ? { text: captionText, kind: captionKind } : undefined,
      whisper,
    });
    const name = safeFilename(finalMeta.title, item.id, finalMeta.published);
    await writeFile(resolve(job.outDir, name), text, "utf8");

    item.status = "saved";
    item.file = name;
    item.detail = whisper
      ? `whisper + captions (${whisper.seconds}s)`
      : captionText
        ? `captions only (${captionKind ?? "unknown"})`
        : "saved";
  }

  cancelled.delete(job.id);
  if (job.state === "running") {
    job.state = "done";
    const saved = job.items.filter((i) => i.status === "saved").length;
    job.message = `Saved ${saved} transcript${saved === 1 ? "" : "s"} to ${job.outDir}`;
  }
}
