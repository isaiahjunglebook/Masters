import { youtubeFetch, cookieProblem } from "./youtube";

/** One caption cue: when it was said (seconds into the video) and what. */
export interface Segment {
  start: number;
  text: string;
}

/** Where a transcript's words came from. `manual` means a human wrote (or
 *  corrected) them and is materially more trustworthy — worth recording, since
 *  any analysis of what was said should weight the two differently. */
export type CaptionKind = "manual" | "asr";

/** Everything worth knowing about a video besides its words. Kept flat and
 *  primitive so it drops straight into a CSV row or a DataFrame. */
export interface VideoMeta {
  id: string;
  title: string;
  /** Calendar date, YYYY-MM-DD. */
  published: string | null;
  /** Full ISO timestamp when YouTube reports one — for a livestream this is
   *  when it started, which is when the calls were actually made. */
  published_at: string | null;
  duration_seconds: number | null;
  view_count: number | null;
  like_count: number | null;
  channel: string | null;
  channel_id: string | null;
  /** True for anything that was ever a livestream (they behave differently:
   *  the publish time is the start, and calls are spread across hours). */
  is_live_content: boolean | null;
  description: string | null;
  /** How the words were produced, and in which language track. */
  caption_kind: CaptionKind | null;
  caption_language: string | null;
}

export interface TranscriptResult {
  meta: VideoMeta;
  segments: Segment[];
  /** Plain prose, or timestamped lines when `timestamps` was requested. */
  text: string;
}

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

/** `[H:MM:SS]` for a position in a video. Hours are included only when the
 *  video is long enough to need them, so short videos stay readable. */
function stamp(seconds: number, withHours: boolean): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return withHours ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/** Render segments as timestamped lines. Auto-captions arrive as hundreds of
 *  ~2-second fragments, so merge them into readable chunks (~30s or ~300
 *  chars) and stamp each chunk with the time its first word was said. */
export function timestampedText(segments: Segment[]): string {
  const CHUNK_SECONDS = 30;
  const CHUNK_CHARS = 300;
  const withHours = (segments.at(-1)?.start ?? 0) >= 3600;

  const lines: string[] = [];
  let start: number | null = null;
  let buffer = "";

  const flush = () => {
    const text = buffer.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    if (text && start !== null) lines.push(`[${stamp(start, withHours)}] ${text}`);
    buffer = "";
    start = null;
  };

  for (const seg of segments) {
    if (start === null) start = seg.start;
    buffer = buffer ? `${buffer} ${seg.text}` : seg.text;
    if (seg.start - start >= CHUNK_SECONDS || buffer.length >= CHUNK_CHARS) flush();
  }
  flush();
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

/** Parse a timedtext caption body into timed segments. YouTube serves several
 *  shapes depending on the client/URL, and the ANDROID/TV clients often return
 *  XML even when json3 is requested, so we detect the shape rather than assume:
 *    - json3: an events/segs tree, times in ms
 *    - srv1:  <transcript><text start=…>escaped words</text></transcript>, seconds
 *    - srv3:  <timedtext><body><p t=… d=…>…<s>word</s></p></body></timedtext>, ms
 *  Returns [] if nothing recognizable is found (caller reports a diagnostic). */
function parseTimedtext(body: string): Segment[] {
  if (body.trimStart().startsWith("{")) {
    const data = JSON.parse(body);
    return (data.events ?? [])
      .map((ev: any) => ({
        start: (ev.tStartMs ?? 0) / 1000,
        text: (ev.segs ?? []).map((seg: any) => seg.utf8 ?? "").join(""),
      }))
      .filter((s: Segment) => s.text.trim());
  }

  // srv1: text lives directly inside <text> elements, start in seconds.
  const textEls = [...body.matchAll(/<text[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)];
  if (textEls.length) {
    return textEls
      .map((m) => ({ start: Number(m[1]) || 0, text: decodeEntities(m[2]) }))
      .filter((s) => s.text.trim());
  }

  // srv3: text lives inside <p> elements, sometimes split across per-word <s>
  // segments. Strip the <s> tags with NO space so segments rejoin with their
  // own spacing (auto-captions split some words across <s> for timing).
  const paragraphs = [...body.matchAll(/<p[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)];
  if (paragraphs.length) {
    return paragraphs
      .map((m) => ({
        start: Number(m[1]) / 1000 || 0,
        text: decodeEntities(m[2].replace(/<\/?s\b[^>]*>/g, "")),
      }))
      .filter((s) => s.text.trim());
  }

  // Untimed fallback: <text>/<p> without parseable timing still beats nothing.
  const untimed = [...body.matchAll(/<(?:text|p)[^>]*>([\s\S]*?)<\/(?:text|p)>/g)];
  return untimed
    .map((m) => ({ start: 0, text: decodeEntities(m[1].replace(/<\/?s\b[^>]*>/g, "")) }))
    .filter((s) => s.text.trim());
}

/** Download and parse the caption-track file (timedtext) from a player
 *  response. Returns segments and their provenance, or null after pushing a
 *  diagnostic onto `errors`.
 *
 *  Track preference is accuracy-ordered: a human-written English track beats
 *  YouTube's speech recognition every time — punctuation, proper nouns and
 *  numbers are all transcribed rather than guessed — so take one whenever the
 *  uploader provided it, and only fall back to the `asr` track otherwise. */
async function captionsFromTracks(
  info: any,
  label: string,
  errors: string[]
): Promise<{ segments: Segment[]; kind: CaptionKind; language: string | null } | null> {
  try {
    const tracks: any[] = info.captions?.caption_tracks ?? [];
    if (!tracks.length) {
      const ps = info.playability_status;
      const status = [ps?.status, ps?.reason].filter(Boolean).join(" — ");
      errors.push(`${label}: no caption tracks (playability: ${status || "unknown"})`);
      return null;
    }
    const isEnglish = (t: any) => t.language_code?.startsWith("en");
    const isManual = (t: any) => t.kind !== "asr";
    const track =
      tracks.find((t) => isManual(t) && isEnglish(t)) ??
      tracks.find((t) => t.kind === "asr" && isEnglish(t)) ??
      tracks.find(isManual) ??
      tracks[0];
    const kind: CaptionKind = track.kind === "asr" ? "asr" : "manual";
    const language: string | null = track.language_code ?? null;
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
    const segments = parseTimedtext(body);
    if (segments.length) return { segments, kind, language };
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

/** Absolute publish date/time. The channel listing only carries relative dates
 *  ("3 weeks ago"), which are useless for sorting or backtesting, so read the
 *  player response's microformat and fall back to the watch page's own
 *  "Published" text. For livestreams `start_timestamp` is the real moment. */
function publishedFrom(info: any): { date: string | null; at: string | null } {
  const mf = info?.page?.[0]?.microformat;
  const start = info?.basic_info?.start_timestamp;

  // A livestream's start beats the calendar publish date: it's when the words
  // were actually spoken, which is what a backtest needs to line up.
  if (start instanceof Date && !Number.isNaN(start.getTime())) {
    return { date: start.toISOString().slice(0, 10), at: start.toISOString() };
  }

  const raw = mf?.publish_date ?? mf?.upload_date;
  if (typeof raw === "string") {
    // Usually "2025-08-03", sometimes with a time and UTC offset appended.
    const ms = Date.parse(raw);
    const hasTime = /\d{2}:\d{2}/.test(raw);
    const dateMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      return {
        date: dateMatch[1],
        at: hasTime && !Number.isNaN(ms) ? new Date(ms).toISOString() : null,
      };
    }
  }

  const text = info?.primary_info?.published?.text;
  if (text) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) {
      return { date: new Date(ms).toISOString().slice(0, 10), at: null };
    }
  }
  return { date: null, at: null };
}

/** Pull the flat metadata record out of whatever player response we got. */
function metaFrom(info: any, id: string, fallbackTitle: string): VideoMeta {
  const basic = info?.basic_info ?? {};
  const { date, at } = publishedFrom(info);
  const num = (v: any): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    id,
    title: basic.title ?? fallbackTitle,
    published: date,
    published_at: at,
    duration_seconds: num(basic.duration),
    view_count: num(basic.view_count),
    like_count: num(basic.like_count),
    channel: basic.author ?? basic.channel?.name ?? null,
    channel_id: basic.channel_id ?? basic.channel?.id ?? null,
    is_live_content:
      typeof basic.is_live_content === "boolean" ? basic.is_live_content : null,
    description: basic.short_description ?? null,
    // Filled in once we know which track the words actually came from.
    caption_kind: null,
    caption_language: null,
  };
}

/** Keep whichever metadata record is richer — later clients (ANDROID, TV) can
 *  fill gaps the WEB response left blank, but must not blank out what we have. */
function mergeMeta(base: VideoMeta, next: VideoMeta): VideoMeta {
  const out = { ...base };
  for (const key of Object.keys(next) as (keyof VideoMeta)[]) {
    const value = next[key];
    if (out[key] === null || out[key] === undefined) {
      (out as any)[key] = value;
    }
  }
  return out;
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
  providedTitle?: string,
  options: { timestamps?: boolean } = {}
): Promise<TranscriptResult> {
  const errors: string[] = [];
  const fallbackTitle = providedTitle ?? id;
  let meta: VideoMeta = {
    id,
    title: fallbackTitle,
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
  };

  const render = (
    segments: Segment[],
    source: { kind: CaptionKind; language: string | null }
  ): TranscriptResult => ({
    meta: { ...meta, caption_kind: source.kind, caption_language: source.language },
    segments,
    text: options.timestamps
      ? timestampedText(segments)
      : cleanText(segments.map((s) => s.text).join(" ")),
  });

  try {
    const info = await yt.getInfo(id);
    meta = mergeMeta(metaFrom(info, id, fallbackTitle), meta);

    // Caption tracks come first: they let us choose a human-written track over
    // speech recognition, and they tell us which one we got. The transcript
    // panel serves whichever track YouTube defaults to without saying which,
    // so it's the fallback rather than the first choice.
    const tracked = await captionsFromTracks(info, "WEB", errors);
    if (tracked) return render(tracked.segments, tracked);

    try {
      const transcriptInfo = await info.getTranscript();
      const initial =
        transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
      const segments: Segment[] = initial
        .map((seg: any) => ({
          start: Number(seg?.start_ms ?? 0) / 1000 || 0,
          text: seg?.snippet?.text?.toString() ?? "",
        }))
        .filter((s: Segment) => s.text.trim());
      if (segments.length) {
        // Provenance genuinely unknown here — don't guess a value an analysis
        // might weight by.
        return {
          meta,
          segments,
          text: options.timestamps
            ? timestampedText(segments)
            : cleanText(segments.map((s) => s.text).join(" ")),
        };
      }
      errors.push(`transcript panel empty (${initial.length} segments)`);
    } catch (err: any) {
      errors.push(`transcript panel: ${err?.message ?? "unknown error"}`);
    }
  } catch (err: any) {
    errors.push(`getInfo: ${err?.message ?? "unknown error"}`);
  }

  for (const client of ["ANDROID", "IOS", "TV", "WEB_EMBEDDED"] as const) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      meta = mergeMeta(meta, metaFrom(info, id, fallbackTitle));
      const tracked = await captionsFromTracks(info, client, errors);
      if (tracked) return render(tracked.segments, tracked);
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

/** One transcript file: a metadata header, the description, then the words.
 *  Sections are delimited so a script can split the file without guessing. */
export function transcriptFile(meta: VideoMeta, text: string): string {
  const rule = "-".repeat(60);
  const header = [
    `Title: ${meta.title}`,
    `Channel: ${meta.channel ?? "unknown"}`,
    `Published: ${meta.published ?? "unknown"}`,
    `Published at: ${meta.published_at ?? "unknown"}`,
    `Duration (s): ${meta.duration_seconds ?? "unknown"}`,
    `Views: ${meta.view_count ?? "unknown"}`,
    `Livestream: ${meta.is_live_content === null ? "unknown" : meta.is_live_content}`,
    `Captions: ${meta.caption_kind ?? "unknown"}${
      meta.caption_language ? ` (${meta.caption_language})` : ""
    }`,
    `Video ID: ${meta.id}`,
    `URL: https://www.youtube.com/watch?v=${meta.id}`,
  ].join("\n");

  const description = meta.description?.trim()
    ? `${rule}\n--- DESCRIPTION ---\n${meta.description.trim()}\n`
    : "";

  return `${header}\n${description}${rule}\n--- TRANSCRIPT ---\n${text}\n`;
}

/** RFC-4180 CSV cell: quote when the value could otherwise break the row. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const INDEX_FILENAME = "_index.csv";

/** A one-row-per-video manifest: the file to load into pandas/Excel to join
 *  transcripts against price data. Descriptions are excluded — they're in the
 *  .txt files, and multi-paragraph cells make the CSV unreadable by eye. */
export function indexCsv(
  rows: { meta: VideoMeta; file: string; chars: number }[]
): string {
  const columns = [
    "published",
    "published_at",
    "title",
    "channel",
    "video_id",
    "url",
    "duration_seconds",
    "view_count",
    "like_count",
    "is_live_content",
    "caption_kind",
    "caption_language",
    "transcript_chars",
    "transcript_file",
  ];
  const lines = [columns.join(",")];
  // Chronological, so the CSV reads as a timeline out of the box.
  const sorted = [...rows].sort((a, b) =>
    (a.meta.published ?? "").localeCompare(b.meta.published ?? "")
  );
  for (const { meta, file, chars } of sorted) {
    lines.push(
      [
        meta.published,
        meta.published_at,
        meta.title,
        meta.channel,
        meta.id,
        `https://www.youtube.com/watch?v=${meta.id}`,
        meta.duration_seconds,
        meta.view_count,
        meta.like_count,
        meta.is_live_content,
        meta.caption_kind,
        meta.caption_language,
        chars,
        file,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}
