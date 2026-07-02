import { timingSafeEqual } from "crypto";

/**
 * Checks the shared page password sent in the `x-page-password` header
 * against the PAGE_PASSWORD env var. Returns false if the env var is unset
 * so the app fails closed rather than open.
 */
export function checkPassword(req: Request): boolean {
  const provided = req.headers.get("x-page-password") ?? "";
  const expected = process.env.PAGE_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unauthorized() {
  return Response.json({ error: "Wrong or missing password" }, { status: 401 });
}
