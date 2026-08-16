#!/usr/bin/env node
/**
 * Summarize archived transcripts on this machine, using Ollama.
 *
 *   npm run summarize                  # anything archived today
 *   npm run summarize -- --since 7     # the last week
 *   npm run summarize -- --all         # the whole archive
 *   npm run summarize -- --model qwen3:32b
 *
 * Writes SUMMARIES.md next to the archive and, on the next bundle, ships it
 * inside the zip — so the Claude conversation reads twenty summaries instead
 * of twenty full transcripts, which is both faster and far easier to reason
 * across.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSeen } from "../lib/archive";
import { checkOllama, summarizeLocally, type LocalSummary } from "../lib/ollama";
import { ARCHIVE_DIR, DATA_DIR, readJson, writeJson } from "../lib/store";

const SUMMARY_STORE = resolve(DATA_DIR, "summaries.json");
const SUMMARY_DOC = resolve(DATA_DIR, "SUMMARIES.md");

const tty = process.stdout.isTTY;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

const USAGE = `
${c.bold("Summarize archived transcripts locally with Ollama")}

  npm run summarize [options]

Options:
  --since <n>     Videos archived in the last n days (default 1)
  --all           Everything in the archive
  --model <name>  Which Ollama model to use (default: best one installed)
  --redo          Re-summarize videos that already have a summary
  --help          Show this message
`;

interface Options {
  sinceDays: number;
  all: boolean;
  model: string | null;
  redo: boolean;
}

function parseArgs(argv: string[]): Options | null {
  let sinceDays = 1;
  let all = false;
  let model: string | null = null;
  let redo = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--all") all = true;
    else if (arg === "--redo") redo = true;
    else if (arg === "--since" || arg === "--model") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--since") {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`--since must be a positive number, got "${value}"`);
        }
        sinceDays = Math.floor(n);
      } else model = value;
    } else throw new Error(`Unknown option "${arg}"`);
  }
  return { sinceDays, all, model, redo };
}

/** Pull just the words out of a master transcript, skipping the metadata
 *  header and the description so the model spends its context on speech. */
function transcriptBody(file: string): string {
  const marker = file.indexOf("--- TRANSCRIPT");
  if (marker === -1) return file;
  const afterHeading = file.indexOf("\n", marker);
  return afterHeading === -1 ? file : file.slice(afterHeading + 1).trim();
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

  const status = await checkOllama();
  if (!status.running) {
    console.error(
      c.red(`\nOllama isn't running (${status.error ?? "no response"}).`) +
        `\n\nStart it with:  ${c.bold("ollama serve")}` +
        `\nOr install it:  ${c.bold("brew install ollama")}\n`
    );
    process.exit(1);
  }
  const model = opts.model ?? status.preferred;
  if (!model) {
    console.error(
      c.red("\nOllama is running but has no models installed.") +
        `\n\nPull one:  ${c.bold("ollama pull qwen3:32b")}\n`
    );
    process.exit(1);
  }
  if (opts.model && !status.models.some((m) => m === opts!.model)) {
    console.log(
      c.yellow(`Note: "${opts.model}" isn't in the installed list — Ollama will try to pull it.\n`)
    );
  }

  const seen = await readSeen();
  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  const existing = await readJson<Record<string, LocalSummary & { title: string; channel: string | null; published: string | null }>>(
    SUMMARY_STORE,
    {}
  );

  const targets = Object.values(seen).filter((v) => {
    if (!v.transcriptFile) return false;
    if (!opts!.redo && existing[v.id]) return false;
    if (opts!.all) return true;
    const at = Date.parse(v.firstSeen);
    return Number.isNaN(at) ? true : at >= cutoff;
  });

  if (!targets.length) {
    console.log(
      c.yellow("Nothing to summarize.") +
        " Try --since 7, --all, or --redo to redo existing ones."
    );
    process.exit(0);
  }

  console.log(
    `${c.bold("Summarizing")} ${targets.length} transcript(s) with ${c.bold(model)}\n` +
      c.dim("A big model on a laptop takes a minute or two each. Leave it running.\n")
  );

  let done = 0;
  const problems: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const video = targets[i];
    process.stdout.write(
      `${c.dim(`[${i + 1}/${targets.length}]`)} ${video.title.slice(0, 55)} … `
    );
    try {
      const raw = await readFile(resolve(ARCHIVE_DIR, video.transcriptFile!), "utf8");
      const summary = await summarizeLocally(
        video.title,
        video.channel,
        video.published,
        transcriptBody(raw),
        model
      );
      existing[video.id] = {
        ...summary,
        title: video.title,
        channel: video.channel,
        published: video.published,
      };
      // Save after each one: a 70B model over fifty videos is a long run, and
      // losing all of it to one failure at the end would be miserable.
      await writeJson(SUMMARY_STORE, existing);
      done++;
      console.log(c.green(`done`) + c.dim(` ${summary.seconds}s, ${summary.claims.length} claim(s)`));
    } catch (err: any) {
      const reason = err?.message ?? String(err);
      problems.push(`${video.title}: ${reason}`);
      console.log(c.yellow(`failed — ${reason.slice(0, 70)}`));
    }
  }

  // A single readable document, sorted oldest-first so it reads as a timeline.
  const rows = Object.values(existing).sort((a, b) =>
    (a.published ?? "").localeCompare(b.published ?? "")
  );
  const doc = [
    `# Summaries`,
    ``,
    `${rows.length} video(s), summarized locally with ${model}.`,
    ``,
    ...rows.flatMap((s) => [
      `## ${s.published ?? "undated"} — ${s.channel ?? "unknown"}`,
      `**${s.title}**`,
      ``,
      s.summary,
      ``,
      ...(s.claims.length
        ? [`Claims:`, ...s.claims.map((cl) => `- ${cl}`), ``]
        : []),
      `_So what:_ ${s.soWhat}`,
      ``,
    ]),
  ].join("\n");
  await writeFile(SUMMARY_DOC, doc, "utf8");

  console.log(
    `\n${c.bold("Done.")} ${c.green(`${done} summarized`)}` +
      (problems.length ? `, ${c.yellow(`${problems.length} failed`)}` : "") +
      `\n${c.dim(SUMMARY_DOC)}\n\n` +
      `Run ${c.bold("npm run bundle")} to pack these for a Claude conversation.`
  );
  for (const p of problems) console.log(c.dim(`  · ${p}`));
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err?.message ?? err}`));
  process.exit(1);
});
