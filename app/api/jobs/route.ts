import { checkPassword, unauthorized } from "@/lib/auth";
import { getJob, startJob, stopJob } from "@/lib/jobs";

export const runtime = "nodejs";

/** Start a save-to-folder run. Returns immediately with a job id; the work
 *  continues in the background and the browser polls GET for progress. */
export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  try {
    const body = await req.json();
    const videos = (body.videos ?? []).filter(
      (v: any) => typeof v?.id === "string" && /^[\w-]{11}$/.test(v.id)
    );
    if (!videos.length) {
      return Response.json({ error: "No videos selected" }, { status: 400 });
    }
    const job = await startJob({
      videos,
      outDir: String(body.outDir ?? ""),
      useWhisper: Boolean(body.useWhisper),
      force: Boolean(body.force),
    });
    return Response.json({ job });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Couldn't start the download" },
      { status: 400 }
    );
  }
}

export async function GET(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  const job = getJob(id);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  return Response.json({ job });
}

export async function DELETE(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  return Response.json({ stopped: stopJob(id) });
}
