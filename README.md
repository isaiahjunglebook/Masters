# YouTube Caption Downloader

A private, single-user Next.js app for downloading auto-generated captions
from a YouTube channel as a zip of `.txt` transcripts.

- **No accounts, no OAuth, no database.** A single shared password
  (`PAGE_PASSWORD`) gates the page since it lives on a public URL.
- **`/api/videos`** — resolves a channel handle/URL to its uploads playlist via
  the YouTube Data API, collects all videos, attaches view counts, sorts
  (recent / oldest / most viewed) and returns the top N.
- **`/api/captions`** — fetches each video's public auto-generated transcript
  with [youtubei.js](https://github.com/LuanRT/YouTube.js) (no OAuth needed),
  waits ~1.5–2s between videos, skips videos without captions, and streams
  back a zip (one `.txt` per video) built with jszip.

## Environment variables

| Variable          | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (server-side only, metadata lookups)   |
| `PAGE_PASSWORD`   | Shared password required to use the page                       |

## Local development

```bash
npm install
cp .env.local.example .env.local   # then fill in your values
npm run dev
```

Open http://localhost:3000, enter your `PAGE_PASSWORD`, paste a channel URL.

## Getting a YouTube Data API key

1. Go to https://console.cloud.google.com and create (or pick) a project.
2. **APIs & Services → Library** → search "YouTube Data API v3" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. (Recommended) Restrict the key to the YouTube Data API v3 only.

The free quota (10,000 units/day) is far more than this app needs.

## Deploying to Vercel

1. Push this repo to GitHub.
2. In the [Vercel dashboard](https://vercel.com/dashboard) click
   **Add New… → Project**, import the repo. Vercel auto-detects Next.js —
   don't change build settings.
3. Before deploying, expand **Environment Variables** and add
   `YOUTUBE_API_KEY` and `PAGE_PASSWORD` (all environments is fine).
4. **Deploy**. Every push to the production branch (usually `main`)
   redeploys automatically; pushes to other branches create preview URLs.

### Notes / limits

- `/api/captions` sets `maxDuration = 300` (5 min). At ~2.5s per video that
  comfortably covers ~100 videos per download. For bigger batches, download
  in chunks.
- Transcript fetching relies on YouTube's internal (Innertube) API via
  youtubei.js. YouTube changes this periodically — if caption downloads start
  failing while video listing still works, update the library:
  `npm install youtubei.js@latest`.
- Occasionally YouTube rate-limits or blocks datacenter IPs (which Vercel
  functions use). If you see many "sign in to confirm you're not a bot"-style
  skips, wait a while and retry — the built-in delay between videos keeps this
  rare for personal-scale use.
