import { Innertube } from "youtubei.js";
import JSZip from "jszip";
import { checkPassword, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
// Caption fetching is deliberately slow (~2s/video to be polite to YouTube),
// so give this function the longest duration Vercel allows.
export const maxDuration = 300;

const DELAY_MS_MIN = 1500;
const DELAY_MS_JITTER = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RequestedVideo {
  id: string;
  title?: string;
}

interface Skipped {
  id: string;
  title: string;
  reason: string;
}

/** Clean prose out of raw caption text: no timestamps, no [Music]-style
 *  tags, wrapped at ~100 chars so the .txt is readable. */
function cleanText(joined: string): string {
  const raw = joined
    .replace(/\[[^\]]*\]/g, " ") // [Music], [Applause], ...
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";

  const lines: string[] = [];
  let line = "";
  for (const word of raw.split(" ")) {
    if (line && line.length + word.length + 1 > 100) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/**
 * Fetch a video's transcript text, trying two independent routes:
 *  1. The watch-page transcript panel (what "Show transcript" uses).
 *  2. The raw caption-track file the player itself loads (timedtext),
 *     preferring the auto-generated (asr) English track.
 * Throws with the real error from each attempt so failures are diagnosable.
 */
async function fetchTranscriptText(info: any): Promise<string> {
  const errors: string[] = [];

  try {
    const transcriptInfo = await info.getTranscript();
    const segments =
      transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
    const text = cleanText(
      segments.map((seg: any) => seg?.snippet?.text?.toString() ?? "").join(" ")
    );
    if (text) return text;
    errors.push(`transcript panel empty (${segments.length} segments)`);
  } catch (err: any) {
    errors.push(`transcript panel: ${err?.message ?? "unknown error"}`);
  }

  try {
    const tracks: any[] = info.captions?.caption_tracks ?? [];
    if (!tracks.length) {
      errors.push("no caption tracks in player response");
    } else {
      const track =
        tracks.find((t) => t.kind === "asr" && t.language_code?.startsWith("en")) ??
        tracks.find((t) => t.kind === "asr") ??
        tracks[0];
      const url =
        track.base_url + (track.base_url.includes("?") ? "&" : "?") + "fmt=json3";
      const res = await fetch(url);
      const body = await res.text();
      if (!res.ok || !body) {
        errors.push(`timedtext fetch: HTTP ${res.status}, ${body.length} bytes`);
      } else {
        const data = JSON.parse(body);
        const text = cleanText(
          (data.events ?? [])
            .flatMap((ev: any) => ev.segs ?? [])
            .map((seg: any) => seg.utf8 ?? "")
            .join(" ")
        );
        if (text) return text;
        errors.push("timedtext track parsed empty");
      }
    }
  } catch (err: any) {
    errors.push(`timedtext: ${err?.message ?? "unknown error"}`);
  }

  throw new Error(errors.join(" | "));
}

function safeFilename(title: string, id: string): string {
  const base = title
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "video"} [${id}].txt`;
}

export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();

  let requested: RequestedVideo[];
  try {
    const body = await req.json();
    requested = (body.videos ?? [])
      .filter((v: any) => typeof v?.id === "string" && /^[\w-]{11}$/.test(v.id))
      .slice(0, 200);
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!requested.length) {
    return Response.json({ error: "No video IDs provided" }, { status: 400 });
  }

  const yt = await Innertube.create({ retrieve_player: false });
  const zip = new JSZip();
  const skipped: Skipped[] = [];
  let successCount = 0;

  for (let i = 0; i < requested.length; i++) {
    const { id, title: providedTitle } = requested[i];
    try {
      const info = await yt.getInfo(id);
      const title = info.basic_info.title ?? providedTitle ?? id;

      const text = await fetchTranscriptText(info);

      const header = [
        `Title: ${title}`,
        `Video ID: ${id}`,
        `URL: https://www.youtube.com/watch?v=${id}`,
        "-".repeat(60),
        "",
      ].join("\n");
      zip.file(safeFilename(title, id), header + text + "\n");
      successCount++;
    } catch (err: any) {
      // Report the real error text (trimmed) — masking it behind a friendly
      // label makes failures impossible to diagnose remotely
      const reason = (err?.message ?? "Unknown error").slice(0, 300);
      console.log(`[captions] skipped ${id}: ${reason}`);
      skipped.push({ id, title: providedTitle ?? id, reason });
    }
    // Be polite: pause between videos (but not after the last one)
    if (i < requested.length - 1) {
      await sleep(DELAY_MS_MIN + Math.random() * DELAY_MS_JITTER);
    }
  }

  if (successCount === 0) {
    return Response.json(
      { error: "No captions could be fetched for any selected video", skipped },
      { status: 422 }
    );
  }

  if (skipped.length) {
    zip.file(
      "_skipped.txt",
      skipped.map((s) => `${s.id}  ${s.title}  —  ${s.reason}`).join("\n") + "\n"
    );
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="captions.zip"',
      // Frontend reads this to show which videos were skipped
      "x-skipped": encodeURIComponent(JSON.stringify(skipped)),
      "x-success-count": String(successCount),
    },
  });
}
