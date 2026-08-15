#!/usr/bin/env node
/**
 * The daily scrape → archive → brief run.
 *
 *   npm run daily              # normal run
 *   npm run daily -- --since 3 # look back 3 days instead of 1
 *   npm run daily -- --dry-run # scrape and archive, skip summarizing and email
 *
 * Designed to be run by a scheduler on a machine that is sometimes asleep, so
 * it looks back over a window rather than assuming it ran yesterday: a laptop
 * closed for the weekend catches up on Monday instead of losing three days.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInnertube } from "../lib/youtube";
import { fetchTranscript } from "../lib/captions";
import { listCreators, updateCreator, type Creator } from "../lib/creators";
import { listChannelVideos, resolveChannelId, type VideoItem } from "../lib/channel";
import {
  archiveTranscript,
  detectDisappearances,
  readSeen,
  writeSeen,
  type SeenVideo,
} from "../lib/archive";
import { summarizeDay, summarizeVideo, type Brief, type VideoSummary } from "../lib/brief";
import { renderBriefHtml, renderBriefText } from "../lib/brief-html";
import { mailConfigured, sendBrief } from "../lib/mail";
import { BRIEFS_DIR, DATA_DIR } from "../lib/store";

// How many recent videos to inspect per channel. Generous enough that a
// channel posting several times a day is never missed, small enough to stay
// polite; the seen-index filters out everything already archived.
const LOOKBACK_VIDEOS = 15;
const DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tty = process.stdout.isTTY;
const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

interface Options {
  sinceDays: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  let sinceDays = 1;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--since") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("--since needs a positive number of days");
      }
      sinceDays = Math.floor(n);
    } else {
      throw new Error(`Unknown option "${argv[i]}"`);
    }
  }
  return { sinceDays, dryRun };
}

/** A video counts as new if we've never archived it AND it published inside
 *  the window. The date check keeps a newly-added creator from dumping its
 *  entire back catalogue into today's brief. */
function isInWindow(video: VideoItem, cutoff: Date): boolean {
  // The listing only carries relative dates ("3 days ago"), so parse those
  // rather than trusting an absolute field that isn't there.
  const text = video.published.toLowerCase();
  const match = text.match(/(\d+)\s*(minute|hour|day|week|month|year)/);
  if (!match) return /just now|moment/.test(text);
  const n = Number(match[1]);
  const unitDays: Record<string, number> = {
    minute: 0,
    hour: 0,
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  const ageDays = n * (unitDays[match[2]] ?? 365);
  const windowDays = (Date.now() - cutoff.getTime()) / 86_400_000;
  return ageDays <= windowDays;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const nowIso = now.toISOString();
  const date = nowIso.slice(0, 10);
  const cutoff = new Date(now.getTime() - opts.sinceDays * 86_400_000);

  const creators = await listCreators();
  if (!creators.length) {
    console.log(
      c.yellow("No creators on the list yet.") +
        `\nAdd some in the web app (npm run dev → Creators tab), or edit ${resolve(
          DATA_DIR,
          "creators.json"
        )}.`
    );
    process.exit(1);
  }

  console.log(
    `${c.bold("Daily brief")} ${c.dim(date)} — ${creators.length} creator(s), ` +
      `looking back ${opts.sinceDays} day(s)\n`
  );

  const yt = await createInnertube();
  const seen = await readSeen();
  const problems: string[] = [];
  const fresh: { creator: Creator; video: VideoItem }[] = [];
  const stillPresent = new Set<string>();
  const scrapedCreatorIds = new Set<string>();

  // --- Scrape each channel ------------------------------------------------
  for (const creator of creators) {
    process.stdout.write(`${c.dim("scan")} ${creator.name} … `);
    try {
      const channelId =
        creator.channelId ?? (await resolveChannelId(yt, creator.input));
      if (!channelId) throw new Error("couldn't resolve channel");

      const { title, videos } = await listChannelVideos(
        yt,
        channelId,
        "recent",
        LOOKBACK_VIDEOS,
        creator.name
      );
      await updateCreator(creator.id, {
        channelId,
        name: title,
        lastError: undefined,
      });
      creator.name = title;
      scrapedCreatorIds.add(creator.id);

      for (const video of videos) stillPresent.add(video.id);
      const newOnes = videos.filter(
        (v) => !seen[v.id] && isInWindow(v, cutoff)
      );
      for (const video of newOnes) fresh.push({ creator, video });
      console.log(
        newOnes.length
          ? c.green(`${newOnes.length} new`)
          : c.dim("nothing new")
      );
    } catch (err: any) {
      const reason = err?.message ?? "unknown error";
      problems.push(`${creator.name}: ${reason}`);
      await updateCreator(creator.id, { lastError: reason });
      console.log(c.red(`failed — ${reason}`));
    }
    await sleep(DELAY_MS);
  }

  // --- Fetch and archive transcripts --------------------------------------
  const summaries: VideoSummary[] = [];
  if (fresh.length) console.log();

  for (let i = 0; i < fresh.length; i++) {
    const { creator, video } = fresh[i];
    process.stdout.write(
      `${c.dim(`[${i + 1}/${fresh.length}]`)} ${video.title.slice(0, 55)} … `
    );

    const record: SeenVideo = {
      id: video.id,
      title: video.title,
      channel: creator.name,
      creatorId: creator.id,
      published: null,
      publishedAt: null,
      url: video.url,
      firstSeen: nowIso,
      checkedAt: nowIso,
      transcriptFile: null,
    };

    try {
      const { meta, text } = await fetchTranscript(yt, video.id, video.title);
      record.published = meta.published;
      record.publishedAt = meta.published_at;
      record.title = meta.title;
      record.channel = meta.channel ?? creator.name;
      record.transcriptFile = await archiveTranscript(creator.id, meta, text);
      console.log(c.green(`archived`) + c.dim(` ${text.length.toLocaleString()} chars`));

      if (!opts.dryRun) {
        try {
          summaries.push(await summarizeVideo(meta, text));
        } catch (err: any) {
          // The transcript is safely archived either way — a summarization
          // failure must not lose it.
          problems.push(`Couldn't summarize "${meta.title}": ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      const reason = (err?.message ?? "unknown error").split(" Details:")[0];
      record.skipReason = reason;
      problems.push(`No transcript for "${video.title}": ${reason}`);
      console.log(c.yellow(`no transcript — ${reason.slice(0, 60)}`));
    }

    seen[video.id] = record;
    if (i < fresh.length - 1) await sleep(DELAY_MS);
  }

  // --- Deletions ----------------------------------------------------------
  const gone = detectDisappearances(seen, scrapedCreatorIds, stillPresent, nowIso);
  await writeSeen(seen);
  if (gone.length) {
    console.log(
      `\n${c.yellow(`${gone.length} video(s) removed from a channel since last check`)}`
    );
  }

  if (opts.dryRun) {
    console.log(`\n${c.bold("Dry run.")} Archived ${fresh.length}, no brief written.`);
    return;
  }

  // --- Build and deliver the brief ----------------------------------------
  let overview: Pick<Brief, "headline" | "overview" | "throughlines">;
  try {
    overview = await summarizeDay(summaries, date);
  } catch (err: any) {
    problems.push(`Couldn't write the day overview: ${err?.message ?? err}`);
    overview = {
      headline: `${summaries.length} new video(s)`,
      overview: "The overview couldn't be generated; per-video summaries follow.",
      throughlines: [],
    };
  }

  const brief: Brief = {
    date,
    ...overview,
    videos: summaries,
    disappeared: gone.map((g) => ({
      title: g.title,
      url: g.url,
      channel: g.channel,
    })),
    problems,
  };

  await mkdir(BRIEFS_DIR, { recursive: true });
  const htmlPath = resolve(BRIEFS_DIR, `${date}.html`);
  await writeFile(htmlPath, renderBriefHtml(brief), "utf8");

  const mail = await sendBrief(
    `${date} — ${brief.headline}`,
    renderBriefHtml(brief),
    renderBriefText(brief)
  );

  console.log(
    `\n${c.bold("Done.")} ${c.green(`${summaries.length} summarized`)}` +
      (problems.length ? `, ${c.yellow(`${problems.length} problem(s)`)}` : "") +
      `\n${c.dim(htmlPath)}`
  );
  if (mail.sent) {
    console.log(c.dim(`Emailed to ${process.env.BRIEF_TO}`));
  } else if (mailConfigured()) {
    console.log(c.yellow(`Email failed: ${mail.reason}`));
  } else {
    console.log(c.dim("Email not configured — open the HTML file above."));
  }
  for (const p of problems) console.log(c.dim(`  · ${p}`));
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err?.message ?? err}`));
  process.exit(1);
});
