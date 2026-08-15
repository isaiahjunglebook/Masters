import { youtubeFetch, cookieProblem } from "./youtube";

/** Clean prose out of raw caption text: no timestamps, no [Music]-style
 *  tags, wrapped at ~100 chars so the .txt is readable. */
export function cleanText(joined: string): string {
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

/** Parse a timedtext caption body into plain text. YouTube serves several
 *  shapes depending on the client/URL, and the ANDROID/TV clients often return
 *  XML even when json3 is requested, so we detect the shape rather than assume:
 *    - json3: an events/segs tree
 *    - srv1:  <transcript><text start=…>escaped words</text></transcript>
 *    - srv3:  <timedtext><body><p t=… d=…>…<s>word</s></p></body></timedtext>
 *  Returns "" if nothing recognizable is found (caller reports a diagnostic). */
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
  // srv1: text lives directly inside <text> elements.
  const textEls = [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
  if (textEls.length) {
    return cleanText(textEls.map((m) => decodeEntities(m[1])).join(" "));
  }
  // srv3: text lives inside <p> elements, sometimes split across per-word <s>
  // segments. Strip the <s> tags with NO space so segments rejoin with their
  // own spacing (auto-captions split some words across <s> for timing).
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) =>
    decodeEntities(m[1].replace(/<\/?s\b[^>]*>/g, ""))
  );
  return cleanText(paragraphs.join(" "));
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
    // Drop any fmt the track URL already carries (ANDROID/TV tracks often ship
    // fmt=srv3), then request json3 explicitly — a conflicting fmt is a likely
    // reason YouTube ignores our request and returns XML.
    const cleaned = track.base_url.replace(
      /([?&])fmt=[^&]*(&|$)/g,
      (_m: string, sep: string, tail: string) => (tail === "&" ? sep : "")
    );
    const url = cleaned + (cleaned.includes("?") ? "&" : "?") + "fmt=json3";
    const res = await youtubeFetch(url);
    const body = await res.text();
    if (!res.ok || !body) {
      errors.push(`${label}: timedtext HTTP ${res.status}, ${body.length} bytes`);
      return null;
    }
    const text = parseTimedtext(body);
    if (text) return text;
    // Surface the start of the raw body so an unrecognized format is
    // diagnosable from the skip reason without another round-trip.
    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
    errors.push(`${label}: timedtext parsed empty — starts: "${snippet}"`);
    return null;
  } catch (err: any) {
    errors.push(`${label}: ${err?.message ?? "unknown error"}`);
    return null;
  }
}

/** Absolute publish date as YYYY-MM-DD, or null when YouTube didn't give one.
 *  The channel listing only carries relative dates ("3 weeks ago"), which are
 *  useless for sorting or analysis, so read the player response's microformat
 *  instead and fall back to the watch page's own "Published" text. */
function publishedDate(info: any): string | null {
  const iso = info?.page?.[0]?.microformat?.publish_date;
  if (typeof iso === "string") {
    // Usually "2025-08-03", occasionally with a time/offset appended.
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }

  const candidates = [
    info?.primary_info?.published?.text,
    info?.basic_info?.start_timestamp,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ms = candidate instanceof Date ? candidate.getTime() : Date.parse(candidate);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Fetch a video's transcript, trying progressively less-blocked routes:
 *  1. WEB client: transcript panel (what "Show transcript" uses), then the
 *     player's caption-track file (timedtext).
 *  2. ANDROID/IOS/TV/embedded player responses — YouTube serves these
 *     less-degraded responses on datacenter IPs (like Vercel's).
 * Throws with every attempt's real error so failures stay diagnosable.
 */
export async function fetchTranscript(
  yt: any,
  id: string,
  providedTitle?: string
): Promise<{ title: string; text: string; published: string | null }> {
  const errors: string[] = [];
  let title = providedTitle ?? id;
  let published: string | null = null;

  try {
    const info = await yt.getInfo(id);
    title = info.basic_info?.title ?? title;
    published = publishedDate(info) ?? published;

    try {
      const transcriptInfo = await info.getTranscript();
      const segments =
        transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
      const text = cleanText(
        segments.map((seg: any) => seg?.snippet?.text?.toString() ?? "").join(" ")
      );
      if (text) return { title, text, published };
      errors.push(`transcript panel empty (${segments.length} segments)`);
    } catch (err: any) {
      errors.push(`transcript panel: ${err?.message ?? "unknown error"}`);
    }

    const text = await captionsFromTracks(info, "WEB", errors);
    if (text) return { title, text, published };
  } catch (err: any) {
    errors.push(`getInfo: ${err?.message ?? "unknown error"}`);
  }

  for (const client of ["ANDROID", "IOS", "TV", "WEB_EMBEDDED"] as const) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      title = info.basic_info?.title ?? title;
      published = publishedDate(info) ?? published;
      const text = await captionsFromTracks(info, client, errors);
      if (text) return { title, text, published };
    } catch (err: any) {
      errors.push(`${client}: ${err?.message ?? "unknown error"}`);
    }
  }

  // Lead with a plain-English diagnosis for the two failure modes that keep
  // coming up, so the skip reason says what's wrong AND what to do about it.
  const detail = errors.join(" | ");
  if (/members[- ]only|Join this channel/i.test(detail)) {
    throw new Error(
      `Members-only video — YouTube only serves it (and its captions) to paying ` +
        `channel members, so it can't be downloaded. Details: ${detail}`
    );
  }
  if (/LOGIN_REQUIRED|not a bot/i.test(detail)) {
    // Distinguish "no credentials configured" from "configured but rejected" —
    // otherwise a stale cookie looks identical to no cookie at all.
    const advice = process.env.YOUTUBE_COOKIE
      ? (cookieProblem() ??
          `YOUTUBE_COOKIE is set but YouTube still rejected it, so the cookie is ` +
          `expired. Re-export it from a logged-in youtube.com tab (copy the ` +
          `entire Cookie request header) and redeploy.`)
      : process.env.PROXY_URL
        ? `PROXY_URL is set but its IP is blocked too — datacenter proxies don't ` +
          `work here; use a residential one, or set YOUTUBE_COOKIE instead.`
        : `This usually means the server's IP is flagged (cloud hosts like Vercel ` +
          `are); running from a home connection normally works. Otherwise set ` +
          `YOUTUBE_COOKIE or PROXY_URL — see the README's "bot wall" section.`;
    throw new Error(
      `YouTube's bot wall is blocking this server's IP (every client got ` +
        `"confirm you're not a bot"). ${advice} Details: ${detail}`
    );
  }
  throw new Error(detail);
}

/** Filesystem-safe `<YYYY-MM-DD> <title> [<id>].txt`, short enough for any
 *  filesystem. The date leads so the files sort chronologically by name; it's
 *  omitted entirely when YouTube didn't report one, rather than inventing a
 *  placeholder that would sort as if it were real. */
export function safeFilename(
  title: string,
  id: string,
  published?: string | null
): string {
  const base = title
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${published ? `${published} ` : ""}${base || "video"} [${id}].txt`;
}

/** The header block written above each transcript. */
export function transcriptFile(
  title: string,
  id: string,
  text: string,
  published?: string | null
): string {
  return (
    [
      `Title: ${title}`,
      `Published: ${published ?? "unknown"}`,
      `Video ID: ${id}`,
      `URL: https://www.youtube.com/watch?v=${id}`,
      "-".repeat(60),
      "",
    ].join("\n") +
    text +
    "\n"
  );
}
