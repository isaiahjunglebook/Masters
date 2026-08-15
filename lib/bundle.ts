import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ARCHIVE_DIR } from "./store";
import type { SeenVideo } from "./archive";

/**
 * Packs archived transcripts into a zip you drop straight into a Claude chat
 * or Claude Code session.
 *
 * This is the no-API-key path: the analysis happens wherever you already have
 * Claude, and this repo's job is just to produce a clean, self-describing
 * input. The prompt travels inside the zip so the bundle carries its own
 * instructions rather than depending on you remembering them.
 */

/** Read the prompt that ships with the repo, so editing `prompts/daily-brief.md`
 *  changes every future bundle. */
async function loadPrompt(): Promise<string> {
  const path = resolve(process.cwd(), "prompts", "daily-brief.md");
  try {
    return await readFile(path, "utf8");
  } catch {
    // A missing prompt file shouldn't cost you the transcripts.
    return (
      "# Daily brief\n\nSummarize these transcripts. Group by claim rather " +
      "than by creator, collapse anything several of them said, and pull out " +
      "specific checkable claims with who said them.\n"
    );
  }
}

/** Why a video isn't in the zip: no transcript was ever fetched, or the
 *  archived file couldn't be read now. */
type Missing = { video: SeenVideo; reason: string };

/** One row per video, so the model can see the shape of the batch before
 *  reading any of it — and so you can sort/filter in a spreadsheet. Status is
 *  derived from what actually made it into the zip, not from the record's
 *  optimistic view of itself. */
function indexCsv(videos: SeenVideo[], missing: Map<string, string>): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    "published,channel,title,video_id,url,transcript_file,status",
  ];
  for (const v of videos) {
    const reason = missing.get(v.id);
    rows.push(
      [
        v.published,
        v.channel,
        v.title,
        v.id,
        v.url,
        reason ? "" : (v.transcriptFile?.split("/").pop() ?? ""),
        reason ? `not included: ${reason}` : "ok",
      ]
        .map(cell)
        .join(",")
    );
  }
  return rows.join("\n") + "\n";
}

/** The human-facing note at the top of the zip. */
function readme(
  videos: SeenVideo[],
  label: string,
  withText: number,
  skipped: Missing[]
): string {
  const channels = [...new Set(videos.map((v) => v.channel ?? "unknown"))];

  return `# Transcript bundle — ${label}

${withText} transcript${withText === 1 ? "" : "s"} from ${channels.length} creator${
    channels.length === 1 ? "" : "s"
  }:
${channels.map((c) => `  - ${c}`).join("\n")}

## How to use this

1. Open a new Claude conversation (or a Claude Code session in this repo).
2. Paste the contents of PROMPT.md.
3. Attach everything in transcripts/ — or in Claude Code, just point it at the
   folder.

INDEX.csv lists every video with its date, channel, and URL, including the ones
with no transcript.

## What's in each transcript

A metadata header (channel, publish date, duration, views, whether the captions
were human-written or machine-generated), then the video description, then the
words. Sections are separated by \`--- DESCRIPTION ---\` and \`--- TRANSCRIPT ---\`.

Captions marked \`asr\` are machine-generated: numbers and proper nouns in those
are unreliable, which is why the prompt tells Claude to flag ambiguous figures
rather than guess at them.
${
  skipped.length
    ? `\n## Not included (${skipped.length})\n\n${skipped
        .map((s) => `  - ${s.video.title} — ${s.reason}`)
        .join("\n")}\n\nThese are in INDEX.csv too, so nothing disappears silently.\n`
    : ""
}`;
}

export interface BundleResult {
  buffer: Buffer;
  /** Transcripts actually included (videos without one are listed, not packed). */
  included: number;
  skipped: number;
}

/** Build the zip. Videos whose transcript file is missing from disk are
 *  reported rather than silently dropped — a bundle that quietly loses videos
 *  would make a thin day look like a quiet one. */
export async function buildBundle(
  videos: SeenVideo[],
  label: string
): Promise<BundleResult> {
  const zip = new JSZip();
  const folder = zip.folder("transcripts")!;

  let included = 0;
  const missing: Missing[] = [];

  for (const video of videos) {
    if (!video.transcriptFile) {
      missing.push({
        video,
        reason: video.skipReason ?? "no transcript was fetched",
      });
      continue;
    }
    try {
      const text = await readFile(resolve(ARCHIVE_DIR, video.transcriptFile), "utf8");
      folder.file(video.transcriptFile.split("/").pop()!, text);
      included++;
    } catch (err: any) {
      missing.push({
        video,
        reason: `archived file couldn't be read (${err?.code ?? err?.message ?? err})`,
      });
    }
  }

  const missingById = new Map(missing.map((m) => [m.video.id, m.reason]));
  zip.file("PROMPT.md", await loadPrompt());
  zip.file("INDEX.csv", indexCsv(videos, missingById));
  zip.file("README.md", readme(videos, label, included, missing));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  return { buffer, included, skipped: missing.length };
}
