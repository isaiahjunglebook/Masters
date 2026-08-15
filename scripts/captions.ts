#!/usr/bin/env node
/**
 * Terminal transcript downloader.
 *
 *   npm run captions -- "https://www.youtube.com/@SomeChannel"
 *   npm run captions -- "@SomeChannel" --count 25 --sort most_viewed
 *   npm run captions -- "https://youtu.be/VIDEO_ID" "https://youtu.be/OTHER"
 *
 * Writes one .txt per video into ./transcripts (override with --out).
 * Same engine as the web app — just without the browser.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInnertube } from "../lib/youtube";
import { fetchTranscript, safeFilename, transcriptFile } from "../lib/captions";
import {
  extractVideoIds,
  listChannelVideos,
  resolveChannelId,
  videosForIds,
  SORT_MODES,
  type SortMode,
  type VideoItem,
} from "../lib/channel";

const DELAY_MS_MIN = 1500;
const DELAY_MS_JITTER = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bare minimum ANSI so progress is readable; disabled when piping to a file.
const tty = process.stdout.isTTY;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

const USAGE = `
${c.bold("Download YouTube auto-caption transcripts as .txt files")}

  npm run captions -- <channel-url-or-@handle> [options]
  npm run captions -- <video-url> [<video-url> ...] [options]

Options:
  --count <n>    How many videos to take from the channel   (default 10)
  --sort <mode>  recent | oldest | most_viewed              (default recent)
  --out <dir>    Where to write the .txt files              (default ./transcripts)
  --help         Show this message

Examples:
  npm run captions -- "https://www.youtube.com/@veritasium"
  npm run captions -- "@veritasium" --count 25 --sort most_viewed
  npm run captions -- "https://youtu.be/aircAruvnKk" --out ~/Desktop/notes
`;

interface Options {
  inputs: string[];
  count: number;
  sort: SortMode;
  out: string;
}

/** Parse argv into options, erroring on anything malformed rather than
 *  silently downloading the wrong thing. */
function parseArgs(argv: string[]): Options | null {
  const inputs: string[] = [];
  let count = 10;
  let sort: SortMode = "recent";
  let out = "transcripts";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--count" || arg === "--sort" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--count") {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`--count must be a positive number, got "${value}"`);
        }
        count = Math.min(500, Math.floor(n));
      } else if (arg === "--sort") {
        if (!SORT_MODES.includes(value as SortMode)) {
          throw new Error(`--sort must be one of ${SORT_MODES.join(" | ")}`);
        }
        sort = value as SortMode;
      } else {
        out = value;
      }
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    inputs.push(arg);
  }

  if (!inputs.length) return null;
  return { inputs, count, sort, out };
}

/** Resolve CLI inputs to the list of videos to download: either specific
 *  videos (when every input contains a video id) or a channel's feed. */
async function resolveVideos(yt: any, opts: Options): Promise<VideoItem[]> {
  const ids = extractVideoIds(opts.inputs.join("\n"));
  // A channel URL never contains an 11-char video id, so ids-present means the
  // user pasted videos. Handles/@names can look like bare ids, so require that
  // the input actually looks like a video URL before taking this branch.
  const looksLikeVideos = opts.inputs.every((i) =>
    /youtube\.com\/(watch|shorts|embed|live|v)\/?|youtu\.be\//i.test(i)
  );
  if (ids.length && looksLikeVideos) {
    console.log(c.dim(`Looking up ${ids.length} video(s)…`));
    return videosForIds(yt, ids);
  }

  if (opts.inputs.length > 1) {
    throw new Error(
      "Pass one channel, or a list of video URLs — not a mix. See --help."
    );
  }
  const input = opts.inputs[0];
  console.log(c.dim(`Resolving channel "${input}"…`));
  const channelId = await resolveChannelId(yt, input);
  if (!channelId) throw new Error(`Couldn't find a channel for "${input}"`);

  const { title, videos } = await listChannelVideos(
    yt,
    channelId,
    opts.sort,
    opts.count,
    input
  );
  console.log(
    `${c.bold(title)} — ${videos.length} video(s), sorted by ${opts.sort}\n`
  );
  return videos;
}

async function main() {
  let opts: Options | null;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err: any) {
    console.error(c.red(`\n${err.message}`));
    console.error(USAGE);
    process.exit(2);
  }
  if (!opts) {
    console.log(USAGE);
    process.exit(process.argv.length > 2 ? 0 : 1);
  }

  const outDir = resolve(process.cwd(), opts.out);
  const yt = await createInnertube();
  const videos = await resolveVideos(yt, opts);
  if (!videos.length) {
    console.log(c.yellow("No videos found."));
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });

  const skipped: { title: string; reason: string }[] = [];
  let saved = 0;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const label = `[${i + 1}/${videos.length}]`;
    process.stdout.write(`${c.dim(label)} ${video.title.slice(0, 60)} … `);
    try {
      const { title, text } = await fetchTranscript(yt, video.id, video.title);
      const file = resolve(outDir, safeFilename(title, video.id));
      await writeFile(file, transcriptFile(title, video.id, text), "utf8");
      saved++;
      console.log(c.green(`saved (${text.length.toLocaleString()} chars)`));
    } catch (err: any) {
      const reason = err?.message ?? "Unknown error";
      skipped.push({ title: video.title, reason });
      // Show only the human-readable half of the reason here; the full
      // diagnostic (every client's error) goes in _skipped.txt.
      console.log(c.yellow(`skipped — ${reason.split(" Details:")[0]}`));
    }
    // Be polite: pause between videos (but not after the last one)
    if (i < videos.length - 1) {
      await sleep(DELAY_MS_MIN + Math.random() * DELAY_MS_JITTER);
    }
  }

  if (skipped.length) {
    await writeFile(
      resolve(outDir, "_skipped.txt"),
      skipped.map((s) => `${s.title}\n  ${s.reason}\n`).join("\n") + "\n",
      "utf8"
    );
  }

  console.log(
    `\n${c.bold("Done.")} ${c.green(`${saved} saved`)}` +
      (skipped.length ? `, ${c.yellow(`${skipped.length} skipped`)}` : "") +
      `\n${c.dim(outDir)}`
  );
  if (skipped.length) {
    console.log(c.dim(`Reasons: ${resolve(outDir, "_skipped.txt")}`));
  }
  // Nothing saved at all is a failure worth a non-zero exit code.
  if (!saved) process.exit(1);
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err?.message ?? err}`));
  process.exit(1);
});
