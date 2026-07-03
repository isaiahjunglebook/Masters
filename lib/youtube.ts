import { Innertube } from "youtubei.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * YouTube blocks datacenter IPs (like Vercel's) with "sign in to confirm
 * you're not a bot". Two optional env vars work around that:
 *
 *   YOUTUBE_COOKIE — a logged-in youtube.com Cookie header value; requests
 *                    are made as that session, which passes the bot wall.
 *   PROXY_URL      — http://user:pass@host:port of a (residential) proxy;
 *                    all YouTube traffic from this app is routed through it.
 *
 * Neither is needed when running from a residential IP (e.g. `npm run dev`
 * at home).
 */

const dispatcher = process.env.PROXY_URL
  ? new ProxyAgent(process.env.PROXY_URL)
  : undefined;

/** Fetch for raw YouTube resources (e.g. timedtext caption files): applies
 *  the proxy and cookie when configured. */
export async function youtubeFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (process.env.YOUTUBE_COOKIE && !headers.has("cookie")) {
    headers.set("cookie", process.env.YOUTUBE_COOKIE);
  }
  return undiciFetch(input as any, {
    ...(init as any),
    headers: headers as any,
    dispatcher,
  } as any) as unknown as Response;
}

/** Shared Innertube factory: plain client by default, cookie- and/or
 *  proxy-enabled when the env vars are set. */
export function createInnertube() {
  return Innertube.create({
    retrieve_player: false,
    ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {}),
    ...(dispatcher ? { fetch: youtubeFetch as any } : {}),
  });
}
