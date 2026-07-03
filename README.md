# YouTube Caption Downloader

A private, single-user Next.js app for downloading auto-generated captions
from a YouTube channel as a zip of `.txt` transcripts.

- **No accounts, no OAuth, no API keys, no database.** Runs open locally with
  no login. An optional shared password (`PAGE_PASSWORD`) can gate the page if
  you deploy it to a public URL.
- **`/api/videos`** — resolves a channel handle/URL and lists its videos using
  [youtubei.js](https://github.com/LuanRT/YouTube.js) (YouTube's internal API,
  no key needed). Sorting (recent / oldest / most viewed) uses the channel
  page's own Latest / Oldest / Popular filters, then returns the top N.
- **`/api/captions`** — fetches each video's public auto-generated transcript
  with youtubei.js, waits ~1.5–2s between videos, skips videos without
  captions, and streams back a zip (one `.txt` per video) built with jszip.

## Environment variables

| Variable         | Required | Purpose                                                        |
| ---------------- | -------- | -------------------------------------------------------------- |
| `PAGE_PASSWORD`  | no       | Optional password to gate a public deployment; unset = open     |
| `YOUTUBE_COOKIE` | no       | Logged-in youtube.com Cookie header — beats the bot wall (free) |
| `PROXY_URL`      | no       | Residential proxy `http://user:pass@host:port` — beats the bot wall |

### The YouTube bot wall

YouTube blocks requests from cloud datacenter IPs (Vercel's included) with
"Sign in to confirm you're not a bot" (`LOGIN_REQUIRED`). When that happens,
caption downloads fail even though the videos clearly have captions. Two
workarounds, either one is enough:

- **`YOUTUBE_COOKIE` (free):** log into youtube.com in a desktop browser, open
  DevTools → Network → click any youtube.com request → copy the full `Cookie`
  request header value and paste it as the env var. Cookies expire every few
  weeks/months (re-export when downloads start failing again). Automated use of
  a logged-in session carries a small risk of Google flagging the account —
  fine at personal volume, but be aware.
- **`PROXY_URL` (a few $/mo):** a rotating *residential* proxy from a provider
  like Webshare or Decodo (datacenter proxies won't help — they're blocked for
  the same reason Vercel is). No account risk.

Running locally (`npm run dev`) from a home connection usually needs neither.

## Local development

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
