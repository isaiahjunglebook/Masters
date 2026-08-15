import { checkPassword, unauthorized } from "@/lib/auth";
import { checkSetup } from "@/lib/tools";
import { DEFAULT_DAILY_CAP, remainingToday } from "@/lib/limits";

export const runtime = "nodejs";

/** What the Whisper path needs, and whether it's here. The UI shows this so a
 *  missing program reads as "run this command" instead of a crash mid-run. */
export async function GET(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  try {
    const setup = await checkSetup();
    return Response.json({
      ...setup,
      audio: {
        dailyCap: DEFAULT_DAILY_CAP,
        remainingToday: await remainingToday(),
      },
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Couldn't check setup" },
      { status: 500 }
    );
  }
}
