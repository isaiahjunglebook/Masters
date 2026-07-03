import { checkPassword, unauthorized } from "@/lib/auth";
import { createInnertube } from "@/lib/youtube";

export const runtime = "nodejs";
export const maxDuration = 60;

type SortMode = "recent" | "oldest" | "most_viewed";

interface VideoItem {
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
async function videosForIds(yt: any, ids: string[]): Promise<VideoItem[]> {
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

export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();

  try {
    const body = await req.json();

    // "IDs mode": the caller pasted specific video URLs (parsed to ids on the
    // client). Look up their titles and return the same shape as a channel
    // fetch, so the frontend checklist + download flow are unchanged.
    if (Array.isArray(body.ids) && body.ids.length) {
      const ids = [
        ...new Set(
          (body.ids as any[]).filter(
            (id) => typeof id === "string" && /^[\w-]{11}$/.test(id)
          )
        ),
      ].slice(0, 100) as string[];
      if (!ids.length) {
        return Response.json(
          { error: "No valid video URLs found" },
          { status: 400 }
        );
      }
      const yt = await createInnertube();
      const videos = await videosForIds(yt, ids);
      return Response.json({
        channel: { id: "urls", title: "Pasted videos" },
        videos,
      });
    }

    const channelInput = String(body.channel ?? "").trim();
    const sort: SortMode = ["recent", "oldest", "most_viewed"].includes(body.sort)
      ? body.sort
      : "recent";
    const count = Math.max(1, Math.min(500, Number(body.count) || 10));

    if (!channelInput) {
      return Response.json({ error: "Enter a channel URL or handle" }, { status: 400 });
    }

    const yt = await createInnertube();

    // Resolve whatever was pasted to a channel id
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
        if (node.type === "Channel" && node.id) {
          channelId = node.id;
          break;
        }
        if (node.type === "LockupView" && node.content_type === "CHANNEL" && node.content_id) {
          channelId = node.content_id;
          break;
        }
      }
    }
    if (!channelId) {
      return Response.json(
        { error: `Couldn't find a channel for "${channelInput}"` },
        { status: 404 }
      );
    }

    const channel = await yt.getChannel(channelId);
    const channelTitle =
      (channel.metadata?.title as string | undefined) ?? channelInput;

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

    return Response.json({
      channel: { id: channelId, title: channelTitle },
      videos: videos.slice(0, count),
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Failed to fetch videos" },
      { status: 500 }
    );
  }
}
