import Anthropic from "@anthropic-ai/sdk";
import type { VideoMeta } from "./captions";

/**
 * Turns a day's transcripts into the brief.
 *
 * Two passes, because they answer different questions: each video is
 * summarized on its own (what did this person actually say?), then the set is
 * read together (what should I take from all of it?). Doing it in one pass
 * makes the model average across creators and lose the specifics — names,
 * numbers, and calls — which are the whole point.
 */

const MODEL = "claude-opus-5";

/** Transcripts run long; cap what we send so one three-hour livestream can't
 *  dominate a day's cost. The head carries the framing and most claims. */
const MAX_TRANSCRIPT_CHARS = 60_000;

export interface VideoSummary {
  meta: VideoMeta;
  /** Two or three sentences: what this video actually said. */
  summary: string;
  /** The specific, checkable claims — the backtestable part. */
  claims: string[];
  /** Why it matters, or why it doesn't. */
  soWhat: string;
}

export interface Brief {
  date: string;
  headline: string;
  /** The whole day in a few sentences — the ADHD-friendly top. */
  overview: string;
  /** What's worth acting on or watching, across all creators. */
  throughlines: string[];
  videos: VideoSummary[];
  /** Videos that vanished from a channel since the last run. */
  disappeared: { title: string; url: string; channel: string | null }[];
  /** Anything that failed, so a silent gap is never mistaken for a quiet day. */
  problems: string[];
}

function client(): Anthropic {
  // The SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth
  // login` profile on its own — constructing bare keeps all three working.
  return new Anthropic();
}

/** Pull the text out of a response, ignoring thinking blocks. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Two or three sentences on what this video actually said. Concrete, not 'the creator discusses X'.",
    },
    claims: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific checkable claims: predictions with numbers or dates, factual assertions, recommendations. Empty array if the video made none.",
    },
    so_what: {
      type: "string",
      description:
        "One sentence on why this matters to the reader, or plainly that it doesn't.",
    },
  },
  required: ["summary", "claims", "so_what"],
  additionalProperties: false,
} as const;

/** Summarize one video. Auto-captions are messy, so the prompt says so —
 *  otherwise the model over-trusts garbled numbers and launders them into
 *  confident-sounding claims. */
export async function summarizeVideo(
  meta: VideoMeta,
  transcript: string
): Promise<VideoSummary> {
  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS;
  const body = truncated
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS)
    : transcript;

  const message = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SUMMARY_SCHEMA },
    },
    system:
      "You summarize video transcripts for a daily reading brief. The reader " +
      "is short on time and wants substance, not throat-clearing.\n\n" +
      "The transcript is machine-generated, so numbers and names are often " +
      "garbled — 'three twenty' could be $3.20 or $320, and tickers get " +
      "mangled. Quote a figure only when the transcript makes it unambiguous; " +
      "otherwise describe the claim without inventing precision.\n\n" +
      "Record what the speaker said. Do not endorse it, argue with it, or add " +
      "your own view of whether they are right.",
    messages: [
      {
        role: "user",
        content:
          `Title: ${meta.title}\n` +
          `Channel: ${meta.channel ?? "unknown"}\n` +
          `Published: ${meta.published ?? "unknown"}\n` +
          (truncated
            ? `\n[Transcript truncated to the first ${MAX_TRANSCRIPT_CHARS.toLocaleString()} characters.]\n`
            : "") +
          `\n---\n${body}`,
      },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("Summarization refused for this video");
  }

  const parsed = JSON.parse(textOf(message)) as {
    summary: string;
    claims: string[];
    so_what: string;
  };
  return {
    meta,
    summary: parsed.summary,
    claims: parsed.claims ?? [],
    soWhat: parsed.so_what,
  };
}

const OVERVIEW_SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description: "A short, specific headline for the day. Not a topic label.",
    },
    overview: {
      type: "string",
      description:
        "Three to five sentences covering the day as a whole. Name specifics.",
    },
    throughlines: {
      type: "array",
      items: { type: "string" },
      description:
        "Things worth noticing across the set: agreement between creators, direct contradictions, or a claim that is newly checkable. Empty if the day was unremarkable.",
    },
  },
  required: ["headline", "overview", "throughlines"],
  additionalProperties: false,
} as const;

/** Read the day's summaries together. Contradictions between creators are the
 *  most valuable output here and the easiest to miss video-by-video. */
export async function summarizeDay(
  summaries: VideoSummary[],
  date: string
): Promise<Pick<Brief, "headline" | "overview" | "throughlines">> {
  if (!summaries.length) {
    return {
      headline: "Nothing new today",
      overview: "None of your creators posted anything new.",
      throughlines: [],
    };
  }

  const digest = summaries
    .map(
      (s, i) =>
        `${i + 1}. ${s.meta.channel ?? "unknown"} — ${s.meta.title}\n` +
        `   ${s.summary}\n` +
        (s.claims.length ? `   Claims: ${s.claims.join(" | ")}\n` : "") +
        `   So what: ${s.soWhat}`
    )
    .join("\n\n");

  const message = await client().messages.create({
    model: MODEL,
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: OVERVIEW_SCHEMA },
    },
    system:
      "You write the top of a daily brief covering several creators the " +
      "reader follows. Lead with what happened, name specifics, and keep it " +
      "to what a busy reader needs.\n\n" +
      "Where two creators disagree, say so explicitly and name both — " +
      "contradictions are the most useful thing you can surface. Where they " +
      "all say the same thing, note that too: agreement among people in the " +
      "same niche is weak evidence, not strong.\n\n" +
      "If the day was thin, say so in a sentence rather than inflating it.",
    messages: [{ role: "user", content: `Date: ${date}\n\n${digest}` }],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("Day overview refused");
  }
  return JSON.parse(textOf(message));
}
