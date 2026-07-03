"use client";

import { useEffect, useMemo, useState } from "react";

type SortMode = "recent" | "oldest" | "most_viewed";

interface Video {
  id: string;
  title: string;
  published: string;
  views: string;
  url: string;
}

interface Skipped {
  id: string;
  title: string;
  reason: string;
}

const COUNT_PRESETS = [5, 10, 25, 50];

const SORT_LABELS: Record<SortMode, string> = {
  recent: "Recent",
  oldest: "Oldest",
  most_viewed: "Most Viewed",
};

/** Pull YouTube video ids out of pasted text — watch?v=, youtu.be/, /shorts/,
 *  /embed/, /live/, and bare 11-char ids. Deduped, original order preserved.
 *  Best-effort: the server re-validates every id before use. */
function extractVideoIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const re =
    /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})|(?<![\w-])([\w-]{11})(?![\w-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = m[1] ?? m[2];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export default function Home() {
  // Password gate (kept in memory only — sent with every API call). When no
  // PAGE_PASSWORD is configured the app is open and this screen is skipped.
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [authError, setAuthError] = useState("");
  const [checking, setChecking] = useState(false);
  const [booting, setBooting] = useState(true);

  // On load, ask the server whether a password is required. If not, unlock
  // immediately so the user never sees the login screen.
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => {
        if (!d.required) setUnlocked(true);
      })
      .catch(() => {
        /* leave gated; the unlock form still works as a fallback */
      })
      .finally(() => setBooting(false));
  }, []);

  // Fetch form
  const [channel, setChannel] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [count, setCount] = useState(10);
  const [customCount, setCustomCount] = useState("");

  // Paste-URLs form
  const [urlsText, setUrlsText] = useState("");
  const [loadingUrls, setLoadingUrls] = useState(false);

  // Results
  const [channelTitle, setChannelTitle] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [downloadedCount, setDownloadedCount] = useState<number | null>(null);

  const authHeaders = useMemo(
    () => ({ "Content-Type": "application/json", "x-page-password": password }),
    [password]
  );

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setAuthError("");
    try {
      const res = await fetch("/api/auth", { method: "POST", headers: authHeaders });
      if (res.ok) setUnlocked(true);
      else setAuthError("Wrong password");
    } catch {
      setAuthError("Network error — try again");
    } finally {
      setChecking(false);
    }
  }

  async function fetchVideos(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSkipped([]);
    setDownloadedCount(null);
    setVideos([]);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ channel, sort, count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch videos");
      setChannelTitle(data.channel.title);
      setVideos(data.videos);
      // Everything selected by default
      setSelected(new Set(data.videos.map((v: Video) => v.id)));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchFromUrls(e: React.FormEvent) {
    e.preventDefault();
    const ids = extractVideoIds(urlsText);
    if (!ids.length) {
      setError("No video URLs found — paste full YouTube video links");
      return;
    }
    setLoadingUrls(true);
    setError("");
    setSkipped([]);
    setDownloadedCount(null);
    setVideos([]);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to fetch videos");
      setChannelTitle(data.channel.title);
      setVideos(data.videos);
      // Everything selected by default
      setSelected(new Set(data.videos.map((v: Video) => v.id)));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingUrls(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === videos.length ? new Set() : new Set(videos.map((v) => v.id))
    );
  }

  async function downloadCaptions() {
    setDownloading(true);
    setError("");
    setSkipped([]);
    setDownloadedCount(null);
    try {
      const chosen = videos.filter((v) => selected.has(v.id));
      const res = await fetch("/api/captions", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          videos: chosen.map((v) => ({ id: v.id, title: v.title })),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.skipped) setSkipped(data.skipped);
        throw new Error(data.error ?? "Failed to download captions");
      }

      const skippedHeader = res.headers.get("x-skipped");
      if (skippedHeader) {
        try {
          setSkipped(JSON.parse(decodeURIComponent(skippedHeader)));
        } catch {
          /* header is informational only */
        }
      }
      setDownloadedCount(Number(res.headers.get("x-success-count") ?? 0));

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${channelTitle || "captions"}.zip`
        .replace(/[<>:"/\\|?*]/g, "")
        .trim();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  // Brief blank while we check whether a password is needed — avoids flashing
  // the login screen before auto-unlocking on a passwordless (local) setup.
  if (booting) return null;

  if (!unlocked) {
    return (
      <main>
        <h1>YouTube Caption Downloader</h1>
        <p className="subtitle">Enter the page password to continue</p>
        <form className="panel" onSubmit={unlock}>
          <label htmlFor="pw">Password</label>
          <div className="row">
            <input
              id="pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ flex: 1 }}
              autoFocus
            />
            <button className="primary" disabled={checking || !password}>
              {checking ? "Checking…" : "Unlock"}
            </button>
          </div>
          {authError && <p className="error">{authError}</p>}
        </form>
      </main>
    );
  }

  const selectedCount = selected.size;
  const estimatedSeconds = Math.round(selectedCount * 2.5);

  return (
    <main>
      <h1>YouTube Caption Downloader</h1>
      <p className="subtitle">
        Fetch a channel&apos;s videos, pick the ones you want, download
        auto-generated captions as a zip.
      </p>

      <form className="panel" onSubmit={fetchVideos}>
        <label htmlFor="channel">Channel URL or handle</label>
        <div className="row">
          <input
            id="channel"
            type="text"
            placeholder="https://www.youtube.com/@yourchannel or @yourchannel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="primary" disabled={loading || !channel.trim()}>
            {loading ? (
              <>
                <span className="spinner" />
                Fetching…
              </>
            ) : (
              "Fetch videos"
            )}
          </button>
        </div>

        <div className="controls">
          <div className="control-group">
            <label>Sort</label>
            <div className="row">
              {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`chip ${sort === mode ? "active" : ""}`}
                  onClick={() => setSort(mode)}
                >
                  {SORT_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label>How many videos</label>
            <div className="row">
              {COUNT_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${count === n && !customCount ? "active" : ""}`}
                  onClick={() => {
                    setCount(n);
                    setCustomCount("");
                  }}
                >
                  {n}
                </button>
              ))}
              <input
                type="number"
                className="custom-count"
                placeholder="Custom"
                min={1}
                max={500}
                value={customCount}
                onChange={(e) => {
                  setCustomCount(e.target.value);
                  const n = parseInt(e.target.value, 10);
                  if (n > 0) setCount(Math.min(n, 500));
                }}
              />
            </div>
          </div>
        </div>
        {error && !videos.length && <p className="error">{error}</p>}
      </form>

      <div className="or-divider">or</div>

      <form className="panel" onSubmit={fetchFromUrls}>
        <label htmlFor="urls">Paste video URLs</label>
        <textarea
          id="urls"
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          placeholder={
            "One per line — any format, from any channel:\n" +
            "https://www.youtube.com/watch?v=…\n" +
            "https://youtu.be/…\n" +
            "https://www.youtube.com/shorts/…"
          }
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={loadingUrls || !urlsText.trim()}>
            {loadingUrls ? (
              <>
                <span className="spinner" />
                Fetching titles…
              </>
            ) : (
              "Fetch from URLs"
            )}
          </button>
          <span className="notice" style={{ marginTop: 0 }}>
            Looks up each video&apos;s title, then you pick which to download.
          </span>
        </div>
      </form>

      {videos.length > 0 && (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>
              {channelTitle} — {videos.length} videos
            </strong>
            <button type="button" className="chip" onClick={toggleAll}>
              {selectedCount === videos.length ? "Deselect all" : "Select all"}
            </button>
          </div>

          <ul className="video-list">
            {videos.map((v) => (
              <li key={v.id}>
                <input
                  type="checkbox"
                  checked={selected.has(v.id)}
                  onChange={() => toggle(v.id)}
                  id={`cb-${v.id}`}
                />
                <div>
                  <div className="video-title">
                    <a href={v.url} target="_blank" rel="noreferrer">
                      {v.title}
                    </a>
                  </div>
                  <div className="video-meta">
                    {[v.views, v.published].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="primary"
              onClick={downloadCaptions}
              disabled={downloading || selectedCount === 0}
            >
              {downloading ? (
                <>
                  <span className="spinner" />
                  Downloading captions… (~{estimatedSeconds}s)
                </>
              ) : (
                `Download captions (zip) — ${selectedCount} selected`
              )}
            </button>
          </div>
          {downloading && (
            <p className="notice">
              Captions are fetched one at a time with a short pause between
              videos, so this takes a couple of seconds per video. Keep this tab
              open.
            </p>
          )}
          {error && <p className="error">{error}</p>}
          {downloadedCount !== null && (
            <p className="success">
              Done — {downloadedCount} transcript{downloadedCount === 1 ? "" : "s"}{" "}
              in the zip.
            </p>
          )}
        </div>
      )}

      {skipped.length > 0 && (
        <div className="panel skipped">
          <h3>Skipped videos ({skipped.length})</h3>
          <ul>
            {skipped.map((s) => (
              <li key={s.id}>
                {s.title} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
