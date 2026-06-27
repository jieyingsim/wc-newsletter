import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Sportradar ────────────────────────────────────────────────────────────────
const SR_KEY = process.env.SPORTRADAR_API_KEY;
const SR_BASE = "https://api.sportradar.us/soccer/trial/v4/en";

function srGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = `${SR_BASE}${urlPath}?api_key=${SR_KEY}`;
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
        });
      })
      .on("error", reject);
  });
}

async function fetchTodaySchedule() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  try { return await srGet(`/schedules/${today}/results.json`); }
  catch (e) { console.warn("Schedule fetch failed:", e.message); return null; }
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function isEightAmRun() {
  return new Date().getUTCHours() < 3; // 00:00 UTC = 8am SGT
}

// ── Claude digest ─────────────────────────────────────────────────────────────
async function generateDigest(scheduleData) {
  const bracketUrl = process.env.BRACKET_URL;
  const systemPrompt = `You are a witty football journalist covering FIFA World Cup 2026.
Write punchy WhatsApp-friendly messages — no markdown, use emojis naturally, under 600 chars.
Always end with the bracket link on its own line.`;

  const results = JSON.stringify(scheduleData?.results?.slice(0, 10) ?? []);
  const userPrompt = isEightAmRun()
    ? `8am SGT briefing. Recap overnight results with flair, flag knockout implications, preview today's matches. Data: ${results}. End with: Live bracket: ${bracketUrl}`
    : `1pm SGT update. Summarise morning results, preview afternoon/evening matches. Data: ${results}. End with: Live bracket: ${bracketUrl}`;

  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return msg.content[0].text;
}

// ── WhatsApp send ─────────────────────────────────────────────────────────────
async function sendWhatsApp(body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.TWILIO_WHATSAPP_TO,
    body,
  });
}

// ── Bracket HTML generator ────────────────────────────────────────────────────
function generateBracketHtml(scheduleData) {
  const now = new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
  const results = scheduleData?.results ?? [];

  const matchRows = results.slice(0, 20).map((r) => {
    const home = r.sport_event?.competitors?.[0]?.name ?? "TBD";
    const away = r.sport_event?.competitors?.[1]?.name ?? "TBD";
    const homeScore = r.sport_event_status?.home_score ?? "-";
    const awayScore = r.sport_event_status?.away_score ?? "-";
    const status = r.sport_event_status?.match_status ?? "scheduled";
    const time = r.sport_event?.start_time
      ? new Date(r.sport_event.start_time).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "short", timeStyle: "short" })
      : "";
    const winner = homeScore > awayScore ? home : awayScore > homeScore ? away : "Draw";
    const badge = status === "ended"
      ? `<span class="badge ended">FT</span>`
      : status === "live"
        ? `<span class="badge live">LIVE</span>`
        : `<span class="badge upcoming">${time}</span>`;
    return `<tr><td>${home}</td><td class="score">${homeScore} - ${awayScore}</td><td>${away}</td><td>${badge}</td><td>${status === "ended" ? winner : "-"}</td></tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FIFA World Cup 2026 Live Bracket</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a1a;color:#f0f0f0;min-height:100vh;padding:1rem}
    header{text-align:center;padding:2rem 1rem 1rem}
    header h1{font-size:1.8rem;color:#ffd700}
    header p{color:#888;margin-top:.4rem;font-size:.85rem}
    .updated{color:#4ade80;font-size:.8rem;margin-top:.3rem}
    .container{max-width:900px;margin:0 auto}
    table{width:100%;border-collapse:collapse;margin-top:1.5rem;background:#11112b;border-radius:12px;overflow:hidden}
    thead tr{background:#1e1e4a}
    th{padding:.75rem 1rem;text-align:left;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:#888}
    td{padding:.75rem 1rem;border-top:1px solid #1e1e3a;font-size:.9rem}
    .score{font-size:1.1rem;font-weight:700;color:#ffd700;text-align:center}
    tr:hover td{background:#1a1a3a}
    .badge{display:inline-block;padding:.2rem .5rem;border-radius:4px;font-size:.75rem;font-weight:700}
    .badge.ended{background:#1e3a1e;color:#4ade80}
    .badge.live{background:#3a1e1e;color:#f87171;animation:pulse 1.5s infinite}
    .badge.upcoming{background:#1e2a3a;color:#93c5fd}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    .empty{text-align:center;padding:3rem;color:#555}
    footer{text-align:center;padding:2rem;color:#444;font-size:.75rem}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>FIFA World Cup 2026</h1>
      <p>Live Results and Bracket</p>
      <p class="updated">Last updated: ${now} SGT</p>
    </header>
    ${matchRows ? `<table><thead><tr><th>Home</th><th style="text-align:center">Score</th><th>Away</th><th>Status</th><th>Winner</th></tr></thead><tbody>${matchRows}</tbody></table>` : '<div class="empty">No match data yet</div>'}
    <footer>Auto-updated twice daily via GitHub Actions - Data: Sportradar</footer>
  </div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("WC 2026 Newsletter - starting at", new Date().toISOString());

  const scheduleResult = await Promise.allSettled([fetchTodaySchedule()]);
  const schedule = scheduleResult[0].status === "fulfilled" ? scheduleResult[0].value : null;

  // 1. Generate and save bracket HTML
  const html = generateBracketHtml(schedule);
  const bracketPath = path.join(__dirname, "..", "docs", "bracket.html");
  fs.mkdirSync(path.dirname(bracketPath), { recursive: true });
  fs.writeFileSync(bracketPath, html, "utf8");
  console.log("bracket.html written");

  // 2. Generate WhatsApp message via Claude
  const digest = await generateDigest(schedule);
  console.log("Digest:", digest);

  // 3. Send WhatsApp
  const msg = await sendWhatsApp(digest);
  console.log("WhatsApp sent - SID:", msg.sid);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
