import { checkPassword, unauthorized } from "@/lib/auth";
import { addCreator, listCreators, removeCreator } from "@/lib/creators";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  try {
    return Response.json({ creators: await listCreators() });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Couldn't read the creator list" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  try {
    const body = await req.json();
    const { creator, added } = await addCreator(String(body.input ?? ""));
    return Response.json({ creator, added, creators: await listCreators() });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Couldn't add that creator" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request) {
  if (!checkPassword(req)) return unauthorized();
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const removed = await removeCreator(id);
    return Response.json({ removed, creators: await listCreators() });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "Couldn't remove that creator" },
      { status: 500 }
    );
  }
}
