require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 120);
const MAX_MATCHES_PER_ROUND = Number(process.env.MAX_MATCHES_PER_ROUND || 15);
const DEFAULT_ODDS = Number(process.env.DEFAULT_ODDS || 1.80);

const MIN_RADAR = 6.5;
const MIN_NORMAL = 8.0;
const MIN_ELITE = 8.7;
const MIN_VALUE = 6;

let memory = {};
let lastSent = {};
let activeSignals = {};
let lastStatsUpdateId = 0;

let performance = { total: 0, win: 0, lose: 0 };

const VIP_LEAGUES = [
  "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1",
  "Süper Lig", "1. Lig", "Eredivisie", "Primeira Liga",
  "Championship", "FA Cup", "MLS", "Liga Profesional",
  "Brazil", "Brasileiro Serie A", "Jupiler Pro League",
  "Superliga", "Allsvenskan", "Eliteserien"
];

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

function badLeague(name = "") {
  const bad = ["U19","U20","U21","U23","Youth","Reserve","Reserves","Women","Friendly","Club Friendlies","Amateur","Regional"];
  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function isVipLeague(name = "") {
  return VIP_LEAGUES.some(l => name.toLowerCase().includes(l.toLowerCase()));
}

function getStat(stats, type) {
  const raw = stats.find(x => x.type === type)?.value;
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "string" && raw.includes("%")) return Number(raw.replace("%", "")) || 0;
  return Number(raw) || 0;
}

function extractTeamStats(teamStats) {
  const s = teamStats?.statistics || [];
  return {
    shots: getStat(s, "Total Shots"),
    shotsOn: getStat(s, "Shots on Goal"),
    shotsOff: getStat(s, "Shots off Goal"),
    corners: getStat(s, "Corner Kicks"),
    dangerous: getStat(s, "Dangerous Attacks")
  };
}

function diff(now, old) {
  return {
    shots: now.shots - old.shots,
    shotsOn: now.shotsOn - old.shotsOn,
    shotsOff: now.shotsOff - old.shotsOff,
    corners: now.corners - old.corners,
    dangerous: now.dangerous - old.dangerous
  };
}

function total(a, b) {
  return {
    shots: a.shots + b.shots,
    shotsOn: a.shotsOn + b.shotsOn,
    shotsOff: a.shotsOff + b.shotsOff,
    corners: a.corners + b.corners,
    dangerous: a.dangerous + b.dangerous
  };
}

function pressureScore(d) {
  return d.shots * 1.2 + d.shotsOn * 3.2 + d.shotsOff * 0.8 + d.corners * 2.2 + d.dangerous * 0.35;
}

function chooseSide(homeDiff, awayDiff) {
  const h = pressureScore(homeDiff);
  const a = pressureScore(awayDiff);
  if (h >= a + 4) return "Ev";
  if (a >= h + 4) return "Deplasman";
  return "Dengeli";
}

function validRadarMomentum(t) {
  if (t.shots < 2) return false;
  if (t.shotsOn < 1 && t.corners < 1) return false;
  if (t.dangerous < 6) return false;
  return true;
}

function validMoneyMomentum(t) {
  if (t.shots < 3) return false;
  if (t.shotsOn < 2) return false;
  if (t.dangerous < 10) return false;
  return true;
}

function confidence(minute, homeGoals, awayGoals, t, side) {
  let c = 5;
  c += t.shots * 0.35;
  c += t.shotsOn * 0.95;
  c += t.corners * 0.55;
  c += t.dangerous * 0.08;

  if (side !== "Dengeli") c += 0.6;
  if (t.shotsOn >= 3) c += 0.8;
  if (t.dangerous >= 15) c += 0.5;

  const goals = homeGoals + awayGoals;
  if (minute >= 18 && minute <= 40 && goals === 0) c += 0.6;
  if (minute >= 50 && minute <= 75) c += 0.4;
  if (minute > 75) c -= 1.0;

  return Math.min(10, Math.max(0, Number(c.toFixed(1))));
}

function selectMarket(minute, homeGoals, awayGoals) {
  const goals = homeGoals + awayGoals;

  if (minute >= 15 && minute <= 40 && goals === 0) return "İlk Yarı 0.5 ÜST";

  if (minute >= 50 && minute <= 75) {
    if (goals <= 1) return "Maç Sonu 1.5 ÜST";
    if (goals === 2) return "Maç Sonu 2.5 ÜST";
    if (goals === 3) return "Maç Sonu 3.5 ÜST";
  }

  return null;
}

function signalType(conf) {
  if (conf >= MIN_ELITE) return "🔥 ELITE";
  if (conf >= MIN_NORMAL) return "🟢 NORMAL";
  return null;
}

function probabilityFromConfidence(conf) {
  return Math.min(80, Math.max(50, Number((conf * 8).toFixed(1))));
}

function impliedProbability(odds) {
  return Number((100 / odds).toFixed(1));
}

function valuePercent(botProb, bookProb) {
  return Number((botProb - bookProb).toFixed(1));
}

async function fetchLiveMatches() {
  try {
    const fixtures = await axios.get("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": API_KEY }
    });

    const matches = fixtures.data.response || [];

    const filteredMatches = matches
      .filter(m => {
        const minute = m.fixture.status.elapsed;
        const league = m.league.name || "";
        if (!minute || minute < 12 || minute > 75) return false;
        if (badLeague(league)) return false;
        if (!isVipLeague(league)) return false;
        return true;
      })
      .slice(0, MAX_MATCHES_PER_ROUND);

    console.log(`API TEST: ${matches.length} canlı maç | İncelenecek: ${filteredMatches.length}`);

    let checkedStats = 0;
    let skippedNoStats = 0;
    let weakRadar = 0;
    let radarSent = 0;
    let moneyWeak = 0;
    let signalSent = 0;

    for (const m of filteredMatches) {
      const id = m.fixture.id;
      const minute = m.fixture.status.elapsed;
      const league = m.league.name;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const homeGoals = Number(m.goals.home || 0);
      const awayGoals = Number(m.goals.away || 0);

      checkedStats++;

      const statsRes = await axios.get(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        { headers: { "x-apisports-key": API_KEY } }
      );

      const stats = statsRes.data.response || [];
      if (stats.length < 2) {
        skippedNoStats++;
        continue;
      }

      const homeNow = extractTeamStats(stats[0]);
      const awayNow = extractTeamStats(stats[1]);

      const old = memory[id];
      memory[id] = { minute, home: homeNow, away: awayNow, total: total(homeNow, awayNow) };

      if (!old) continue;

      const homeDiff = diff(homeNow, old.home);
      const awayDiff = diff(awayNow, old.away);
      const totalDiff = total(homeDiff, awayDiff);

      const side = chooseSide(homeDiff, awayDiff);
      const market = selectMarket(minute, homeGoals, awayGoals);

      if (!market) continue;

      const conf = confidence(minute, homeGoals, awayGoals, totalDiff, side);

      // ⚠️ RADAR MODU
      if (validRadarMomentum(totalDiff) && conf >= MIN_RADAR && !validMoneyMomentum(totalDiff)) {
        const warnKey = id + "_radar";
        const lastWarn = lastSent[warnKey] || 0;

        if (Date.now() - lastWarn > 12 * 60 * 1000) {
          lastSent[warnKey] = Date.now();
          radarSent++;

          await sendTelegram(`
⚠️ <b>RADAR TAKİP</b>

<b>Maç:</b> ${home} - ${away}
<b>Lig:</b> ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market Adayı:</b> ${market}
<b>Yön:</b> ${side}
<b>Güven:</b> ${conf}/10

🤖 <b>Bot Görüşü:</b>
Maç ısınıyor ama henüz para filtresinden geçmedi. Şut, isabet veya tehlikeli atak artışı başladı. Takibe al.
`);
        }

        continue;
      }

      if (!validRadarMomentum(totalDiff)) {
        weakRadar++;
        continue;
      }

      if (!validMoneyMomentum(totalDiff)) {
        moneyWeak++;
        continue;
      }

      const type = signalType(conf);
      if (!type) continue;

      const botProb = probabilityFromConfidence(conf);
      const bookProb = impliedProbability(DEFAULT_ODDS);
      const value = valuePercent(botProb, bookProb);
      if (value < MIN_VALUE) continue;

      const last = lastSent[id] || 0;
      if (Date.now() - last < 10 * 60 * 1000) continue;

      lastSent[id] = Date.now();
      signalSent++;

      await sendTelegram(`
💰 ${type} <b>VIP GİR</b>

<b>Maç:</b> ${home} - ${away}
<b>Lig:</b> ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market:</b> ${market}
<b>Yön:</b> ${side}
<b>Güven:</b> ${conf}/10

💰 <b>Oran:</b> ${DEFAULT_ODDS}
📊 <b>Bot İhtimal:</b> %${botProb}
📉 <b>Book İhtimal:</b> %${bookProb}
🔥 <b>Value:</b> %${value} ✅
`);
    }

    console.log(
      `ÖZET → StatsBakıldı:${checkedStats} | StatsYok:${skippedNoStats} | RadarZayıf:${weakRadar} | RadarGitti:${radarSent} | ParaMomentumZayıf:${moneyWeak} | Sinyal:${signalSent}`
    );

  } catch (err) {
    console.log("HATA:", err.response?.data || err.message);
  }
}

console.log("💰 VIP PARA BOTU + RADAR aktif...");

setTimeout(() => {
  sendTelegram("✅ VIP PARA BOTU + RADAR aktif.")
    .then(() => console.log("Telegram test mesajı gönderildi."))
    .catch(err => console.log("Telegram test hatası:", err.response?.data || err.message));
}, 10000);

fetchLiveMatches();
setInterval(fetchLiveMatches, POLL_SECONDS * 1000);