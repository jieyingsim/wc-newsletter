import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse: " + data.slice(0, 100))); }
      });
    }).on("error", reject);
  });
}

async function fetchMatchData() {
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
  const base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  try {
    const [today, prev] = await Promise.all([fetchJson(base), fetchJson(base + "?dates=" + yStr)]);
    return { today: today.events ?? [], yesterday: prev.events ?? [] };
  } catch (e) {
    console.warn("ESPN fetch failed:", e.message);
    return { today: [], yesterday: [] };
  }
}

function summarise(events) {
  return events.map((e) => {
    const c = e.competitions?.[0];
    const home = c?.competitors?.find((x) => x.homeAway === "home");
    const away = c?.competitors?.find((x) => x.homeAway === "away");
    const status = c?.status?.type?.description ?? "Scheduled";
    const score = home && away
      ? home.team.displayName + " " + (home.score ?? "-") + " - " + (away.score ?? "-") + " " + away.team.displayName
      : e.name;
    return score + " [" + status + "]";
  }).join("\n") || "None";
}

function isEightAmRun() { return new Date().getUTCHours() < 3; }

async function generateDigest(matchData) {
  const { today, yesterday } = matchData;
  const bracketUrl = process.env.BRACKET_URL;
  const prompt = isEightAmRun()
    ? "8am SGT briefing.\nYesterday:\n" + summarise(yesterday) + "\nToday:\n" + summarise(today) + "\nRecap yesterday with flair, flag knockout implications, preview today. End: Live bracket: " + bracketUrl
    : "1pm SGT update.\nToday so far:\n" + summarise(today) + "\nSummarise morning results and preview remaining matches. End: Live bracket: " + bracketUrl;
  const msg = await anthropic.messages.create({
    model: "claude-opus-4-8", max_tokens: 400,
    system: "You are a witty football journalist for FIFA World Cup 2026. Punchy WhatsApp messages, no markdown, emojis, under 600 chars. Always end with the bracket link.",
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content[0].text;
}

async function sendWhatsApp(body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.TWILIO_WHATSAPP_TO,
    body,
  });
}

function generateBracketHtml(matchData) {
  const now = new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
  const all = [...(matchData.yesterday ?? []), ...(matchData.today ?? [])];
  const rows = all.map((e) => {
    const c = e.competitions?.[0];
    const home = c?.competitors?.find((x) => x.homeAway === "home");
    const away = c?.competitors?.find((x) => x.homeAway === "away");
    const done = c?.status?.type?.completed;
    const live = c?.status?.type?.state === "in";
    const hs = home?.score ?? "-", as = away?.score ?? "-";
    const hn = home?.team?.displayName ?? "TBD", an = away?.team?.displayName ?? "TBD";
    const time = e.date ? new Date(e.date).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "short", timeStyle: "short" }) : "";
    const badge = done ? '<span class="b e">FT</span>' : live ? '<span class="b l">LIVE</span>' : '<span class="b u">' + time + '</span>';
    const winner = done ? (hs > as ? hn : as > hs ? an : "Draw") : "-";
    return "<tr><td>" + hn + "</td><td class=s>" + hs + " - " + as + "</td><td>" + an + "</td><td>" + badge + "</td><td>" + winner + "</td></tr>";
  }).join("");
  return "<!DOCTYPE html><html lang=en><head><meta charset=UTF-8><meta name=viewport content=width=device-width,initial-scale=1><title>FIFA WC 2026</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a1a;color:#f0f0f0;padding:1rem}h1{color:#ffd700;text-align:center;padding:2rem 0 .5rem;font-size:1.8rem}.upd{text-align:center;color:#4ade80;font-size:.8rem;margin-bottom:1rem}.wrap{max-width:900px;margin:0 auto}table{width:100%;border-collapse:collapse;background:#11112b;border-radius:12px;overflow:hidden}thead{background:#1e1e4a}th{padding:.6rem 1rem;text-align:left;font-size:.7rem;text-transform:uppercase;color:#888}td{padding:.6rem 1rem;border-top:1px solid #1e1e3a}.s{font-weight:700;color:#ffd700;text-align:center}.b{display:inline-block;padding:.15rem .4rem;border-radius:4px;font-size:.7rem;font-weight:700}.e{background:#1e3a1e;color:#4ade80}.l{background:#3a1e1e;color:#f87171}.u{background:#1e2a3a;color:#93c5fd}footer{text-align:center;padding:1.5rem;color:#444;font-size:.75rem}</style></head><body><div class=wrap><h1>FIFA World Cup 2026</h1><p class=upd>Updated: " + now + " SGT</p>" + (rows ? "<table><thead><tr><th>Home</th><th>Score</th><th>Away</th><th>Status</th><th>Winner</th></tr></thead><tbody>" + rows + "</tbody></table>" : "<p style='text-align:center;padding:3rem;color:#555'>No data yet</p>") + "<footer>Auto-updated twice daily · ESPN</footer></div></body></html>";
}

async function main() {
  console.log("WC 2026 Newsletter -", new Date().toISOString());
  const matchData = await fetchMatchData();
  console.log("Today:", matchData.today.length, "Yesterday:", matchData.yesterday.length);
  const html = generateBracketHtml(matchData);
  const bp = path.join(__dirname, "..", "docs", "bracket.html");
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  fs.writeFileSync(bp, html, "utf8");
  console.log("bracket.html written");
  const digest = await generateDigest(matchData);
  console.log("Digest:", digest);
  const msg = await sendWhatsApp(digest);
  console.log("Sent - SID:", msg.sid);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
