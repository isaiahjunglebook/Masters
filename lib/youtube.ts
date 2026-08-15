import { Innertube } from "youtubei.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { mintWebPoToken } from "./potoken";

/**
 * YouTube blocks datacenter IPs (like Vercel's) with "sign in to confirm
 * you're not a bot". Three layers of defense, in order:
 *
 *   PO token       — minted automatically (no setup): a BotGuard attestation
 *                    token bound to this server's visitor data. Lifts the bot
 *                    wall in most cases.
 *   YOUTUBE_COOKIE — a logged-in youtube.com Cookie header value; requests
 *                    are made as that session, which passes the bot wall.
 *   PROXY_URL      — http://user:pass@host:port of a (residential) proxy;
 *                    all YouTube traffic from this app is routed through it.
 *
 * The env vars are optional; neither is needed when running from a
 * residential IP (e.g. `npm run dev` at home).
 */

const dispatcher = process.env.PROXY_URL
  ? new ProxyAgent(process.env.PROXY_URL)
  : undefined;

/** A usable YOUTUBE_COOKIE is the whole `Cookie:` request header from a
 *  logged-in session. The most common mistake is pasting a fragment (or a
 *  logged-out cookie), which lacks SAPISID — the value youtubei.js needs to
 *  sign authenticated requests. Without SAPISID the cookie silently behaves
 *  like no cookie at all, so say so loudly at startup. */
export function cookieProblem(): string | null {
  const cookie = process.env.YOUTUBE_COOKIE;
  if (!cookie) return null;
  if (!/(^|;\s*)SAPISID=/.test(cookie)) {
    return "YOUTUBE_COOKIE has no SAPISID — it looks like a partial copy or a " +
      "logged-out session. Copy the entire Cookie request header while signed " +
      "in to youtube.com.";
  }
  return null;
}

const startupCookieProblem = cookieProblem();
if (startupCookieProblem) console.log(`[cookie] ${startupCookieProblem}`);

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

// PO token cache: minting costs ~1-3s (BotGuard VM + two network calls), so
// mint once per server instance and reuse. Integrity tokens live ~12h; renew
// well before that. Failures are cached briefly so a broken mint doesn't add
// latency to every request.
const PO_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const PO_TOKEN_RETRY_MS = 5 * 60 * 1000;

interface PoSession {
  po_token: string;
  visitor_data: string;
}

let poCache: { session: PoSession | null; expires: number } | null = null;
let poPending: Promise<PoSession | null> | null = null;

async function getPoTokenSession(): Promise<PoSession | null> {
  if (poCache && Date.now() < poCache.expires) return poCache.session;
  if (!poPending) {
    poPending = (async () => {
      try {
        // Throwaway session purely to obtain visitor data in YouTube's format
        // (generated locally — no network round-trip to a blocked endpoint).
        const probe = await Innertube.create({
          retrieve_player: false,
          generate_session_locally: true,
          enable_session_cache: false,
          ...(dispatcher ? { fetch: youtubeFetch as any } : {}),
        });
        const visitorData = probe.session.context.client.visitorData;
        if (!visitorData) throw new Error("probe session has no visitor data");

        const poToken = await mintWebPoToken(visitorData, youtubeFetch as any);
        const session = { po_token: poToken, visitor_data: visitorData };
        poCache = { session, expires: Date.now() + PO_TOKEN_TTL_MS };
        console.log("[potoken] minted web PO token");
        return session;
      } catch (err: any) {
        console.log(`[potoken] minting failed: ${err?.message ?? err}`);
        poCache = { session: null, expires: Date.now() + PO_TOKEN_RETRY_MS };
        return null;
      } finally {
        poPending = null;
      }
    })();
  }
  return poPending;
}

/** Shared Innertube factory: mints and attaches a PO token automatically
 *  (unless a logged-in cookie is configured — the account session already
 *  passes the bot wall, and the token would be bound to the wrong identity),
 *  plus cookie and/or proxy when the env vars are set. */
export async function createInnertube() {
  const options: Record<string, any> = {
    retrieve_player: false,
    ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {}),
    ...(dispatcher ? { fetch: youtubeFetch as any } : {}),
  };

  if (!process.env.YOUTUBE_COOKIE) {
    const po = await getPoTokenSession();
    if (po) {
      options.po_token = po.po_token;
      options.visitor_data = po.visitor_data;
    }
  }

  return Innertube.create(options);
}
