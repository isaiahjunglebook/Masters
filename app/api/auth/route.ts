import { checkPassword, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

// Lets the frontend learn whether a password is required, so it can skip the
// unlock screen entirely when none is configured (the local/personal default).
export async function GET() {
  return Response.json({ required: Boolean(process.env.PAGE_PASSWORD) });
}

// Lets the frontend verify the password once up front (better UX than
// finding out on the first real request). Stateless: no cookie, no session —
// the client just keeps the password in memory and resends it per request.
export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  return Response.json({ ok: true });
}
