import { JSDOM } from "jsdom";
import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { buildURL, getHeaders } from "bgutils-js/utils";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";

/**
 * Mints a YouTube "proof of origin" (PO) token by running Google's BotGuard
 * attestation VM inside a jsdom window. YouTube uses the *absence* of this
 * token as a bot signal, which is a big part of why datacenter IPs (Vercel's
 * included) get "Sign in to confirm you're not a bot" (LOGIN_REQUIRED) while
 * home connections don't. Sending a valid PO token bound to our visitor data
 * makes requests look like a real web client and lifts that wall in most
 * cases — with no cookies and no proxy.
 *
 * The BotGuard interpreter is evaluated inside the jsdom window itself (NOT
 * on globalThis): leaking `window`/`document` onto the Node global would make
 * Next.js and React think they're running in a browser.
 */

// Public request key used by the YouTube web client for BotGuard challenges.
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

export async function mintWebPoToken(
  visitorData: string,
  fetchFn: typeof fetch
): Promise<string> {
  const challenge = await getChallenge({
    requestKey: REQUEST_KEY,
    fetchFunction: fetchFn,
    useYouTubeAPI: true,
  });

  const interpreterJavascript =
    challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJavascript) {
    throw new Error("BotGuard challenge did not include an interpreter script");
  }

  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    {
      url: "https://www.youtube.com/",
      referrer: "https://www.youtube.com/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }
  );

  try {
    // Load the BotGuard VM with the jsdom window as its global scope.
    dom.window.eval(interpreterJavascript);

    const botguard = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: dom.window,
    });

    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

    const integrityTokenResponse = await fetchFn(buildURL("GenerateIT", true), {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    if (!integrityTokenResponse.ok) {
      throw new Error(`integrity token HTTP ${integrityTokenResponse.status}`);
    }
    const [integrityToken] = (await integrityTokenResponse.json()) as unknown[];
    if (typeof integrityToken !== "string") {
      throw new Error("integrity token response had no token");
    }

    const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
    const poToken = await minter.mintAsWebsafeString(visitorData);

    await botguard.shutdown().catch(() => {});
    return poToken;
  } finally {
    dom.window.close();
  }
}
