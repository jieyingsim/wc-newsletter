import twilio from "twilio";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── ESPN public API ───────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Parse error: " + data.slice(0, 100))); }
      });
    }).on("error", reject);
  });
}

async function fetchMatchData() {
  const base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yStr = yest.toISOString().slice(0, 10).replace(/-/g, "");
  try {
    const [today, prev] = await Promise.all([fetchJson(base), fetchJson(base + "?dates=" + yStr)]);
    return { today: today.events ?? [], yesterday: prev.events ?? [] };
  } catch (e) {
    console.warn("ESPN fetch failed:", e.message);
    return { today: [], yesterday: [] };
  }
}

// ── Format match ──────────────────────────────────────────────────────────────
function fmtMatch(e) {
  const c = e.competitions?.[0];
  const home = c?.competitors?.find((x) => x.homeAway === "home");
  const away = c?.competitors?.find((x) => x.homeAway === "away");
  const done = c?.status?.type?.completed;
  const live = c?.status?.type?.state === "in";
  const hn = home?.team?.abbreviation ?? "?";
  const an = away?.team?.abbreviation ?? "?";
  const hs = home?.score ?? "";
  const as_ = away?.score ?? "";
  const time = e.date
    ? new Date(e.date).toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit" })
    : "";
  if (done) return hn + " " + hs + " - " + as_ + " " + an + " (FT)";
  if (live) return hn + " " + hs + " - " + as_ + " " + an + " 🔴 LIVE";
  return hn + " vs " + an + " @ " + time;
}

// ── Build WhatsApp message ────────────────────────────────────────────────────
function isEightAmRun() { return new Date().getUTCHours() < 3; }

function buildMessage(matchData) {
  const { today, yesterday } = matchData;
  const bracketUrl = process.env.BRACKET_URL;
  const lines = [];

  if (isEightAmRun()) {
    lines.push("⚽ WC 2026 Morning Briefing");
    lines.push("");
    const finished = yesterday.filter((e) => e.competitions?.[0]?.status?.type?.completed);
    if (finished.length) {
      lines.push("📊 Yesterday's Results:");
      finished.forEach((e) => lines.push("  " + fmtMatch(e)));
    } else {
      lines.push("No results from yesterday.");
    }
    lines.push("");
    if (today.length) {
      lines.push("🗓 Today's Fixtures:");
      today.forEach((e) => lines.push("  " + fmtMatch(e)));
    } else {
      lines.push("No matches today.");
    }
  } else {
    lines.push("⚽ WC 2026 Midday Update");
    lines.push("");
    const done = today.filter((e) => e.competitions?.[0]?.status?.type?.completed);
    const live = today.filter((e) => e.competitions?.[0]?.status?.type?.state === "in");
    const upcoming = today.filter((e) => {
      const s = e.competitions?.[0]?.status?.type?.state;
      return s !== "in" && !e.competitions?.[0]?.status?.type?.completed;
    });
    if (live.length) {
      lines.push("🔴 Live Now:");
      live.forEach((e) => lines.push("  " + fmtMatch(e)));
      lines.push("");
    }
    if (done.length) {
      lines.push("📊 Completed Today:");
      done.forEach((e) => lines.push("  " + fmtMatch(e)));
      lines.push("");
    }
    if (upcoming.length) {
      lines.push("🗓 Still to Come:");
      upcoming.forEach((e) => lines.push("  " + fmtMatch(e)));
    }
    if (!done.length && !live.length && !upcoming.length) {
      lines.push("No matches scheduled today.");
    }
  }

  lines.push("");
  lines.push("🏆 Live bracket: " + bracketUrl);
  return lines.join("\n");
}

// ── Bracket HTML ──────────────────────────────────────────────────────────────
function generateBracketHtml(matchData) {
  const now = new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore" });
  const all = [...(matchData.yesterday ?? []), ...(matchData.today ?? [])];
  const rows = all.map((e) => {
    const c = e.competitions?.[0];
    const home = c?.competitors?.find((x) => x.homeAway === "home");
    const away = c?.competitors?.find((x) => x.homeAway === "away");
    const done = c?.status?.type?.completed;
    const live = c?.status?.type?.state === "in";
    const hs = home?.score ?? "-", as_ = away?.score ?? "-";
    const hn = home?.team?.displayName ?? "TBD", an = away?.team?.displayName ?? "TBD";
    const time = e.date ? new Date(e.date).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "short", timeStyle: "short" }) : "";
    const badge = done ? '<span class="b e">FT</span>' : live ? '<span class="b l">LIVE</span>' : '<span class="b u">' + time + '</span>';
    const winner = done ? (hs > as_ ? hn : as_ > hs ? an : "Draw") : "-";
    return "<tr><td>" + hn + "</td><td class=s>" + hs + " – " + as_ + "</td><td>" + an + "</td><td>" + badge + "</td><td>" + winner + "</td></tr>";
  }).join("");
  return "<!DOCTYPE html><html lang=en><head><meta charset=UTF-8><meta name=viewport content=width=device-width,initial-scale=1><title>FIFA WC 2026</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a1a;color:#f0f0f0;padding:1rem}h1{color:#ffd700;text-align:center;padding:2rem 0 .5rem;font-size:1.8rem}.upd{text-align:center;color:#4ade80;font-size:.8rem;margin-bottom:1rem}.wrap{max-width:900px;margin:0 auto}table{width:100%;border-collapse:collapse;background:#11112b;border-radius:12px;overflow:hidden}thead{background:#1e1e4a}th{padding:.6rem 1rem;text-align:left;font-size:.7rem;text-transform:uppercase;color:#888}td{padding:.6rem 1rem;border-top:1px solid #1e1e3a}.s{font-weight:700;color:#ffd700;text-align:center}.b{display:inline-block;padding:.15rem .4rem;border-radius:4px;font-size:.7rem;font-weight:700}.e{background:#1e3a1e;color:#4ade80}.l{background:#3a1e1e;color:#f87171}.u{background:#1e2a3a;color:#93c5fd}footer{text-align:center;padding:1.5rem;color:#444;font-size:.75rem}</style></head><body><div class=wrap><h1>🏆 FIFA World Cup 2026</h1><p class=upd>Updated: " + now + " SGT</p>" + (rows ? "<table><thead><tr><th>Home</th><th>Score</th><th>Away</th><th>Status</th><th>Winner</th></tr></thead><tbody>" + rows + "</tbody></table>" : "<p style='text-align:center;padding:3rem;color:#555'>No data yet</p>") + "<footer>Auto-updated twice daily · Data: ESPN</footer></div></body></html>";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("WC 2026 Newsletter -", new Date().toISOString());
  const matchData = await fetchMatchData();
  console.log("Today:", matchData.today.length, "Yesterday:", matchData.yesterday.length);

  const html = generateBracketHtml(matchData);
  const bp = path.join(__dirname, "..", "docs", "bracket.html");
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  fs.writeFileSync(bp, html, "utf8");
  console.log("bracket.html written");

  const message = buildMessage(matchData);
  console.log("Message:\n" + message);

  const msg = await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.TWILIO_WHATSAPP_TO,
    body: message,
  });
  console.log("Sent - SID:", msg.sid);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
