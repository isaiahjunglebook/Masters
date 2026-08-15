import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { findWhisper } from "./tools";

const run = promisify(execFile);

/**
 * Audio → text via yt-dlp and Whisper.
 *
 * The audio file is a means, not an artifact: it's written to a temp folder,
 * transcribed, and deleted in a `finally` so it disappears even when
 * transcription fails. Nothing accumulates on disk.
 *
 * Bitrate is deliberately low. Whisper resamples everything to 16 kHz mono
 * before it sees a sample, so a bigger download buys nothing but bytes — we
 * ask for the smallest audio-only stream and convert it to exactly what
 * Whisper wants.
 */

/** Domain words the transcriber would otherwise mangle. Whisper conditions on
 *  this text, and it measurably improves jargon and ticker accuracy — the
 *  single biggest quality lever here, and the one most people skip. */
const DEFAULT_PROMPT =
  "Crypto and markets discussion. Terms: XRP, Ripple, BTC, Bitcoin, ETH, " +
  "Ethereum, SEC, ETF, altcoin, satoshi, resistance, support, accumulation, " +
  "capitulation, market cap, all-time high, bull run, bear market.";

export interface AudioTranscript {
  text: string;
  /** Which whisper binary produced it, for the record. */
  engine: string;
  seconds: number;
}

/** Whisper models, smallest first. `small.en` is the sweet spot for English
 *  speech on a laptop; `medium.en` is noticeably better on jargon but slow. */
const DEFAULT_MODEL = process.env.WHISPER_MODEL_NAME ?? "small.en";

export async function transcribeAudio(
  videoId: string,
  options: { prompt?: string; timeoutMs?: number } = {}
): Promise<AudioTranscript> {
  const whisper = await findWhisper();
  if (!whisper) {
    throw new Error(
      "Whisper isn't installed — run: brew install openai-whisper"
    );
  }

  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "yt-audio-"));
  const audioPath = resolve(dir, `${videoId}.wav`);
  const timeout = options.timeoutMs ?? 45 * 60_000;

  try {
    // Smallest audio-only stream, converted to 16 kHz mono WAV — exactly
    // Whisper's input format, so it does no resampling of its own.
    await run(
      "yt-dlp",
      [
        "-f",
        "bestaudio[abr<=64]/bestaudio",
        "--extract-audio",
        "--audio-format",
        "wav",
        "--postprocessor-args",
        "-ar 16000 -ac 1",
        "--no-playlist",
        "--no-progress",
        "--quiet",
        "-o",
        resolve(dir, `${videoId}.%(ext)s`),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout, maxBuffer: 10 * 1024 * 1024 }
    );

    const prompt = options.prompt ?? DEFAULT_PROMPT;
    let text: string;

    if (whisper.kind === "openai") {
      await run(
        whisper.bin,
        [
          audioPath,
          "--model",
          DEFAULT_MODEL,
          "--language",
          "en",
          "--output_format",
          "txt",
          "--output_dir",
          dir,
          "--initial_prompt",
          prompt,
          "--fp16",
          "False",
        ],
        { timeout, maxBuffer: 50 * 1024 * 1024 }
      );
      text = await readFile(resolve(dir, `${videoId}.txt`), "utf8");
    } else {
      const model = process.env.WHISPER_MODEL;
      if (!model) {
        throw new Error(
          "whisper.cpp is installed but WHISPER_MODEL isn't set — point it at " +
            "a ggml model file, or install openai-whisper instead " +
            "(brew install openai-whisper)"
        );
      }
      await run(
        whisper.bin,
        [
          "-m", model,
          "-f", audioPath,
          "--output-txt",
          "--output-file", resolve(dir, videoId),
          "--language", "en",
          "--prompt", prompt,
        ],
        { timeout, maxBuffer: 50 * 1024 * 1024 }
      );
      text = await readFile(resolve(dir, `${videoId}.txt`), "utf8");
    }

    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) throw new Error("Whisper produced no text");

    return {
      text: cleaned,
      engine: `${whisper.bin} (${DEFAULT_MODEL})`,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (err: any) {
    // execFile surfaces the real reason on stderr; the bare message is useless.
    const detail = (err?.stderr || err?.message || String(err))
      .split("\n")
      .filter((l: string) => l.trim())
      .slice(-3)
      .join(" ")
      .slice(0, 300);
    throw new Error(detail || "audio transcription failed");
  } finally {
    // The audio is temporary by design — remove the whole working folder,
    // including any intermediate files yt-dlp left behind.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Confirm nothing was left behind. Used by tests and by the CLI's --verify. */
export async function tempAudioLeftovers(): Promise<string[]> {
  try {
    const entries = await readdir(tmpdir());
    return entries.filter((e) => e.startsWith("yt-audio-"));
  } catch {
    return [];
  }
}
