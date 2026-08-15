import type { Brief } from "./brief";

/**
 * Renders the brief as one self-contained HTML file — no external CSS, fonts,
 * or scripts, because it has to survive being emailed. Detail lives in native
 * <details> elements so the page opens as a short read and expands only where
 * the reader wants more.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function minutes(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

const STYLE = `
:root{--bg:#fbfaf8;--card:#fff;--ink:#1a1a1a;--muted:#6b6b6b;--line:#e6e3dd;--accent:#b4532a}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--ink);
  font:16px/1.6 Georgia,"Iowan Old Style",serif}
.wrap{max-width:680px;margin:0 auto}
.date{color:var(--muted);font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.08em;
  text-transform:uppercase;margin-bottom:8px}
h1{font-size:30px;line-height:1.25;margin:0 0 16px}
.overview{font-size:18px;margin:0 0 28px}
h2{font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;
  color:var(--muted);margin:36px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
ul{margin:0 0 8px;padding-left:22px}
li{margin-bottom:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:18px 20px;margin-bottom:14px}
.chan{font:600 13px/1.4 system-ui,sans-serif;color:var(--accent);margin-bottom:4px}
.title{font-size:18px;font-weight:600;line-height:1.3;margin-bottom:6px}
.title a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
.meta{font:13px/1.5 system-ui,sans-serif;color:var(--muted);margin-bottom:10px}
.sum{margin:0 0 10px}
.sowhat{font-size:15px;color:var(--muted);font-style:italic;margin:0}
details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
summary{cursor:pointer;font:600 13px/1.4 system-ui,sans-serif;color:var(--accent);
  list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸ ";display:inline-block;transition:transform .15s}
details[open] summary::before{content:"▾ "}
details ul{margin-top:10px}
.warn{background:#fff8f2;border:1px solid #f0dcc9;border-radius:10px;padding:14px 18px;
  font:14px/1.55 system-ui,sans-serif}
.empty{color:var(--muted);font-style:italic}
footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--line);
  font:13px/1.5 system-ui,sans-serif;color:var(--muted)}
@media (prefers-color-scheme:dark){
  :root{--bg:#141414;--card:#1c1c1c;--ink:#ececec;--muted:#9a9a9a;--line:#2e2e2e;--accent:#e08c5f}
  .warn{background:#241a12;border-color:#3d2d1e}
}
`;

export function renderBriefHtml(brief: Brief): string {
  const cards = brief.videos
    .map((v) => {
      const bits = [
        v.meta.channel,
        v.meta.published,
        minutes(v.meta.duration_seconds),
        v.meta.view_count ? `${v.meta.view_count.toLocaleString()} views` : "",
        v.meta.is_live_content ? "livestream" : "",
      ].filter(Boolean);

      const claims = v.claims.length
        ? `<details><summary>${v.claims.length} specific claim${
            v.claims.length === 1 ? "" : "s"
          }</summary><ul>${v.claims
            .map((c) => `<li>${esc(c)}</li>`)
            .join("")}</ul></details>`
        : "";

      return `<article class="card">
  <div class="chan">${esc(v.meta.channel ?? "Unknown channel")}</div>
  <div class="title"><a href="https://www.youtube.com/watch?v=${esc(
    v.meta.id
  )}">${esc(v.meta.title)}</a></div>
  <div class="meta">${esc(bits.slice(1).join(" · "))}</div>
  <p class="sum">${esc(v.summary)}</p>
  <p class="sowhat">${esc(v.soWhat)}</p>
  ${claims}
</article>`;
    })
    .join("\n");

  const throughlines = brief.throughlines.length
    ? `<h2>Worth noticing</h2><ul>${brief.throughlines
        .map((t) => `<li>${esc(t)}</li>`)
        .join("")}</ul>`
    : "";

  const disappeared = brief.disappeared.length
    ? `<h2>Removed since last check</h2>
<div class="warn">These were on a channel before and are gone now. Their
transcripts are still in your archive.
<ul>${brief.disappeared
        .map(
          (d) =>
            `<li>${esc(d.channel ?? "unknown")} — <a href="${esc(
              d.url
            )}">${esc(d.title)}</a></li>`
        )
        .join("")}</ul></div>`
    : "";

  const problems = brief.problems.length
    ? `<h2>Problems</h2><div class="warn"><ul>${brief.problems
        .map((p) => `<li>${esc(p)}</li>`)
        .join("")}</ul></div>`
    : "";

  const body = brief.videos.length
    ? `<h2>${brief.videos.length} new video${
        brief.videos.length === 1 ? "" : "s"
      }</h2>\n${cards}`
    : `<h2>New videos</h2><p class="empty">Nothing new today.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily brief — ${esc(brief.date)}</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
<div class="date">${esc(brief.date)}</div>
<h1>${esc(brief.headline)}</h1>
<p class="overview">${esc(brief.overview)}</p>
${throughlines}
${body}
${disappeared}
${problems}
<footer>Generated from your whitelisted creators. Transcripts archived locally.</footer>
</div></body></html>`;
}

/** Plain-text alternative for mail clients that refuse HTML. */
export function renderBriefText(brief: Brief): string {
  const lines = [brief.date, brief.headline, "", brief.overview, ""];

  if (brief.throughlines.length) {
    lines.push("WORTH NOTICING");
    brief.throughlines.forEach((t) => lines.push(`  - ${t}`));
    lines.push("");
  }

  for (const v of brief.videos) {
    lines.push(`${v.meta.channel ?? "unknown"} — ${v.meta.title}`);
    lines.push(`  ${v.summary}`);
    if (v.claims.length) {
      lines.push("  Claims:");
      v.claims.forEach((c) => lines.push(`    - ${c}`));
    }
    lines.push(`  So what: ${v.soWhat}`);
    lines.push(`  https://www.youtube.com/watch?v=${v.meta.id}`);
    lines.push("");
  }

  if (brief.disappeared.length) {
    lines.push("REMOVED SINCE LAST CHECK");
    brief.disappeared.forEach((d) =>
      lines.push(`  - ${d.channel ?? "unknown"} — ${d.title} (${d.url})`)
    );
    lines.push("");
  }

  if (brief.problems.length) {
    lines.push("PROBLEMS");
    brief.problems.forEach((p) => lines.push(`  - ${p}`));
  }

  return lines.join("\n") + "\n";
}
