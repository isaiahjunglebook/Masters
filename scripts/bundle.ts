#!/usr/bin/env node
/**
 * Pack archived transcripts into a zip for a Claude conversation.
 *
 *   npm run bundle                    # everything archived today
 *   npm run bundle -- --since 7       # the last 7 days
 *   npm run bundle -- --creator @name # one creator's whole archive
 *   npm run bundle -- --all           # the entire archive
 *
 * Writes to data/bundles/. Drag the zip into Claude, or point a Claude Code
 * session at the unzipped folder.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSeen } from "../lib/archive";
import { buildBundle } from "../lib/bundle";
import { BUNDLES_DIR } from "../lib/store";

const tty = process.stdout.isTTY;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

const USAGE = `
${c.bold("Pack archived transcripts into a zip for Claude")}

  npm run bundle [options]

Options:
  --since <n>       Include videos archived in the last n days (default 1)
  --creator <id>    Only this creator (matches the id in data/creators.json)
  --all             Everything in the archive, ignoring --since
  --out <file>      Write here instead of data/bundles/
  --help            Show this message
`;

interface Options {
  sinceDays: number;
  creator: string | null;
  all: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): Options | null {
  let sinceDays = 1;
  let creator: string | null = null;
  let all = false;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--all") {
      all = true;
    } else if (arg === "--since" || arg === "--creator" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--since") {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`--since must be a positive number, got "${value}"`);
        }
        sinceDays = Math.floor(n);
      } else if (arg === "--creator") {
        creator = value;
      } else {
        out = value;
      }
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }
  }
  return { sinceDays, creator, all, out };
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
    process.exit(0);
  }

  const seen = await readSeen();
  const allVideos = Object.values(seen);
  if (!allVideos.length) {
    console.log(
      c.yellow("Nothing archived yet.") + " Run `npm run daily` first."
    );
    process.exit(1);
  }

  // Filter on firstSeen (when this scraper archived it), not the publish date:
  // a video posted last month but discovered today belongs in today's bundle.
  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  let videos = allVideos.filter((v) => {
    if (opts!.creator && v.creatorId !== opts!.creator) return false;
    if (opts!.all) return true;
    const seenAt = Date.parse(v.firstSeen);
    return Number.isNaN(seenAt) ? true : seenAt >= cutoff;
  });

  videos.sort((a, b) =>
    (a.published ?? "").localeCompare(b.published ?? "")
  );

  if (!videos.length) {
    console.log(
      c.yellow("Nothing matched.") +
        ` Try ${c.bold("--since 7")} or ${c.bold("--all")}.`
    );
    process.exit(1);
  }

  const window = opts.all
    ? "full archive"
    : `last ${opts.sinceDays} day${opts.sinceDays === 1 ? "" : "s"}`;
  const label = opts.creator ? `${opts.creator}, ${window}` : window;

  const { buffer, included, skipped } = await buildBundle(videos, label);

  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${stamp}-${opts.creator ?? (opts.all ? "archive" : "brief")}.zip`;
  const target = opts.out
    ? resolve(process.cwd(), opts.out)
    : resolve(BUNDLES_DIR, name);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, buffer);

  console.log(
    `${c.bold("Bundled.")} ${c.green(`${included} transcript(s)`)}` +
      (skipped ? `, ${c.yellow(`${skipped} without one`)}` : "") +
      `\n${c.dim(target)}\n\n` +
      `Drop that zip into a Claude chat and paste PROMPT.md from inside it.`
  );
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err?.message ?? err}`));
  process.exit(1);
});
