import JSZip from "jszip";
import { checkPassword, unauthorized } from "@/lib/auth";
import { createInnertube, youtubeFetch } from "@/lib/youtube";

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

/** Decode the handful of XML/HTML entities that appear in timedtext captions
 *  (and strip any inline formatting tags). `&amp;` is decoded last so an
 *  entity like `&amp;#39;` doesn't get half-decoded into a broken sequence. */
function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse a timedtext caption body into plain text. YouTube serves two shapes
 *  depending on the client/URL: the newer `json3` (an events/segs tree) and
 *  the classic XML transcript (`<text start=…>escaped words</text>`). The
 *  ANDROID/TV clients often return XML even when json3 is requested, so we
 *  detect the shape rather than assuming one. */
function parseTimedtext(body: string): string {
  if (body.trimStart().startsWith("{")) {
    const data = JSON.parse(body);
    return cleanText(
      (data.events ?? [])
        .flatMap((ev: any) => ev.segs ?? [])
        .map((seg: any) => seg.utf8 ?? "")
        .join(" ")
    );
  }
  const parts = [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    decodeEntities(m[1])
  );
  return cleanText(parts.join(" "));
}

/** Download and parse the caption-track file (timedtext) from a player
 *  response, preferring the auto-generated English track. Returns clean text,
 *  or null after pushing a diagnostic onto `errors`. */
async function captionsFromTracks(
  info: any,
  label: string,
  errors: string[]
): Promise<string | null> {
  try {
    const tracks: any[] = info.captions?.caption_tracks ?? [];
    if (!tracks.length) {
      const ps = info.playability_status;
      const status = [ps?.status, ps?.reason].filter(Boolean).join(" — ");
      errors.push(`${label}: no caption tracks (playability: ${status || "unknown"})`);
      return null;
    }
    const track =
      tracks.find((t) => t.kind === "asr" && t.language_code?.startsWith("en")) ??
      tracks.find((t) => t.kind === "asr") ??
      tracks[0];
    const url =
      track.base_url + (track.base_url.includes("?") ? "&" : "?") + "fmt=json3";
    const res = await youtubeFetch(url);
    const body = await res.text();
    if (!res.ok || !body) {
      errors.push(`${label}: timedtext HTTP ${res.status}, ${body.length} bytes`);
      return null;
    }
    const text = parseTimedtext(body);
    if (text) return text;
    errors.push(`${label}: timedtext track parsed empty`);
    return null;
  } catch (err: any) {
    errors.push(`${label}: ${err?.message ?? "unknown error"}`);
    return null;
  }
}

/**
 * Fetch a video's transcript, trying progressively less-blocked routes:
 *  1. WEB client: transcript panel (what "Show transcript" uses), then the
 *     player's caption-track file (timedtext).
 *  2. ANDROID, then TV client player responses — YouTube serves these
 *     less-degraded responses on datacenter IPs (like Vercel's).
 * Throws with every attempt's real error so failures stay diagnosable.
 */
async function fetchTranscript(
  yt: any,
  id: string,
  providedTitle?: string
): Promise<{ title: string; text: string }> {
  const errors: string[] = [];
  let title = providedTitle ?? id;

  try {
    const info = await yt.getInfo(id);
    title = info.basic_info?.title ?? title;

    try {
      const transcriptInfo = await info.getTranscript();
      const segments =
        transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
      const text = cleanText(
        segments.map((seg: any) => seg?.snippet?.text?.toString() ?? "").join(" ")
      );
      if (text) return { title, text };
      errors.push(`transcript panel empty (${segments.length} segments)`);
    } catch (err: any) {
      errors.push(`transcript panel: ${err?.message ?? "unknown error"}`);
    }

    const text = await captionsFromTracks(info, "WEB", errors);
    if (text) return { title, text };
  } catch (err: any) {
    errors.push(`getInfo: ${err?.message ?? "unknown error"}`);
  }

  for (const client of ["ANDROID", "TV"]) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      title = info.basic_info?.title ?? title;
      const text = await captionsFromTracks(info, client, errors);
      if (text) return { title, text };
    } catch (err: any) {
      errors.push(`${client}: ${err?.message ?? "unknown error"}`);
    }
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

  const yt = await createInnertube();
  const zip = new JSZip();
  const skipped: Skipped[] = [];
  let successCount = 0;

  for (let i = 0; i < requested.length; i++) {
    const { id, title: providedTitle } = requested[i];
    try {
      const { title, text } = await fetchTranscript(yt, id, providedTitle);

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
      const reason = (err?.message ?? "Unknown error").slice(0, 500);
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
