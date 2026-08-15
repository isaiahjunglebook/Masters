import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whisper transcription needs three command-line programs that don't ship with
 * this app. Rather than failing with a raw ENOENT deep inside a download, we
 * check up front and report exactly what's missing and how to install it —
 * the difference between "this is broken" and "run one command".
 */

export interface ToolStatus {
  name: string;
  installed: boolean;
  /** Which binary satisfied it, when several can. */
  found?: string;
  version?: string;
  purpose: string;
  install: string;
}

export interface SetupStatus {
  ready: boolean;
  tools: ToolStatus[];
  /** One command that installs everything missing. */
  installCommand: string | null;
}

/** Does this binary exist and run? Returns its version line if so. */
async function probe(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 15_000 });
    return (stdout || stderr).trim().split("\n")[0].slice(0, 80);
  } catch {
    return null;
  }
}

/** Whisper comes in two flavours people actually install. whisper.cpp is much
 *  faster on Apple Silicon but needs a model file passed to it; openai-whisper
 *  is slower and downloads its own models, which makes it the easier default
 *  for someone who just wants it to work. */
export async function findWhisper(): Promise<{ bin: string; kind: "cpp" | "openai" } | null> {
  const cppModel = process.env.WHISPER_MODEL;
  if (cppModel) {
    for (const bin of ["whisper-cli", "whisper-cpp", "main"]) {
      if (await probe(bin, ["--help"])) return { bin, kind: "cpp" };
    }
  }
  if (await probe("whisper", ["--help"])) return { bin: "whisper", kind: "openai" };
  // whisper.cpp is installed but no model was configured — still report it so
  // the UI can say "set WHISPER_MODEL" rather than "whisper not installed".
  for (const bin of ["whisper-cli", "whisper-cpp"]) {
    if (await probe(bin, ["--help"])) return { bin, kind: "cpp" };
  }
  return null;
}

export async function checkSetup(): Promise<SetupStatus> {
  const [ytdlp, ffmpeg, whisper] = await Promise.all([
    probe("yt-dlp", ["--version"]),
    probe("ffmpeg", ["-version"]),
    findWhisper(),
  ]);

  const whisperVersion = whisper
    ? await probe(whisper.bin, whisper.kind === "openai" ? ["--help"] : ["--help"])
    : null;

  const tools: ToolStatus[] = [
    {
      name: "yt-dlp",
      installed: Boolean(ytdlp),
      version: ytdlp ?? undefined,
      purpose: "Downloads the audio track from a video",
      install: "brew install yt-dlp",
    },
    {
      name: "ffmpeg",
      installed: Boolean(ffmpeg),
      version: ffmpeg ?? undefined,
      purpose: "Converts audio to the format Whisper expects",
      install: "brew install ffmpeg",
    },
    {
      name: "whisper",
      installed: Boolean(whisper),
      found: whisper?.bin,
      version: whisperVersion ?? undefined,
      purpose: "Turns the audio into text",
      install: "brew install openai-whisper",
    },
  ];

  const missing = tools.filter((t) => !t.installed);
  return {
    ready: missing.length === 0,
    tools,
    installCommand: missing.length
      ? `brew install ${missing
          .map((t) => (t.name === "whisper" ? "openai-whisper" : t.name))
          .join(" ")}`
      : null,
  };
}
