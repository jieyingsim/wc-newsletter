import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"
const TWILIO_TO = process.env.TWILIO_WHATSAPP_TO;     // e.g. "whatsapp:+6591234567"
const BRACKET_URL = process.env.BRACKET_URL;           // e.g. "https://yourusername.github.io/wc-newsletter/bracket.html"

const SPORTRADAR_API_KEY = process.env.SPORTRADAR_API_KEY;
const SR_BASE = "https://api.sportradar.com/soccer/trial/v4/en";

// ── Sportradar helpers ────────────────────────────────────────────────────────
async function srFetch(path) {
  const url = `${SR_BASE}${path}?api_key=${SPORTRADAR_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SR ${res.status}: ${url}`);
  return res.json();
}

async function getWorldCupData() {
  try {
    // FIFA World Cup 2026 tournament ID
    const TOURNAMENT_ID = "sr:tournament:16";
    
    const [schedule, standings] = await Promise.all([
      srFetch(`/tournaments/${TOURNAMENT_ID}/schedule.json`),
      srFetch(`/tournaments/${TOURNAMENT_ID}/standings.json`),
    ]);

    const now = new Date();
    const todaySGT = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
    const yesterdaySGT = new Date(todaySGT);
    yesterdaySGT.setDate(yesterdaySGT.getDate() - 1);

    const fmt = (d) => d.toISOString().split("T")[0];

    const allMatches = schedule.sport_events || [];

    const recentMatches = allMatches.filter((m) => {
      const matchDate = new Date(m.scheduled);
      const matchSGT = new Date(matchDate.toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
      const matchDay = fmt(matchSGT);
      return (
        (matchDay === fmt(yesterdaySGT) || matchDay === fmt(todaySGT)) &&
        m.sport_event_status?.match_status === "ended"
      );
    });

    const upcomingMatches = allMatches
      .filter((m) => {
        const matchDate = new Date(m.scheduled);
        const matchSGT = new Date(matchDate.toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
        return matchSGT > todaySGT && m.sport_event_status?.match_status !== "ended";
      })
      .slice(0, 8);

    return { recentMatches, upcomingMatches, standings, allMatches };
  } catch (err) {
    console.error("Sportradar fetch failed, using mock data:", err.message);
    return getMockData();
  }
}

function getMockData() {
  return {
    recentMatches: [
      { teams: { home: { name: "Ecuador" }, away: { name: "Germany" } }, sport_event_status: { home_score: 2, away_score: 1 }, scheduled: new Date().toISOString(), tournament_round: { name: "Group E" } },
      { teams: { home: { name: "Ivory Coast" }, away: { name: "Curacao" } }, sport_event_status: { home_score: 2, away_score: 0 }, scheduled: new Date().toISOString(), tournament_round: { name: "Group E" } },
      { teams: { home: { name: "Netherlands" }, away: { name: "Tunisia" } }, sport_event_status: { home_score: 3, away_score: 1 }, scheduled: new Date().toISOString(), tournament_round: { name: "Group F" } },
      { teams: { home: { name: "Japan" }, away: { name: "Sweden" } }, sport_event_status: { home_score: 1, away_score: 1 }, scheduled: new Date().toISOString(), tournament_round: { name: "Group F" } },
    ],
    upcomingMatches: [
      { teams: { home: { name: "Turkey" }, away: { name: "USA" } }, scheduled: new Date(Date.now() + 3600000).toISOString(), tournament_round: { name: "Group D" } },
      { teams: { home: { name: "Paraguay" }, away: { name: "Australia" } }, scheduled: new Date(Date.now() + 3600000).toISOString(), tournament_round: { name: "Group D" } },
      { teams: { home: { name: "Norway" }, away: { name: "France" } }, scheduled: new Date(Date.now() + 7200000).toISOString(), tournament_round: { name: "Group I" } },
      { teams: { home: { name: "Senegal" }, away: { name: "Iraq" } }, scheduled: new Date(Date.now() + 7200000).toISOString(), tournament_round: { name: "Group I" } },
    ],
    standings: { standings: [] },
    allMatches: [],
  };
}

// ── Format match data for Claude ──────────────────────────────────────────────
function formatMatchesForPrompt(recentMatches, upcomingMatches, standings) {
  const formatMatch = (m) => {
    const home = m.teams?.home?.name || m.competitors?.[0]?.name || "TBD";
    const away = m.teams?.away?.name || m.competitors?.[1]?.name || "TBD";
    const hs = m.sport_event_status?.home_score ?? "-";
    const as = m.sport_event_status?.away_score ?? "-";
    const round = m.tournament_round?.name || m.round?.name || "";
    const matchDate = new Date(m.scheduled);
    const sgtTime = matchDate.toLocaleString("en-SG", {
      timeZone: "Asia/Singapore",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    return `  ${home} ${hs} - ${as} ${away} [${round}] @ ${sgtTime} SGT`;
  };

  const formatUpcoming = (m) => {
    const home = m.teams?.home?.name || m.competitors?.[0]?.name || "TBD";
    const away = m.teams?.away?.name || m.competitors?.[1]?.name || "TBD";
    const round = m.tournament_round?.name || m.round?.name || "";
    const matchDate = new Date(m.scheduled);
    const sgtTime = matchDate.toLocaleString("en-SG", {
      timeZone: "Asia/Singapore",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    return `  ${home} vs ${away} [${round}] — ${sgtTime} SGT`;
  };

  const recentStr = recentMatches.length
    ? recentMatches.map(formatMatch).join("\n")
    : "  No completed matches in this window.";

  const upcomingStr = upcomingMatches.length
    ? upcomingMatches.map(formatUpcoming).join("\n")
    : "  No upcoming matches found.";

  const standingsStr = formatStandings(standings);

  return { recentStr, upcomingStr, standingsStr };
}

function formatStandings(standings) {
  if (!standings?.standings?.length) return "Standings not available.";
  return standings.standings
    .map((group) => {
      const header = `Group ${group.name || ""}:`;
      const rows = (group.standings || [])
        .map((t) => `  ${t.rank}. ${t.team?.name} — ${t.points}pts (${t.played}P ${t.win}W ${t.draw}D ${t.loss}L)`)
        .join("\n");
      return `${header}\n${rows}`;
    })
    .join("\n\n");
}

// ── Determine run context ─────────────────────────────────────────────────────
function getRunContext() {
  const now = new Date();
  const sgtHour = parseInt(
    now.toLocaleString("en-US", { timeZone: "Asia/Singapore", hour: "numeric", hour12: false })
  );
  // 8am run = morning recap + today preview
  // 1pm run = midday recap + afternoon/evening preview
  return sgtHour < 12 ? "morning" : "midday";
}

// ── Generate newsletter via Claude ────────────────────────────────────────────
async function generateNewsletter(recentStr, upcomingStr, standingsStr, runContext) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const contextNote =
    runContext === "morning"
      ? "This is the 8AM SGT morning edition. Recap yesterday's/early morning matches. Preview today's upcoming matches."
      : "This is the 1PM SGT midday edition. Recap this morning's matches. Preview this afternoon/evening's upcoming matches.";

  const prompt = `You are a witty, sharp football analyst writing a World Cup 2026 daily WhatsApp newsletter for a busy Singapore professional who can't watch the matches.

${contextNote}

COMPLETED MATCHES:
${recentStr}

UPCOMING MATCHES:
${upcomingStr}

GROUP STANDINGS SNAPSHOT:
${standingsStr}

Write a WhatsApp message (plain text, no markdown, use emojis freely) structured as:

1. Header: "⚽ WC Daily | [Date] | [Morning/Midday] Edition"

2. RESULTS section: For each completed match:
   - Scoreline + 1-2 sentence narrative (what happened, who starred, any drama)
   - If it has GROUP STAGE KNOCKOUT IMPLICATIONS (team qualified, eliminated, or needs result), flag it clearly with 🔔

3. PREVIEW section: For each upcoming match:
   - Teams + kickoff time SGT
   - 2-3 sentence prediction with your pick and brief reasoning
   - Use 🔥 for must-watch matches

4. Short closing line (punchy, 1 sentence)

Keep total length under 600 words. Be direct, opinionated, and entertaining. No fluff.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text;
}

// ── Generate bracket probabilities via Claude ─────────────────────────────────
async function generateBracketData(standingsStr, allMatches) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const knockoutMatches = allMatches
    .filter((m) => m.tournament_round?.name?.toLowerCase().includes("round of") ||
                   m.tournament_round?.name?.toLowerCase().includes("quarter") ||
                   m.tournament_round?.name?.toLowerCase().includes("semi") ||
                   m.tournament_round?.name?.toLowerCase().includes("final"))
    .map((m) => ({
      round: m.tournament_round?.name,
      home: m.teams?.home?.name || m.competitors?.[0]?.name || "TBD",
      away: m.teams?.away?.name || m.competitors?.[1]?.name || "TBD",
      homeScore: m.sport_event_status?.home_score,
      awayScore: m.sport_event_status?.away_score,
      status: m.sport_event_status?.match_status,
      scheduled: m.scheduled,
    }));

  const prompt = `You are a football analyst. Based on the current FIFA World Cup 2026 group standings and your knowledge of each team's squad quality, form, and history, generate realistic knockout bracket advancement probabilities.

GROUP STANDINGS:
${standingsStr}

CONFIRMED KNOCKOUT MATCHES (if any):
${JSON.stringify(knockoutMatches, null, 2)}

Return ONLY a valid JSON object (no markdown, no explanation) in this exact structure:
{
  "lastUpdated": "ISO timestamp",
  "champion": { "team": "Team Name", "probability": 27 },
  "rounds": {
    "roundOf32": [
      {
        "matchId": "M1",
        "home": "Team A",
        "away": "Team B",
        "homeWinPct": 65,
        "awayWinPct": 35,
        "winner": "Team A or null if not yet played",
        "score": "2-1 or null",
        "date": "Jun 29",
        "venue": "City Name"
      }
    ],
    "roundOf16": [...],
    "quarterFinals": [...],
    "semiFinals": [...],
    "final": [...]
  },
  "topContenders": [
    { "team": "Argentina", "flag": "🇦🇷", "winPct": 27 },
    { "team": "France", "flag": "🇫🇷", "winPct": 18 },
    { "team": "Spain", "flag": "🇪🇸", "winPct": 14 },
    { "team": "Brazil", "flag": "🇧🇷", "winPct": 10 },
    { "team": "England", "flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "winPct": 8 },
    { "team": "Germany", "flag": "🇩🇪", "winPct": 7 },
    { "team": "Portugal", "flag": "🇵🇹", "winPct": 5 },
    { "team": "Netherlands", "flag": "🇳🇱", "winPct": 4 }
  ]
}

Use your best football knowledge to assign realistic probabilities. Probabilities in each match must sum to 100. topContenders winPct must sum to roughly 100 across all teams.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Generate bracket HTML ─────────────────────────────────────────────────────
function generateBracketHTML(bracketData) {
  const { rounds, topContenders, champion, lastUpdated } = bracketData;

  const renderMatch = (match, roundLabel) => {
    const isPlayed = match.winner && match.winner !== "null";
    const homeWinner = isPlayed && match.winner === match.home;
    const awayWinner = isPlayed && match.winner === match.away;

    return `
    <div class="match ${isPlayed ? "played" : "upcoming"}">
      <div class="match-meta">${match.matchId} · ${match.date || "TBD"} · ${match.venue || ""}</div>
      <div class="team ${homeWinner ? "winner" : ""} ${isPlayed && !homeWinner ? "loser" : ""}">
        <span class="team-name">${match.home}</span>
        <span class="team-pct">${match.homeWinPct}%</span>
      </div>
      <div class="team ${awayWinner ? "winner" : ""} ${isPlayed && !awayWinner ? "loser" : ""}">
        <span class="team-name">${match.away}</span>
        <span class="team-pct">${match.awayWinPct}%</span>
      </div>
      ${isPlayed ? `<div class="score-badge">${match.score}</div>` : ""}
    </div>`;
  };

  const renderRound = (matches, label) => {
    if (!matches || !matches.length) return "";
    return `
    <div class="round">
      <div class="round-label">${label}</div>
      <div class="matches">
        ${matches.map((m) => renderMatch(m, label)).join("")}
      </div>
    </div>`;
  };

  const contendersHTML = (topContenders || [])
    .map(
      (t) => `
    <div class="contender">
      <span class="flag">${t.flag}</span>
      <span class="cname">${t.team}</span>
      <div class="prob-bar-wrap">
        <div class="prob-bar" style="width:${Math.min(t.winPct * 3.5, 100)}%"></div>
      </div>
      <span class="cpct">${t.winPct}%</span>
    </div>`
    )
    .join("");

  const updated = lastUpdated
    ? new Date(lastUpdated).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" })
    : new Date().toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>WC 2026 · Knockout Bracket</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>
<style>
  :root {
    --bg: #0a0e1a;
    --surface: #111827;
    --surface2: #1a2236;
    --border: #1e2d45;
    --accent: #c8a84b;
    --accent2: #4b8ec8;
    --winner: #2d6a4f;
    --winner-text: #52b788;
    --loser-text: #4a5568;
    --text: #e2e8f0;
    --muted: #64748b;
    --pill: #7c3aed;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', sans-serif;
    min-height: 100vh;
    padding: 0 0 60px;
  }
  /* Header */
  .hero {
    background: linear-gradient(135deg, #0a0e1a 0%, #0f1e3a 50%, #0a1628 100%);
    border-bottom: 1px solid var(--border);
    padding: 36px 24px 28px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .hero::before {
    content: '⚽';
    position: absolute;
    font-size: 200px;
    opacity: 0.04;
    top: -40px; left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .hero-eyebrow {
    font-family: 'Space Mono', monospace;
    font-size: 11px;
    letter-spacing: 3px;
    color: var(--accent);
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .hero-title {
    font-size: clamp(24px, 5vw, 42px);
    font-weight: 700;
    letter-spacing: -1px;
    background: linear-gradient(90deg, #e2e8f0, var(--accent));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
  }
  .hero-sub {
    color: var(--muted);
    font-size: 13px;
  }
  .updated-badge {
    display: inline-block;
    margin-top: 14px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 4px 14px;
    font-family: 'Space Mono', monospace;
    font-size: 11px;
    color: var(--muted);
  }

  /* Champion callout */
  .champion-bar {
    background: linear-gradient(90deg, #1a1200, #1a1a00, #0a0e1a);
    border-bottom: 1px solid #3d3000;
    padding: 14px 24px;
    text-align: center;
    font-size: 14px;
    color: var(--accent);
    letter-spacing: 0.5px;
  }
  .champion-bar strong { font-size: 16px; }

  /* Layout */
  .bracket-scroll-hint {
    text-align: center;
    padding: 12px;
    font-size: 12px;
    color: var(--muted);
    font-family: 'Space Mono', monospace;
  }
  .bracket-outer {
    overflow-x: auto;
    padding: 24px 16px;
    -webkit-overflow-scrolling: touch;
  }
  .bracket {
    display: flex;
    gap: 20px;
    min-width: max-content;
    align-items: flex-start;
  }

  /* Round */
  .round { display: flex; flex-direction: column; gap: 0; width: 200px; }
  .round-label {
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--accent);
    padding: 0 4px 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .matches { display: flex; flex-direction: column; gap: 12px; }

  /* Match card */
  .match {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    position: relative;
    transition: border-color 0.2s;
  }
  .match:hover { border-color: var(--accent2); }
  .match.played { border-left: 3px solid var(--winner-text); }
  .match-meta {
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    margin-bottom: 8px;
    letter-spacing: 0.3px;
  }
  .team {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 0;
    border-bottom: 1px solid var(--border);
  }
  .team:last-of-type { border-bottom: none; }
  .team-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }
  .team-pct {
    font-family: 'Space Mono', monospace;
    font-size: 11px;
    color: var(--pill);
    font-weight: 700;
  }
  .team.winner .team-name { color: var(--winner-text); font-weight: 700; }
  .team.winner .team-pct { color: var(--winner-text); }
  .team.loser .team-name { color: var(--loser-text); text-decoration: line-through; }
  .team.loser .team-pct { color: var(--loser-text); }
  .score-badge {
    position: absolute;
    top: 8px; right: 10px;
    background: var(--winner);
    color: var(--winner-text);
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 6px;
  }

  /* Contenders panel */
  .contenders-section {
    max-width: 680px;
    margin: 32px auto 0;
    padding: 0 16px;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  .section-label {
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--accent);
  }
  .section-divider { flex: 1; height: 1px; background: var(--border); }
  .contender {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 8px;
    transition: background 0.2s;
  }
  .contender:hover { background: var(--surface2); }
  .flag { font-size: 22px; width: 28px; }
  .cname { font-size: 14px; font-weight: 600; width: 110px; }
  .prob-bar-wrap { flex: 1; background: var(--border); border-radius: 4px; height: 6px; overflow: hidden; }
  .prob-bar { height: 100%; background: linear-gradient(90deg, var(--pill), var(--accent2)); border-radius: 4px; transition: width 0.6s ease; }
  .cpct { font-family: 'Space Mono', monospace; font-size: 13px; color: var(--pill); font-weight: 700; width: 38px; text-align: right; }

  /* Footer */
  .footer {
    text-align: center;
    padding: 40px 16px 0;
    font-size: 11px;
    color: var(--muted);
    font-family: 'Space Mono', monospace;
  }
</style>
</head>
<body>

<div class="hero">
  <div class="hero-eyebrow">FIFA World Cup 2026</div>
  <div class="hero-title">Knockout Bracket</div>
  <div class="hero-sub">Advancement probabilities · Auto-updated twice daily</div>
  <div class="updated-badge">Last updated: ${updated} SGT</div>
</div>

<div class="champion-bar">
  🏆 Most likely champion: <strong>${champion?.team || "TBD"}</strong> &nbsp;·&nbsp; ${champion?.probability || "—"}% probability
</div>

<div class="bracket-scroll-hint">← Scroll horizontally to see full bracket →</div>

<div class="bracket-outer">
  <div class="bracket">
    ${renderRound(rounds?.roundOf32, "Round of 32")}
    ${renderRound(rounds?.roundOf16, "Round of 16")}
    ${renderRound(rounds?.quarterFinals, "Quarterfinals")}
    ${renderRound(rounds?.semiFinals, "Semifinals")}
    ${renderRound(rounds?.final, "Final")}
  </div>
</div>

<div class="contenders-section">
  <div class="section-header">
    <div class="section-label">Title Contenders</div>
    <div class="section-divider"></div>
  </div>
  ${contendersHTML}
</div>

<div class="footer">
  ⚽ WC 2026 Newsletter · Probabilities simulated by Claude AI · Updated 8AM & 1PM SGT daily
</div>

</body>
</html>`;
}

// ── Send WhatsApp ─────────────────────────────────────────────────────────────
async function sendWhatsApp(message) {
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const sent = await client.messages.create({
    from: TWILIO_FROM,
    to: TWILIO_TO,
    body: message,
  });
  console.log("WhatsApp sent:", sent.sid);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🌍 WC Newsletter starting...");

  const runContext = getRunContext();
  console.log(`Run context: ${runContext}`);

  // 1. Fetch live data
  const { recentMatches, upcomingMatches, standings, allMatches } = await getWorldCupData();
  console.log(`Fetched ${recentMatches.length} recent, ${upcomingMatches.length} upcoming matches`);

  // 2. Format for prompts
  const { recentStr, upcomingStr, standingsStr } = formatMatchesForPrompt(
    recentMatches,
    upcomingMatches,
    standings
  );

  // 3. Generate newsletter text
  const newsletter = await generateNewsletter(recentStr, upcomingStr, standingsStr, runContext);
  console.log("Newsletter generated ✓");

  // 4. Generate bracket data
  const bracketData = await generateBracketData(standingsStr, allMatches);
  console.log("Bracket data generated ✓");

  // 5. Generate bracket HTML
  const bracketHTML = generateBracketHTML(bracketData);
  const docsDir = path.join(__dirname, "..", "docs");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "bracket.html"), bracketHTML, "utf8");
  console.log("Bracket HTML written ✓");

  // 6. Compose final WA message
  const bracketLink = BRACKET_URL || "https://yourusername.github.io/wc-newsletter/bracket.html";
  const fullMessage = `${newsletter}\n\n📊 Live bracket → ${bracketLink}`;

  // 7. Send
  await sendWhatsApp(fullMessage);
  console.log("✅ Done");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
