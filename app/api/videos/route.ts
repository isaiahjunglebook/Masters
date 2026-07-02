import { checkPassword, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const YT_API = "https://www.googleapis.com/youtube/v3";

type SortMode = "recent" | "oldest" | "most_viewed";

interface VideoItem {
  id: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  url: string;
}

/** Figure out what kind of channel reference the user pasted. */
function parseChannelInput(
  raw: string
): { kind: "id" | "handle" | "user" | "search"; value: string } {
  const input = raw.trim();
  if (/^UC[\w-]{22}$/.test(input)) return { kind: "id", value: input };
  if (input.startsWith("@")) return { kind: "handle", value: input };

  const url = input.match(/youtube\.com\/(channel\/|user\/|c\/|@)?([^/?&\s]+)/i);
  if (url) {
    const [, prefix, name] = url;
    if (prefix === "channel/" && /^UC[\w-]{22}$/.test(name))
      return { kind: "id", value: name };
    if (prefix === "user/") return { kind: "user", value: name };
    if (prefix === "@") return { kind: "handle", value: "@" + name };
    if (prefix === "c/") return { kind: "search", value: name };
    // youtube.com/somename — could be a legacy custom URL
    if (!prefix) return { kind: "search", value: name };
  }
  // Bare name without @ — try it as a handle first (resolveChannel falls
  // back to search if the handle lookup finds nothing)
  return { kind: "handle", value: "@" + input };
}

async function ytFetch(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY! });
  const res = await fetch(`${YT_API}/${path}?${qs}`);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message ?? `YouTube API error (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/** Resolve any channel reference to { channelId, title, uploadsPlaylistId }. */
async function resolveChannel(input: string) {
  const parsed = parseChannelInput(input);
  const part = { part: "snippet,contentDetails" };

  let data;
  if (parsed.kind === "id") {
    data = await ytFetch("channels", { ...part, id: parsed.value });
  } else if (parsed.kind === "handle") {
    data = await ytFetch("channels", { ...part, forHandle: parsed.value });
  } else if (parsed.kind === "user") {
    data = await ytFetch("channels", { ...part, forUsername: parsed.value });
  }

  // Fall back to search for legacy /c/ URLs, bare names, or failed lookups
  if (!data?.items?.length) {
    const search = await ytFetch("search", {
      part: "snippet",
      type: "channel",
      maxResults: "1",
      q: parsed.value.replace(/^@/, ""),
    });
    const channelId = search.items?.[0]?.snippet?.channelId;
    if (!channelId) throw new Error(`Couldn't find a channel for "${input}"`);
    data = await ytFetch("channels", { ...part, id: channelId });
  }

  const ch = data.items[0];
  return {
    channelId: ch.id as string,
    title: ch.snippet.title as string,
    uploadsPlaylistId: ch.contentDetails.relatedPlaylists.uploads as string,
  };
}

/** Page through the uploads playlist collecting id/title/publishedAt. */
async function fetchAllUploads(
  playlistId: string,
  earlyExitAt: number | null
): Promise<VideoItem[]> {
  const videos: VideoItem[] = [];
  let pageToken: string | undefined;
  // Safety cap: 100 pages = 5000 videos, plenty for a personal channel
  for (let page = 0; page < 100; page++) {
    const data = await ytFetch("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of data.items ?? []) {
      const id = item.contentDetails?.videoId;
      if (!id) continue;
      videos.push({
        id,
        title: item.snippet?.title ?? id,
        publishedAt:
          item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? "",
        viewCount: 0,
        url: `https://www.youtube.com/watch?v=${id}`,
      });
    }
    // Uploads playlists are newest-first, so for "recent" we can stop
    // as soon as we have enough — saves quota on big channels
    if (earlyExitAt !== null && videos.length >= earlyExitAt) break;
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return videos;
}

/** Fill in view counts via videos.list, 50 ids per call. */
async function attachViewCounts(videos: VideoItem[]) {
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const data = await ytFetch("videos", {
      part: "statistics",
      id: batch.map((v) => v.id).join(","),
      maxResults: "50",
    });
    const counts = new Map<string, number>(
      (data.items ?? []).map((item: any) => [
        item.id,
        Number(item.statistics?.viewCount ?? 0),
      ])
    );
    for (const v of batch) v.viewCount = counts.get(v.id) ?? 0;
  }
}

export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  if (!process.env.YOUTUBE_API_KEY) {
    return Response.json(
      { error: "YOUTUBE_API_KEY is not configured on the server" },
      { status: 500 }
    );
  }

  try {
    const body = await req.json();
    const channelInput = String(body.channel ?? "").trim();
    const sort: SortMode = ["recent", "oldest", "most_viewed"].includes(body.sort)
      ? body.sort
      : "recent";
    const count = Math.max(1, Math.min(500, Number(body.count) || 10));

    if (!channelInput) {
      return Response.json({ error: "Enter a channel URL or handle" }, { status: 400 });
    }

    const channel = await resolveChannel(channelInput);
    const videos = await fetchAllUploads(
      channel.uploadsPlaylistId,
      sort === "recent" ? count : null
    );

    videos.sort((a, b) =>
      sort === "oldest"
        ? a.publishedAt.localeCompare(b.publishedAt)
        : b.publishedAt.localeCompare(a.publishedAt)
    );

    let selected: VideoItem[];
    if (sort === "most_viewed") {
      await attachViewCounts(videos);
      selected = [...videos]
        .sort((a, b) => b.viewCount - a.viewCount)
        .slice(0, count);
    } else {
      selected = videos.slice(0, count);
      await attachViewCounts(selected);
    }

    return Response.json({
      channel: { id: channel.channelId, title: channel.title },
      videos: selected,
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Failed to fetch videos" },
      { status: 500 }
    );
  }
}
