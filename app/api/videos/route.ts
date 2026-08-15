import { checkPassword, unauthorized } from "@/lib/auth";
import { createInnertube } from "@/lib/youtube";
import {
  listChannelVideos,
  resolveChannelId,
  videosForIds,
  SORT_MODES,
  type SortMode,
} from "@/lib/channel";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    const sort: SortMode = SORT_MODES.includes(body.sort) ? body.sort : "recent";
    const count = Math.max(1, Math.min(500, Number(body.count) || 10));

    if (!channelInput) {
      return Response.json({ error: "Enter a channel URL or handle" }, { status: 400 });
    }

    const yt = await createInnertube();

    const channelId = await resolveChannelId(yt, channelInput);
    if (!channelId) {
      return Response.json(
        { error: `Couldn't find a channel for "${channelInput}"` },
        { status: 404 }
      );
    }

    const { title, videos } = await listChannelVideos(
      yt,
      channelId,
      sort,
      count,
      channelInput
    );

    return Response.json({
      channel: { id: channelId, title },
      videos,
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Failed to fetch videos" },
      { status: 500 }
    );
  }
}
