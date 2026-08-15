export type SortMode = "recent" | "oldest" | "most_viewed";

export interface VideoItem {
  id: string;
  title: string;
  published: string;
  views: string;
  url: string;
}

// Maps our sort modes to the filter chips on a channel's Videos tab
// ("Latest" / "Popular" / "Oldest") — YouTube does the sorting for us.
const FILTER_FOR_SORT: Record<SortMode, string | null> = {
  recent: null, // default order
  most_viewed: "Popular",
  oldest: "Oldest",
};

export const SORT_MODES: SortMode[] = ["recent", "oldest", "most_viewed"];

/** Normalize whatever the user pasted into a resolvable youtube.com URL,
 *  or a bare UC… channel id. */
function normalizeChannelInput(raw: string): { id?: string; url?: string } {
  const input = raw.trim();
  if (/^UC[\w-]{22}$/.test(input)) return { id: input };

  const fromUrl = input.match(/youtube\.com\/(channel\/(UC[\w-]{22}))/i);
  if (fromUrl) return { id: fromUrl[2] };

  if (/^https?:\/\//i.test(input) || /youtube\.com\//i.test(input)) {
    const path = input.replace(/^https?:\/\//i, "").replace(/^[^/]*youtube\.com/i, "");
    return { url: `https://www.youtube.com${path}` };
  }
  const handle = input.startsWith("@") ? input : `@${input}`;
  return { url: `https://www.youtube.com/${handle}` };
}

/** Pull id/title/published/views out of the various node types a channel's
 *  Videos tab can return (new LockupView UI or classic Video/GridVideo). */
function toVideoItem(node: any): VideoItem | null {
  // New YouTube UI
  if (node.type === "LockupView") {
    if (node.content_type && node.content_type !== "VIDEO") return null;
    const id = node.content_id;
    if (!id) return null;
    const parts: string[] = (node.metadata?.metadata?.metadata_rows ?? [])
      .flatMap((row: any) => row?.metadata_parts ?? [])
      .map((p: any) => p?.text?.toString?.() ?? "")
      .filter(Boolean);
    return {
      id,
      title: node.metadata?.title?.toString?.() ?? id,
      views: parts.find((t) => /view/i.test(t)) ?? "",
      published: parts.find((t) => /ago|streamed|premier/i.test(t)) ?? "",
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  // Classic renderers
  const id = node.video_id;
  if (!id) return null;
  return {
    id,
    title: node.title?.toString?.() ?? id,
    views:
      node.view_count?.toString?.() ??
      node.views?.toString?.() ??
      node.short_view_count?.toString?.() ??
      "",
    published: node.published?.toString?.() ?? "",
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

/** Look up titles for a list of video ids with limited concurrency, so a
 *  pasted batch resolves quickly without hammering YouTube. A per-video
 *  failure falls back to the id as the title, so the video still appears in
 *  the list and can still be attempted at download time. Input order is kept. */
export async function videosForIds(yt: any, ids: string[]): Promise<VideoItem[]> {
  const out: VideoItem[] = new Array(ids.length);
  const CONCURRENCY = 5;
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i];
      let title = id;
      try {
        const info = await yt.getBasicInfo(id);
        title = info.basic_info?.title ?? id;
      } catch {
        /* keep fallback title = id */
      }
      out[i] = {
        id,
        title,
        views: "",
        published: "",
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker)
  );
  return out;
}

/** Resolve whatever the user pasted (handle, URL, or channel id) to a UC… id,
 *  falling back to channel search when the URL doesn't resolve directly. */
export async function resolveChannelId(
  yt: any,
  channelInput: string
): Promise<string | null> {
  const target = normalizeChannelInput(channelInput);
  let channelId = target.id;
  if (!channelId && target.url) {
    try {
      const endpoint = await yt.resolveURL(target.url);
      channelId = endpoint.payload?.browseId;
    } catch {
      /* fall through to search */
    }
  }
  if (!channelId || !channelId.startsWith("UC")) {
    const query = channelInput.replace(/^.*youtube\.com\//i, "").replace(/^@/, "");
    const search = await yt.search(query, { type: "channel" });
    for (const node of (search.results ?? []) as any[]) {
      if (node.type === "Channel" && node.id) return node.id;
      if (node.type === "LockupView" && node.content_type === "CHANNEL" && node.content_id) {
        return node.content_id;
      }
    }
  }
  return channelId ?? null;
}

/** List a channel's videos in the requested order, paging until `count` is
 *  reached. Returns the channel's display title alongside the videos. */
export async function listChannelVideos(
  yt: any,
  channelId: string,
  sort: SortMode,
  count: number,
  fallbackTitle: string
): Promise<{ title: string; videos: VideoItem[] }> {
  const channel = await yt.getChannel(channelId);
  const title = (channel.metadata?.title as string | undefined) ?? fallbackTitle;

  let feed: any = await channel.getVideos();

  // Apply YouTube's own sort chip when we're not using the default order.
  // Tiny channels sometimes have no chips — fall back to default order.
  const wantedFilter = FILTER_FOR_SORT[sort];
  if (wantedFilter && feed.filters?.includes(wantedFilter)) {
    feed = await feed.applyFilter(wantedFilter);
  }

  const videos: VideoItem[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    for (const node of feed.videos ?? []) {
      const item = toVideoItem(node);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        videos.push(item);
      }
    }
    if (videos.length >= count || !feed.has_continuation) break;
    feed = await feed.getContinuation();
  }

  return { title, videos: videos.slice(0, count) };
}

/** Pull 11-char video ids out of pasted text: watch/youtu.be/shorts/embed/live
 *  URLs in any mix, or bare ids, one per line or space-separated. */
export function extractVideoIds(text: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /(?:youtube\.com\/(?:watch\?(?:[^&\s]*&)*v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/g,
    /(?:^|\s)([\w-]{11})(?=\s|$)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) ids.push(m[1]);
  }
  return [...new Set(ids)];
}
