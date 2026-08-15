import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ARCHIVE_DIR, SEEN_FILE, readJson, writeJson } from "./store";
import { safeFilename, transcriptFile, type VideoMeta } from "./captions";

/**
 * The permanent record. Every video seen on a whitelisted channel is written
 * here the day it appears and never rewritten, which is what makes the archive
 * useful for measuring a creator's accuracy later: it captures what was said
 * at the time, before anything can be edited or deleted.
 *
 * That also makes deletions visible. `checkedAt` is refreshed whenever a
 * re-check confirms a video is still listed, so a video whose `checkedAt`
 * stops advancing has disappeared from the channel — a fact worth more than
 * any accuracy score, and one nobody scraping retroactively can observe.
 */
export interface SeenVideo {
  id: string;
  title: string;
  channel: string | null;
  creatorId: string;
  published: string | null;
  publishedAt: string | null;
  url: string;
  /** When this scraper first recorded the video. */
  firstSeen: string;
  /** Most recent scrape that still found it on the channel. */
  checkedAt: string;
  /** Path of the archived transcript, relative to the archive dir. */
  transcriptFile: string | null;
  /** Why the transcript is missing, when it is. */
  skipReason?: string;
  /** Set once a re-check finds the video gone from the channel listing. */
  missingSince?: string;
}

type SeenIndex = Record<string, SeenVideo>;

export async function readSeen(): Promise<SeenIndex> {
  return readJson<SeenIndex>(SEEN_FILE, {});
}

export async function writeSeen(index: SeenIndex): Promise<void> {
  await writeJson(SEEN_FILE, index);
}

/** Per-creator archive folder, so a channel's history reads chronologically in
 *  a file browser without any tooling. */
function creatorDir(creatorId: string): string {
  const safe = creatorId.replace(/[^\w.@-]+/g, "_").slice(0, 60) || "creator";
  return resolve(ARCHIVE_DIR, safe);
}

/** Write a transcript into the archive. Returns the archive-relative path. */
export async function archiveTranscript(
  creatorId: string,
  meta: VideoMeta,
  text: string
): Promise<string> {
  const dir = creatorDir(creatorId);
  await mkdir(dir, { recursive: true });
  const name = safeFilename(meta.title, meta.id, meta.published);
  await writeFile(resolve(dir, name), transcriptFile(meta, text), "utf8");
  return `${creatorId}/${name}`;
}

/** Videos that disappeared from a channel between scrapes.
 *
 *  Only creators actually scraped this run are considered — a creator skipped
 *  because its channel failed to resolve would otherwise have its entire back
 *  catalogue reported as deleted. */
export function detectDisappearances(
  index: SeenIndex,
  scrapedCreatorIds: Set<string>,
  stillPresent: Set<string>,
  now: string
): SeenVideo[] {
  const gone: SeenVideo[] = [];
  for (const video of Object.values(index)) {
    if (!scrapedCreatorIds.has(video.creatorId)) continue;
    if (stillPresent.has(video.id)) {
      video.checkedAt = now;
      // A video that reappears was probably a transient listing glitch, not a
      // real deletion — clear the mark rather than leaving a false positive.
      delete video.missingSince;
      continue;
    }
    if (!video.missingSince) {
      video.missingSince = now;
      gone.push(video);
    }
  }
  return gone;
}
