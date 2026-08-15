/**
 * Email delivery for the daily brief, via Resend's HTTP API.
 *
 * HTTP rather than SMTP deliberately: SMTP from a laptop needs an app password
 * and a persistent connection, and fails in ways that are hard to read. This
 * is one POST with a clear error body.
 *
 * Delivery is optional. When the env vars are unset the brief is still written
 * to disk — the archive and the brief file are the product; email is a
 * convenience on top.
 */

export interface MailResult {
  sent: boolean;
  reason?: string;
}

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.BRIEF_TO);
}

export async function sendBrief(
  subject: string,
  html: string,
  text: string
): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.BRIEF_TO;
  if (!apiKey || !to) {
    return {
      sent: false,
      reason:
        "email not configured (set RESEND_API_KEY and BRIEF_TO to have the brief delivered)",
    };
  }
  // Resend's shared onboarding sender works without a verified domain, but
  // only delivers to the address that owns the account — fine for a personal
  // brief, and it means setup is one API key rather than DNS records.
  const from = process.env.BRIEF_FROM ?? "Daily Brief <onboarding@resend.dev>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      return { sent: false, reason: `Resend HTTP ${res.status}: ${detail}` };
    }
    return { sent: true };
  } catch (err: any) {
    return { sent: false, reason: `email failed: ${err?.message ?? err}` };
  }
}
