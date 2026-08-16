/**
 * Local summarization via Ollama.
 *
 * The division of labour matters more than the model choice: a local model
 * handles the per-video pass well (one document in, a summary out — contained,
 * mechanical, and the high-volume part), but cross-creator synthesis over tens
 * of thousands of tokens of garbled auto-caption text is where small models
 * lose the thread. So this does the first job and leaves the second to the
 * bundle you hand to Claude — which is also much cheaper to read once the
 * transcripts have been reduced to summaries.
 */

const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

/** Long transcripts need a long context; the default 2048-token window would
 *  silently truncate most videos and summarize only the intro. */
const CONTEXT_TOKENS = Number(process.env.OLLAMA_CONTEXT ?? 16384);

/** Rough chars-per-token for English; used to keep input inside the window
 *  rather than letting Ollama drop the tail without saying so. */
const CHARS_PER_TOKEN = 4;

export interface OllamaStatus {
  running: boolean;
  models: string[];
  /** The model we'd use, picked from what's installed. */
  preferred: string | null;
  error?: string;
}

/** Models worth using for this, best first. Anything installed that isn't on
 *  the list still works — this only decides the default. */
const PREFERENCE = [
  "llama3.3:70b",
  "qwen3:32b",
  "qwen2.5:32b",
  "gpt-oss:20b",
  "mistral-small",
  "llama3.1:8b",
  "llama3.2",
];

export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { running: false, models: [], preferred: null, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    const configured = process.env.OLLAMA_MODEL;

    // An explicitly configured model wins, but only if it's actually pulled —
    // otherwise every request would fail with a confusing 404.
    const preferred =
      (configured && models.some((m) => m === configured || m.startsWith(`${configured}:`))
        ? configured
        : null) ??
      PREFERENCE.find((p) => models.some((m) => m === p || m.startsWith(`${p.split(":")[0]}:`))) ??
      models[0] ??
      null;

    return { running: true, models, preferred };
  } catch (err: any) {
    return {
      running: false,
      models: [],
      preferred: null,
      error: err?.name === "TimeoutError" ? "not responding" : "not running",
    };
  }
}

export interface LocalSummary {
  summary: string;
  claims: string[];
  soWhat: string;
  model: string;
  seconds: number;
}

const SYSTEM = `You summarize video transcripts for a reading brief.

The transcript is machine-generated, so numbers and names are often garbled —
"three twenty" could be $3.20 or $320, and tickers get mangled. Quote a figure
only when the transcript makes it unambiguous; otherwise describe the claim
without inventing precision.

Record what the speaker said. Do not endorse it, argue with it, or add your own
view of whether they are right.

Reply with JSON only, in exactly this shape:
{"summary": "two or three sentences on what this video actually said",
 "claims": ["specific checkable claims: predictions with numbers or dates, factual assertions, recommendations"],
 "so_what": "one sentence on why this matters, or plainly that it doesn't"}`;

/** Pull the JSON object out of a reply, tolerating the fenced code blocks and
 *  leading prose that local models often add despite being told not to. */
function parseJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost braces.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`model didn't return JSON: ${candidate.slice(0, 120)}`);
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export async function summarizeLocally(
  title: string,
  channel: string | null,
  published: string | null,
  transcript: string,
  model: string
): Promise<LocalSummary> {
  const started = Date.now();

  // Leave room for the system prompt and the reply. Truncating here — and
  // saying so in the prompt — beats letting the context window drop the tail
  // silently, which would summarize the intro and call it the video.
  const budget = CONTEXT_TOKENS * CHARS_PER_TOKEN - 2000;
  const truncated = transcript.length > budget;
  const body = truncated ? transcript.slice(0, budget) : transcript;

  const res = await fetch(`${HOST}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      system: SYSTEM,
      prompt:
        `Title: ${title}\nChannel: ${channel ?? "unknown"}\n` +
        `Published: ${published ?? "unknown"}\n` +
        (truncated ? `\n[Transcript truncated to fit the context window.]\n` : "") +
        `\n---\n${body}`,
      stream: false,
      format: "json",
      options: { num_ctx: CONTEXT_TOKENS, temperature: 0.2 },
    }),
    // A 70B model on a laptop is slow; this has to be generous or long videos
    // fail for no reason other than impatience.
    signal: AbortSignal.timeout(15 * 60_000),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Ollama HTTP ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as { response?: string };
  const parsed = parseJson(data.response ?? "");

  return {
    summary: String(parsed.summary ?? "").trim(),
    claims: Array.isArray(parsed.claims) ? parsed.claims.map(String) : [],
    soWhat: String(parsed.so_what ?? parsed.soWhat ?? "").trim(),
    model,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
