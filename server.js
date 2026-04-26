require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 180);
const MAX_MATCHES = Number(process.env.MAX_MATCHES_PER_ROUND || 30);

const MIN_RADAR = Number(process.env.MIN_RADAR || 4.0);
const MIN_NORMAL = Number(process.env.MIN_NORMAL || 5.3);
const MIN_ELITE = Number(process.env.MIN_ELITE || 7.0);
const MIN_VALUE = Number(process.env.MIN_VALUE || 1.3);
const DEFAULT_ODDS = Number(process.env.DEFAULT_ODDS || 1.80);

let memory = {};
let lastSent = {};

const GOOD_COUNTRIES = [
  "Turkey",
  "England",
  "Spain",
  "Italy",
  "Germany",
  "France",
  "Netherlands",
  "Portugal",
  "Belgium",
  "Austria",
  "Switzerland",
  "Denmark",
  "Norway",
  "Sweden",
  "Brazil",
  "Argentina",
  "USA"
];

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
  const bad = [
    "U19", "U20", "U21", "U23",
    "Youth", "Reserve", "Reserves",
    "Women", "Friendly", "Club Friendlies",
    "Amateur", "Regional"
  ];
  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function getStat(stats, type) {
  const raw = stats.find(s => s.type === type)?.value;
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "string" && raw.includes("%")) {
    return Number(raw.replace("%", "")) || 0;
  }
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
  return (
    d.shots * 1.2 +
    d.shotsOn * 3.2 +
    d.shotsOff * 0.8 +
    d.corners * 2.2 +
    d.dangerous * 0.35
  );
}

function chooseSide(homeDiff, awayDiff) {
  const h = pressureScore(homeDiff);
  const a = pressureScore(awayDiff);

  if (h >= a + 4) return "Ev";
  if (a >= h + 4) return "Deplasman";
  return "Dengeli";
}

function validRadarMomentum(t) {
  if (t.shots < 1) return false;
  if (t.shotsOn < 1 && t.corners < 1) return false;
  if (t.dangerous < 4) return false;
  return true;
}

function validMoneyMomentum(t) {
  if (t.shots < 2) return false;
  if (t.shotsOn < 1) return false;
  if (t.dangerous < 6) return false;
  return true;
}

function confidence(minute, homeGoals, awayGoals, t, side) {
  let c = 4.5;

  c += t.shots * 0.4;
  c += t.shotsOn * 1.1;
  c += t.corners * 0.6;
  c += t.dangerous * 0.1;

  if (side !== "Dengeli") c += 0.6;
  if (t.shotsOn >= 2) c += 0.5;
  if (t.dangerous >= 10) c += 0.4;

  const goals = homeGoals + awayGoals;

  if (minute >= 15 && minute <= 42 && goals === 0) c += 0.7;
  if (minute >= 50 && minute <= 80) c += 0.5;
  if (minute > 84) c -= 0.8;

  return Math.min(10, Math.max(0, Number(c.toFixed(1))));
}

function selectMarket(minute, homeGoals, awayGoals, side) {
  const goals = homeGoals + awayGoals;

  if (minute >= 15 && minute <= 45) {
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

function signalType(conf) {
  if (conf >= MIN_ELITE) return "🔥 ELITE";
  if (conf >= MIN_NORMAL) return "🟢 NORMAL";
  return null;
}

function botProbability(conf) {
  return Math.min(82, Math.max(50, Number((conf * 8).toFixed(1))));
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
  if (minute >= 50 && minute <= 80) score += 4;
  if (goals <= 2) score += 2;

  return score;
}

async function fetchLiveMatches() {
  try {
    const liveRes = await axios.get(
      "https://v3.football.api-sports.io/fixtures?live=all",
      { headers: { "x-apisports-key": API_KEY } }
    );

    const matches = liveRes.data.response || [];

    const filteredMatches = matches
      .filter(m => {
        const minute = m.fixture.status.elapsed;
        const league = m.league.name || "";
        const country = m.league.country || "";

        if (!minute || minute < 15 || minute > 90) return false;
        if (badLeague(league)) return false;
        if (!GOOD_COUNTRIES.includes(country)) return false;

        return true;
      })
      .sort((a, b) => matchPriority(b) - matchPriority(a))
      .slice(0, MAX_MATCHES);

    console.log(`API TEST: ${matches.length} canlı maç | Kaliteli filtre: ${filteredMatches.length}`);

    let statsBakildi = 0;
    let statsYok = 0;
    let radarZayif = 0;
    let radarGitti = 0;
    let paraMomentumZayif = 0;
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

      const old = memory[id];

      memory[id] = {
        minute,
        home: homeNow,
        away: awayNow
      };

      if (!old) continue;

      const homeDiff = diff(homeNow, old.home);
      const awayDiff = diff(awayNow, old.away);
      const totalDiff = total(homeDiff, awayDiff);

      const side = chooseSide(homeDiff, awayDiff);
      const market = selectMarket(minute, homeGoals, awayGoals, side);

      if (!market) continue;

      const conf = confidence(minute, homeGoals, awayGoals, totalDiff, side);

      if (!validRadarMomentum(totalDiff)) {
        radarZayif++;
        continue;
      }

      const radarKey = `${id}_radar`;
      const lastRadar = lastSent[radarKey] || 0;

      if (conf >= MIN_RADAR && !validMoneyMomentum(totalDiff)) {
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
<b>Güven:</b> ${conf}/10

🤖 <b>Bot Görüşü:</b>
Maç ısınıyor. Henüz net giriş değil ama baskı oluşmaya başladı.
`);
        }

        continue;
      }

      if (!validMoneyMomentum(totalDiff)) {
        paraMomentumZayif++;
        continue;
      }

      const type = signalType(conf);
      if (!type) continue;

      const botProb = botProbability(conf);
      const bookProb = impliedProbability(DEFAULT_ODDS);
      const value = valuePercent(botProb, bookProb);

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
<b>Güven:</b> ${conf}/10

💰 <b>Oran:</b> ${DEFAULT_ODDS}
📊 <b>Bot İhtimal:</b> %${botProb}
📉 <b>Book İhtimal:</b> %${bookProb}
🔥 <b>Value:</b> %${value} ✅

⚠️ <b>Not:</b> Risk içerir. Küçük stake ile takip et.
`);
    }

    console.log(
      `ÖZET → StatsBakıldı:${statsBakildi} | StatsYok:${statsYok} | RadarZayıf:${radarZayif} | RadarGitti:${radarGitti} | ParaMomentumZayıf:${paraMomentumZayif} | Sinyal:${sinyal}`
    );
  } catch (err) {
    console.log("HATA:", err.response?.data || err.message);
  }
}

console.log("💰 KALİTELİ LİG + PARA MODU + STATS SKIP aktif...");

setTimeout(() => {
  sendTelegram("✅ KALİTELİ LİG + PARA MODU aktif.")
    .then(() => console.log("Telegram test mesajı gönderildi."))
    .catch(err => console.log("Telegram test hatası:", err.response?.data || err.message));
}, 10000);

fetchLiveMatches();
setInterval(fetchLiveMatches, POLL_SECONDS * 1000);