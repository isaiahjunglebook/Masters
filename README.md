# YouTube Caption Downloader

A private, single-user Next.js app for downloading auto-generated captions
from a YouTube channel as a zip of `.txt` transcripts.

- **No accounts, no OAuth, no API keys, no database.** A single shared password
  (`PAGE_PASSWORD`) gates the page since it lives on a public URL.
- **`/api/videos`** — resolves a channel handle/URL and lists its videos using
  [youtubei.js](https://github.com/LuanRT/YouTube.js) (YouTube's internal API,
  no key needed). Sorting (recent / oldest / most viewed) uses the channel
  page's own Latest / Oldest / Popular filters, then returns the top N.
- **`/api/captions`** — fetches each video's public auto-generated transcript
  with youtubei.js, waits ~1.5–2s between videos, skips videos without
  captions, and streams back a zip (one `.txt` per video) built with jszip.

## Environment variables

| Variable        | Purpose                                  |
| --------------- | ---------------------------------------- |
| `PAGE_PASSWORD` | Shared password required to use the page |

## Local development

```bash
npm install
cp .env.local.example .env.local   # then set your password
npm run dev
```

Open http://localhost:3000, enter your `PAGE_PASSWORD`, paste a channel URL.

## Deploying to Vercel

1. Push this repo to GitHub.
2. In the [Vercel dashboard](https://vercel.com/dashboard) click
   **Add New… → Project**, import the repo. Vercel auto-detects Next.js —
   don't change build settings.
3. Under **Environment Variables** add `PAGE_PASSWORD` (all environments).
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
