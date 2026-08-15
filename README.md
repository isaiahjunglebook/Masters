# YouTube Caption Downloader

Download a YouTube channel's auto-generated captions as `.txt` transcripts —
from the **terminal** (`npm run captions`) or a **web page** (`npm run dev`).
Both share one engine in `lib/`.

- **No accounts, no OAuth, no API keys, no database.** Runs open locally with
  no login. An optional shared password (`PAGE_PASSWORD`) can gate the page if
  you deploy it to a public URL.

## Quick start (terminal — recommended)

Running on your own machine uses your home IP, which YouTube doesn't block —
so no cookie or proxy is needed. Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install

# A whole channel (10 most recent by default)
npm run captions -- "https://www.youtube.com/@SomeChannel"

# More videos, most-viewed first
npm run captions -- "@SomeChannel" --count 25 --sort most_viewed

# Specific videos, saved somewhere else
npm run captions -- "https://youtu.be/VIDEO_ID" --out ~/Desktop/notes
```

Transcripts land in `./transcripts` (one `.txt` per video). Anything skipped
is explained in `transcripts/_skipped.txt`. Run `npm run captions -- --help`
for all options.
## Daily brief

Whitelist the creators you follow, and one command scrapes them, archives every
new video's transcript, and writes a summarized brief.

```bash
npm run dev          # add creators in the "Daily brief" tab at localhost:3000
npm run daily        # scrape, archive, summarize, deliver
npm run daily -- --since 3    # catch up after a few days away
npm run daily -- --dry-run    # scrape and archive only, no summarizing
```

Everything lands in `./data`:

| Path | What it is |
| --- | --- |
| `data/creators.json` | The whitelist |
| `data/archive/<creator>/<date> <title> [id].txt` | Every transcript, kept permanently |
| `data/seen.json` | What's been archived, and what has since disappeared |
| `data/briefs/<date>.html` | The brief itself |

Summarizing needs an [Anthropic API key](https://platform.claude.com) in
`ANTHROPIC_API_KEY`. Without one, `--dry-run` still scrapes and archives.

### Why the archive matters

The scrape re-checks each channel every run, so a video that vanishes from a
channel is recorded as gone (`missingSince`) while its transcript stays in your
archive. That turns deletions into data: a creator who quietly removes bad
calls is visible here and invisible to anyone analyzing the channel
retroactively. It's also the reason to start scraping before you need the data.

### Running it every morning (macOS)

`launchd` wakes the job on a schedule. Save this as
`~/Library/LaunchAgents/com.local.dailybrief.plist`, replacing the paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.dailybrief</string>
  <key>WorkingDirectory</key><string>/Users/YOU/Masters-main</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/npm</string><string>run</string><string>daily</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>EnvironmentVariables</key><dict>
    <key>ANTHROPIC_API_KEY</key><string>sk-ant-…</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/dailybrief.log</string>
  <key>StandardErrorPath</key><string>/tmp/dailybrief.err</string>
</dict></plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.local.dailybrief.plist`.

A closed laptop just delays the run — `launchd` fires the job when the Mac next
wakes, and `--since` covers any gap, so nothing is lost. To have the Mac wake
itself: `sudo pmset repeat wakeorpoweron MTWRFSU 06:25:00`.

### Emailing it

Optional. Set `RESEND_API_KEY` (from [resend.com](https://resend.com), free tier
is 100/day) and `BRIEF_TO`. Without them the brief is still written to
`data/briefs/` — open it in a browser.

## How it works

Shared engine, two front ends:

- **`lib/channel.ts`** — resolves a channel handle/URL and lists its videos
  using [youtubei.js](https://github.com/LuanRT/YouTube.js) (YouTube's internal
  API, no key needed). Sorting (recent / oldest / most viewed) uses the channel
  page's own Latest / Oldest / Popular filters, then returns the top N.
- **`lib/captions.ts`** — fetches a video's auto-generated transcript, trying
  the transcript panel first and then caption-track (timedtext) files across
  five YouTube clients, so one degraded response doesn't lose the video.
- **`scripts/captions.ts`** — the CLI: writes `.txt` files to a folder.
- **`app/api/*`** — the web app: same calls, streamed back as a zip via jszip.

Both wait ~1.5–2s between videos to stay polite to YouTube.

## Environment variables

| Variable            | Required | Purpose                                                        |
| ------------------- | -------- | -------------------------------------------------------------- |
| `PAGE_PASSWORD`     | no       | Optional password to gate a public deployment; unset = open     |
| `YOUTUBE_COOKIE`    | no       | Logged-in youtube.com Cookie header — beats the bot wall (free) |
| `PROXY_URL`         | no       | Residential proxy `http://user:pass@host:port` — beats the bot wall |
| `ANTHROPIC_API_KEY` | for briefs | Summarizes the daily brief (`npm run daily`)                 |
| `RESEND_API_KEY`    | no       | Emails the brief; without it the HTML file is still written    |
| `BRIEF_TO`          | no       | Where to send the brief                                        |
| `BRIEF_FROM`        | no       | Sender address; defaults to Resend's shared onboarding sender  |
| `DATA_DIR`          | no       | Where the archive lives; defaults to `./data`                   |

### The YouTube bot wall

YouTube blocks requests from cloud datacenter IPs (Vercel's included) with
"Sign in to confirm you're not a bot" (`LOGIN_REQUIRED`). When that happens,
caption downloads fail even though the videos clearly have captions.

**Built-in defense (automatic):** the app tries to mint a YouTube *PO token*
(a BotGuard "proof of origin" attestation, generated by running Google's own
attestation VM server-side) and attaches it when minting succeeds. It also
tries five different YouTube clients per video (web, Android, iOS, TV,
embedded player) before giving up. Both are free and need no setup.

Note that BotGuard often rejects a headless (jsdom) environment outright —
minting then logs `[potoken] minting failed: APF:Failed` and the app carries
on without a token. Even when minting succeeds, a PO token does **not**
override an IP that YouTube has already flagged. On Vercel, expect to need
one of the two workarounds below:

- **`YOUTUBE_COOKIE` (free):** log into youtube.com in a desktop browser, open
  DevTools → Network → click any youtube.com request → copy the full `Cookie`
  request header value and paste it as the env var. Cookies expire every few
  weeks/months (re-export when downloads start failing again). Automated use of
  a logged-in session carries a small risk of Google flagging the account, so
  prefer a throwaway Google account over your personal one — the cookie only
  needs to be able to watch public videos. (A cookie from an account that is a
  member of a given channel also unlocks that channel's members-only videos.)
- **`PROXY_URL` (a few $/mo):** a rotating *residential* proxy from a provider
  like Webshare or Decodo (datacenter proxies won't help — they're blocked for
  the same reason Vercel is). No account risk.

Running locally (`npm run dev`) from a home connection usually needs neither.

**Members-only videos** ("Join this channel to get access…") are a different
error, not the bot wall: YouTube only serves them to paying members of that
channel. They can't be downloaded unless `YOUTUBE_COOKIE` comes from an
account that is a member of the channel.

## Local web UI

Prefer clicking to typing? Same thing with a checklist of videos:

```bash
npm install
npm run dev
```

Open http://localhost:3000 and paste a channel URL — no password needed
locally. (To gate the page, copy `.env.local.example` to `.env.local` and set
`PAGE_PASSWORD`.)

## Deploying to Vercel

1. Push this repo to GitHub.
2. In the [Vercel dashboard](https://vercel.com/dashboard) click
   **Add New… → Project**, import the repo. Vercel auto-detects Next.js —
   don't change build settings.
3. (Optional but recommended for a public URL) Under **Environment Variables**
   add `PAGE_PASSWORD` (all environments) to gate the page.
4. **Deploy**. Every push to the production branch redeploys automatically;
   pushes to other branches create preview URLs.

### Notes / limits

- `/api/captions` sets `maxDuration = 300` (5 min). At ~2.5s per video that
  comfortably covers ~100 videos per download. For bigger batches, download
  in chunks.
- Both video listing and transcript fetching go through YouTube's internal
  (Innertube) API via youtubei.js. YouTube changes this periodically — if the
  app suddenly starts failing, update the library and redeploy:
  `npm install youtubei.js@latest`, commit, push.
- Occasionally YouTube rate-limits or blocks datacenter IPs (which Vercel
  functions use). If you see many "sign in to confirm you're not a bot"-style
  skips, wait a while and retry — the built-in delay between videos keeps this
  rare for personal-scale use.
