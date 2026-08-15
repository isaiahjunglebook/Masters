import { cleanText, type VideoMeta } from "./captions";

/**
 * Merging YouTube's captions with a Whisper transcript.
 *
 * Two sources can't vote — a disagreement between exactly two systems gives no
 * majority — so this doesn't try to synthesise a "best" wording. Whisper leads
 * because it punctuates and renders numbers as digits, and the captions are
 * kept as a cross-check.
 *
 * The cross-check is deliberately narrow: numbers. That's where transcription
 * error actually costs something ("three twenty" → $3.20 or $320), and where a
 * confident-looking wrong figure is worse than a flagged uncertainty. Comparing
 * every word would bury the twenty spans that matter under a thousand that
 * don't.
 */

export interface MergeSources {
  /** YouTube's caption track, when there was one. */
  captions?: { text: string; kind: string | null };
  /** Whisper's pass over the audio, when it ran. */
  whisper?: { text: string; engine: string; seconds: number };
}

/** Money and bare figures, normalised enough to compare across sources.
 *  "$3.20", "3.20", "320", "1,500" all reduce to a comparable numeric form. */
function numbersIn(text: string): Map<string, string> {
  const found = new Map<string, string>();
  // The suffix needs a word boundary, or "$100 by December" reads the "b" of
  // "by" as "billion".
  const re =
    /(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b|m\b|b\b|bn\b|billion\b|million\b|thousand\b|%)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    const isMoney = Boolean(m[1]);
    const value = m[2].replace(/,/g, "");
    const suffix = (m[3] ?? "").toLowerCase().trim();
    const n = Number(value);
    if (!Number.isFinite(n)) continue;

    // Drop noise, but never drop a price: "$3.20" is exactly the kind of figure
    // this check exists for, so the small-number and year filters only apply to
    // bare numbers.
    if (!isMoney && !suffix && n < 10) continue;
    if (!isMoney && !suffix && n >= 1900 && n <= 2100) continue;

    const key = `${isMoney ? "$" : ""}${value}${suffix}`;
    if (!found.has(key)) found.set(key, raw);
  }
  return found;
}

export interface NumberCheck {
  /** In Whisper's text but not the captions'. */
  onlyInWhisper: string[];
  /** In the captions but not Whisper's. */
  onlyInCaptions: string[];
  /** Present in both — the ones you can trust most. */
  agreed: string[];
}

export function crossCheckNumbers(
  whisperText: string,
  captionText: string
): NumberCheck {
  const w = numbersIn(whisperText);
  const c = numbersIn(captionText);
  const onlyInWhisper: string[] = [];
  const onlyInCaptions: string[] = [];
  const agreed: string[] = [];

  for (const [key, raw] of w) {
    if (c.has(key)) agreed.push(raw);
    else onlyInWhisper.push(raw);
  }
  for (const [key, raw] of c) {
    if (!w.has(key)) onlyInCaptions.push(raw);
  }
  return { onlyInWhisper, onlyInCaptions, agreed };
}

/**
 * Build the master file. Everything ends up here — the audio is deleted, but
 * both text sources are kept as sections rather than separate files, so you
 * get one file per video without losing the ability to re-merge later or audit
 * a disagreement. They cost a few kilobytes; the audio was the expensive part.
 */
export function masterTranscript(
  meta: VideoMeta,
  sources: MergeSources
): { text: string; primary: "whisper" | "captions" | "none" } {
  const rule = "-".repeat(60);
  const whisper = sources.whisper?.text?.trim();
  const captions = sources.captions?.text?.trim();

  const primary: "whisper" | "captions" | "none" = whisper
    ? "whisper"
    : captions
      ? "captions"
      : "none";

  const header = [
    `Title: ${meta.title}`,
    `Channel: ${meta.channel ?? "unknown"}`,
    `Published: ${meta.published ?? "unknown"}`,
    `Published at: ${meta.published_at ?? "unknown"}`,
    `Duration (s): ${meta.duration_seconds ?? "unknown"}`,
    `Views: ${meta.view_count ?? "unknown"}`,
    `Livestream: ${meta.is_live_content === null ? "unknown" : meta.is_live_content}`,
    `Video ID: ${meta.id}`,
    `URL: https://www.youtube.com/watch?v=${meta.id}`,
    `Sources: ${[
      captions ? `youtube captions (${sources.captions?.kind ?? "unknown"})` : null,
      whisper ? `whisper — ${sources.whisper!.engine}, ${sources.whisper!.seconds}s` : null,
    ]
      .filter(Boolean)
      .join(" + ") || "none"}`,
    `Primary: ${primary}`,
  ].join("\n");

  const parts = [header];

  if (meta.description?.trim()) {
    parts.push(`${rule}\n--- DESCRIPTION ---\n${meta.description.trim()}`);
  }

  if (whisper && captions) {
    const check = crossCheckNumbers(whisper, captions);
    const disputed = [...check.onlyInWhisper, ...check.onlyInCaptions];
    const lines = [
      `${rule}`,
      `--- NUMBER CHECK ---`,
      `Both sources agree on ${check.agreed.length} figure(s)${
        check.agreed.length ? `: ${check.agreed.slice(0, 30).join(", ")}` : ""
      }`,
    ];
    if (disputed.length) {
      lines.push(
        "",
        `Only one source heard these — treat as unverified:`,
        ...(check.onlyInWhisper.length
          ? [`  whisper only: ${check.onlyInWhisper.slice(0, 30).join(", ")}`]
          : []),
        ...(check.onlyInCaptions.length
          ? [`  captions only: ${check.onlyInCaptions.slice(0, 30).join(", ")}`]
          : [])
      );
    } else {
      lines.push("", "No disagreements.");
    }
    parts.push(lines.join("\n"));
  }

  if (whisper) {
    parts.push(
      `${rule}\n--- TRANSCRIPT (whisper) ---\n${cleanText(whisper)}`
    );
  }
  if (captions) {
    parts.push(
      `${rule}\n--- TRANSCRIPT (youtube captions) ---\n${cleanText(captions)}`
    );
  }
  if (!whisper && !captions) {
    parts.push(`${rule}\n--- TRANSCRIPT ---\n(none available)`);
  }

  return { text: parts.join("\n") + "\n", primary };
}
