import { timingSafeEqual } from "crypto";

/**
 * Checks the shared page password sent in the `x-page-password` header
 * against the PAGE_PASSWORD env var. When PAGE_PASSWORD is unset (the default
 * for local/personal use) the app is open — no password required. Set the env
 * var only to gate a public deployment.
 */
export function checkPassword(req: Request): boolean {
  const expected = process.env.PAGE_PASSWORD ?? "";
  if (!expected) return true;
  const provided = req.headers.get("x-page-password") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unauthorized() {
  return Response.json({ error: "Wrong or missing password" }, { status: 401 });
}
