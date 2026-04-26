require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 180);
const MAX_MATCHES = Number(process.env.MAX_MATCHES_PER_ROUND || 40);

const MIN_RADAR = Number(process.env.MIN_RADAR || 3.5);
const MIN_NORMAL = Number(process.env.MIN_NORMAL || 4.8);
const MIN_ELITE = Number(process.env.MIN_ELITE || 6.5);
const MIN_VALUE = Number(process.env.MIN_VALUE || 1.0);
const DEFAULT_ODDS = Number(process.env.DEFAULT_ODDS || 1.80);

let memory = {};
let lastSent = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("Telegram hata:", err.response?.data || err.message);
  }
}

function badLeague(name = "") {
  const bad = ["U19", "U20", "U21", "U23", "Youth", "Reserve", "Women", "Friendly", "Amateur", "Regional"];
  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function getStat(stats, type) {
  const raw = stats.find(s => s.type === type)?.value;
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "string" && raw.includes("%")) return Number(raw.replace("%", "")) || 0;
  return Number(raw) || 0;
}

function extractStats(teamStats) {
  const s = teamStats?.statistics || [];
  return {
    shots: getStat(s, "Total Shots"),
    shotsOn: getStat(s, "Shots on Goal"),
    shotsOff: getStat(s, "Shots off Goal"),
    corners: getStat(s, "Corner Kicks"),
    dangerous: getStat(s, "Dangerous Attacks")
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

function diff(now, old) {
  return {
    shots: Math.max(0, now.shots - old.shots),
    shotsOn: Math.max(0, now.shotsOn - old.shotsOn),
    shotsOff: Math.max(0, now.shotsOff - old.shotsOff),
    corners: Math.max(0, now.corners - old.corners),
    dangerous: Math.max(0, now.dangerous - old.dangerous)
  };
}

function pressureScore(t) {
  return (
    t.shots * 0.35 +
    t.shotsOn * 1.2 +
    t.corners * 0.75 +
    t.dangerous * 0.08
  );
}

function absolutePressureScore(t, minute, goals) {
  let s = 0;

  s += t.shots * 0.18;
  s += t.shotsOn * 0.85;
  s += t.corners * 0.45;
  s += t.dangerous * 0.035;

  if (minute >= 20 && minute <= 42 && goals === 0) s += 1.2;
  if (minute >= 55 && minute <= 80) s += 0.9;
  if (t.shotsOn >= 3) s += 0.8;
  if (t.corners >= 4) s += 0.5;
  if (t.dangerous >= 35) s += 0.7;

  return Number(s.toFixed(1));
}

function chooseSide(home, away) {
  const h = pressureScore(home);
  const a = pressureScore(away);
  if (h >= a + 2.5) return "Ev";
  if (a >= h + 2.5) return "Deplasman";
  return "Dengeli";
}

function selectMarket(minute, homeGoals, awayGoals, side) {
  const goals = homeGoals + awayGoals;

  if (minute >= 12 && minute <= 45) {
    if (goals === 0) return "İlk Yarı 0.5 ÜST";
    if (goals === 1 && minute <= 42) return "İlk Yarı 1.5 ÜST";
  }

  if (minute >= 46 && minute <= 90) {
    if (goals <= 1) return "Maç Sonu 1.5 ÜST";
    if (goals === 2) return "Maç Sonu 2.5 ÜST";
    if (goals === 3) return "Maç Sonu 3.5 ÜST";
    if (goals === 4) return "Maç Sonu 4.5 ÜST";
  }

  if (side === "Ev") return "Sıradaki Gol Ev";
  if (side === "Deplasman") return "Sıradaki Gol Deplasman";

  return null;
}

function signalType(score) {
  if (score >= MIN_ELITE) return "🔥 ELITE";
  if (score >= MIN_NORMAL) return "🟢 NORMAL";
  return null;
}

function botProbability(score) {
  return Math.min(82, Math.max(50, Number((score * 11).toFixed(1))));
}

function impliedProbability(odds) {
  return Number((100 / odds).toFixed(1));
}

function valuePercent(botProb, bookProb) {
  return Number((botProb - bookProb).toFixed(1));
}

function matchPriority(m) {
  const minute = m.fixture.status.elapsed || 0;
  const goals = Number(m.goals.home || 0) + Number(m.goals.away || 0);

  let score = 0;
  if (minute >= 15 && minute <= 42 && goals === 0) score += 5;
  if (minute >= 55 && minute <= 80) score += 4;
  if (goals <= 2) score += 2;

  return score;
}

async function fetchLiveMatches() {
  try {
    const liveRes = await axios.get("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": API_KEY }
    });

    const matches = liveRes.data.response || [];

    const filteredMatches = matches
      .filter(m => {
        const minute = m.fixture.status.elapsed;
        const league = m.league.name || "";

        if (!minute || minute < 12 || minute > 90) return false;
        if (badLeague(league)) return false;

        return true;
      })
      .sort((a, b) => matchPriority(b) - matchPriority(a))
      .slice(0, MAX_MATCHES);

    console.log(`API TEST: ${matches.length} canlı maç | İncelenecek: ${filteredMatches.length}`);

    let statsBakildi = 0;
    let statsYok = 0;
    let radarGitti = 0;
    let sinyal = 0;

    for (const m of filteredMatches) {
      const id = m.fixture.id;
      const minute = m.fixture.status.elapsed;
      const league = m.league.name;
      const country = m.league.country;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const homeGoals = Number(m.goals.home || 0);
      const awayGoals = Number(m.goals.away || 0);
      const goals = homeGoals + awayGoals;

      await sleep(1300);

      const statsRes = await axios.get(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        { headers: { "x-apisports-key": API_KEY } }
      );

      const stats = statsRes.data.response || [];

      if (!stats || stats.length < 2) {
        statsYok++;
        continue;
      }

      statsBakildi++;

      const homeNow = extractStats(stats[0]);
      const awayNow = extractStats(stats[1]);
      const totalNow = total(homeNow, awayNow);

      const old = memory[id];
      memory[id] = { minute, home: homeNow, away: awayNow, total: totalNow };

      const side = chooseSide(homeNow, awayNow);
      const market = selectMarket(minute, homeGoals, awayGoals, side);

      if (!market) continue;

      let momentumScore = 0;

      if (old) {
        const homeDiff = diff(homeNow, old.home);
        const awayDiff = diff(awayNow, old.away);
        const totalDiff = total(homeDiff, awayDiff);
        momentumScore = pressureScore(totalDiff);
      }

      const absoluteScore = absolutePressureScore(totalNow, minute, goals);
      const finalScore = Math.max(absoluteScore, momentumScore);

      const botProb = botProbability(finalScore);
      const bookProb = impliedProbability(DEFAULT_ODDS);
      const value = valuePercent(botProb, bookProb);

      const radarKey = `${id}_radar`;
      const lastRadar = lastSent[radarKey] || 0;

      if (finalScore >= MIN_RADAR && finalScore < MIN_NORMAL) {
        if (Date.now() - lastRadar > 10 * 60 * 1000) {
          lastSent[radarKey] = Date.now();
          radarGitti++;

          await sendTelegram(`
⚠️ <b>RADAR TAKİP</b>

<b>Maç:</b> ${home} - ${away}
<b>Ülke/Lig:</b> ${country} / ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market Adayı:</b> ${market}
<b>Yön:</b> ${side}

📊 <b>Baskı Skoru:</b> ${finalScore}/10
🔥 <b>Value:</b> %${value}

🤖 <b>Bot Görüşü:</b>
Maç ısınmış görünüyor. Henüz net giriş değil ama takip edilmeli.
`);
        }

        continue;
      }

      const type = signalType(finalScore);
      if (!type) continue;

      if (value < MIN_VALUE) continue;

      const last = lastSent[id] || 0;
      if (Date.now() - last < 10 * 60 * 1000) continue;

      lastSent[id] = Date.now();
      sinyal++;

      await sendTelegram(`
💰 ${type} <b>GİR</b>

<b>Maç:</b> ${home} - ${away}
<b>Ülke/Lig:</b> ${country} / ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market:</b> ${market}
<b>Yön:</b> ${side}

📊 <b>Baskı Skoru:</b> ${finalScore}/10
💰 <b>Oran:</b> ${DEFAULT_ODDS}
📈 <b>Bot İhtimal:</b> %${botProb}
📉 <b>Book İhtimal:</b> %${bookProb}
🔥 <b>Value:</b> %${value} ✅

⚠️ <b>Not:</b> Risk içerir. Küçük stake ile takip et.
`);
    }

    console.log(
      `ÖZET → StatsBakıldı:${statsBakildi} | StatsYok:${statsYok} | RadarGitti:${radarGitti} | Sinyal:${sinyal}`
    );

  } catch (err) {
    console.log("HATA:", err.response?.data || err.message);
  }
}

console.log("💰 FINAL SİNYAL BOTU + ABSOLUTE PRESSURE aktif...");

setTimeout(() => {
  sendTelegram("✅ FINAL SİNYAL BOTU aktif.")
    .then(() => console.log("Telegram test mesajı gönderildi."))
    .catch(err => console.log("Telegram test hatası:", err.response?.data || err.message));
}, 10000);

fetchLiveMatches();
setInterval(fetchLiveMatches, POLL_SECONDS * 1000);