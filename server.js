require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 45);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 8.5);

let memory = {};
let lastSent = {};

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

function badLeague(leagueName = "") {
  const bad = [
    "U19", "U20", "U21", "U23",
    "Youth", "Reserve", "Reserves",
    "Women", "W",
    "Friendly", "Club Friendlies",
    "Amateur", "Regional"
  ];
  return bad.some(x => leagueName.toLowerCase().includes(x.toLowerCase()));
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
    possession: getStat(s, "Ball Possession"),
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

  if (h >= a + 4) return { side: "Ev", score: h, diff: homeDiff };
  if (a >= h + 4) return { side: "Deplasman", score: a, diff: awayDiff };
  return { side: "Dengeli", score: Math.max(h, a), diff: h >= a ? homeDiff : awayDiff };
}

function confidence(minute, scoreHome, scoreAway, totalDiff, dominant) {
  let c = 5;

  c += totalDiff.shots * 0.35;
  c += totalDiff.shotsOn * 0.9;
  c += totalDiff.corners * 0.55;
  c += totalDiff.dangerous * 0.08;

  if (dominant.side !== "Dengeli") c += 0.6;
  if (totalDiff.shotsOn >= 2) c += 0.7;
  if (totalDiff.corners >= 2) c += 0.4;
  if (totalDiff.dangerous >= 14) c += 0.5;

  const goals = scoreHome + scoreAway;

  if (minute >= 18 && minute <= 44 && goals === 0) c += 0.5;
  if (minute >= 50 && minute <= 78) c += 0.4;
  if (minute > 82) c -= 0.8;

  return Math.min(10, Math.max(0, Number(c.toFixed(1))));
}

function selectMarket(minute, homeGoals, awayGoals, totalDiff, dominant) {
  const goals = homeGoals + awayGoals;

  // 0-45 ilk yarı
  if (minute >= 12 && minute <= 45) {
    if (goals === 0) return "İlk Yarı 0.5 ÜST";

    if (
      goals === 1 &&
      minute <= 42 &&
      totalDiff.shots >= 4 &&
      totalDiff.shotsOn >= 2 &&
      totalDiff.dangerous >= 12
    ) {
      return "İlk Yarı 1.5 ÜST";
    }

    if (dominant.side === "Ev") return "Sıradaki Gol Ev";
    if (dominant.side === "Deplasman") return "Sıradaki Gol Deplasman";
  }

  // 45-90 maç sonu
  if (minute >= 46 && minute <= 90) {
    if (goals === 0) return "Maç Sonu 1.5 ÜST";
    if (goals === 1) return "Maç Sonu 1.5 ÜST";
    if (goals === 2) return "Maç Sonu 2.5 ÜST";
    if (goals === 3) return "Maç Sonu 3.5 ÜST";
    if (goals === 4) return "Maç Sonu 4.5 ÜST";

    if (dominant.side === "Ev") return "Sıradaki Gol Ev";
    if (dominant.side === "Deplasman") return "Sıradaki Gol Deplasman";
  }

  return null;
}

function validMomentum(totalDiff) {
  // fake sinyal engeli: tek başına atak yetmez
  if (totalDiff.shots < 3) return false;
  if (totalDiff.shotsOn < 1) return false;
  if (totalDiff.dangerous < 8) return false;

  // sadece korner / sadece tehlikeli atak sinyali atmasın
  if (totalDiff.shotsOn === 0) return false;

  return true;
}

function botView(market, dominant, totalDiff, conf) {
  const sideText =
    dominant.side === "Dengeli"
      ? "İki takımda da tempo var"
      : `Momentum ${dominant.side} tarafına geçti`;

  return `${sideText}. Son periyotta ${totalDiff.shots} şut, ${totalDiff.shotsOn} isabetli şut, ${totalDiff.corners} korner ve ${totalDiff.dangerous} tehlikeli atak artışı var. API verisi bu market için güçlü gol baskısı gösteriyor.`;
}

async function fetchLiveMatches() {
  try {
    const fixtures = await axios.get("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": API_KEY }
    });

    const matches = fixtures.data.response || [];

    for (const m of matches) {
      const id = m.fixture.id;
      const minute = m.fixture.status.elapsed;
      const league = m.league.name;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const homeGoals = Number(m.goals.home || 0);
      const awayGoals = Number(m.goals.away || 0);

      if (!minute || minute < 8 || minute > 90) continue;
      if (badLeague(league)) continue;

      // sadece sinyal aralığında stats çekiyoruz, limit koruması
      if (!((minute >= 12 && minute <= 45) || (minute >= 46 && minute <= 90))) continue;

      const statsRes = await axios.get(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        { headers: { "x-apisports-key": API_KEY } }
      );

      const stats = statsRes.data.response || [];
      if (stats.length < 2) continue;

      const homeNow = extractTeamStats(stats[0]);
      const awayNow = extractTeamStats(stats[1]);

      const now = {
        minute,
        home: homeNow,
        away: awayNow,
        total: total(homeNow, awayNow)
      };

      const old = memory[id];

      memory[id] = now;

      if (!old) continue;

      const homeDiff = diff(homeNow, old.home);
      const awayDiff = diff(awayNow, old.away);
      const totalDiff = total(homeDiff, awayDiff);

      if (!validMomentum(totalDiff)) continue;

      const dominant = chooseSide(homeDiff, awayDiff);
      const market = selectMarket(minute, homeGoals, awayGoals, totalDiff, dominant);
      if (!market) continue;

      const conf = confidence(minute, homeGoals, awayGoals, totalDiff, dominant);
      if (conf < MIN_CONFIDENCE) continue;

      const last = lastSent[id] || 0;
      if (Date.now() - last < 10 * 60 * 1000) continue;

      lastSent[id] = Date.now();

      const msg = `
🟢 <b>GİR</b>

<b>Maç:</b> ${home} - ${away}
<b>Lig:</b> ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market:</b> ${market}
<b>Yön:</b> ${dominant.side}
<b>Güven:</b> ${conf}/10

🤖 <b>Bot Görüşü:</b>
${botView(market, dominant, totalDiff, conf)}
`;

      await sendTelegram(msg);
      console.log("Sinyal gönderildi:", home, "-", away, market, conf);
    }
  } catch (err) {
    console.log("Hata:", err.response?.data || err.message);
  }
}

console.log("PRO bot çalışıyor...");
fetchLiveMatches();
setInterval(fetchLiveMatches, POLL_SECONDS * 1000);