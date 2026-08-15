import JSZip from "jszip";
import { checkPassword, unauthorized } from "@/lib/auth";
import { createInnertube } from "@/lib/youtube";
import {
  fetchTranscript,
  indexCsv,
  safeFilename,
  transcriptFile,
  INDEX_FILENAME,
  type VideoMeta,
} from "@/lib/captions";

export const runtime = "nodejs";
// Caption fetching is deliberately slow (~2s/video to be polite to YouTube),
// so give this function the longest duration Vercel allows.
export const maxDuration = 300;

const DELAY_MS_MIN = 1500;
const DELAY_MS_JITTER = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RequestedVideo {
  id: string;
  title?: string;
}

interface Skipped {
  id: string;
  title: string;
  reason: string;
}

export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();

  let requested: RequestedVideo[];
  try {
    const body = await req.json();
    requested = (body.videos ?? [])
      .filter((v: any) => typeof v?.id === "string" && /^[\w-]{11}$/.test(v.id))
      .slice(0, 200);
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!requested.length) {
    return Response.json({ error: "No video IDs provided" }, { status: 400 });
  }

  const yt = await createInnertube();
  const zip = new JSZip();
  const skipped: Skipped[] = [];
  const index: { meta: VideoMeta; file: string; chars: number }[] = [];
  let successCount = 0;

  for (let i = 0; i < requested.length; i++) {
    const { id, title: providedTitle } = requested[i];
    try {
      const { meta, text } = await fetchTranscript(yt, id, providedTitle);
      const file = safeFilename(meta.title, id, meta.published);
      zip.file(file, transcriptFile(meta, text));
      index.push({ meta, file, chars: text.length });
      successCount++;
    } catch (err: any) {
      // Report the real error text (trimmed) — masking it behind a friendly
      // label makes failures impossible to diagnose remotely
      const reason = (err?.message ?? "Unknown error").slice(0, 500);
      console.log(`[captions] skipped ${id}: ${reason}`);
      skipped.push({ id, title: providedTitle ?? id, reason });
    }
    // Be polite: pause between videos (but not after the last one)
    if (i < requested.length - 1) {
      await sleep(DELAY_MS_MIN + Math.random() * DELAY_MS_JITTER);
    }
  }

  if (successCount === 0) {
    return Response.json(
      { error: "No captions could be fetched for any selected video", skipped },
      { status: 422 }
    );
  }

  // Machine-readable manifest: one row per transcript, for joining against
  // other time series (price data, etc.) without re-parsing the .txt files.
  zip.file(INDEX_FILENAME, indexCsv(index));

  if (skipped.length) {
    zip.file(
      "_skipped.txt",
      skipped.map((s) => `${s.id}  ${s.title}  —  ${s.reason}`).join("\n") + "\n"
    );
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="captions.zip"',
      // Frontend reads this to show which videos were skipped
      "x-skipped": encodeURIComponent(JSON.stringify(skipped)),
      "x-success-count": String(successCount),
    },
  });
}
