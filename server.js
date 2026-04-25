require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let matchMemory = {};
let lastSent = {};

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: CHAT_ID,
    text: message,
  });
}

function isBadLeague(name) {
  const bad = ["U19", "U21", "Women", "Reserve", "Youth", "Friendly"];
  return bad.some(k => name.includes(k));
}

function calculateMomentum(prev, current) {
  return {
    shots: current.shots - prev.shots,
    shotsOn: current.shotsOn - prev.shotsOn,
    attacks: current.attacks - prev.attacks,
    corners: current.corners - prev.corners,
  };
}

function checkSignal(momentum, minute, score) {
  if (!momentum) return null;

  // İlk yarı
  if (minute >= 18 && minute <= 44 && score === "0-0") {
    if (
      momentum.shots >= 3 &&
      momentum.shotsOn >= 1 &&
      momentum.attacks >= 10
    ) {
      return "İlk Yarı 0.5 ÜST";
    }
  }

  // İkinci yarı
  if (minute >= 50 && minute <= 80) {
    if (
      momentum.shots >= 4 &&
      momentum.shotsOn >= 2 &&
      momentum.attacks >= 12
    ) {
      return "Maç Sonu 1.5 ÜST";
    }
  }

  return null;
}

async function fetchMatches() {
  try {
    const res = await axios.get(
      `https://v3.football.api-sports.io/fixtures?live=all`,
      {
        headers: { "x-apisports-key": API_KEY },
      }
    );

    const matches = res.data.response;

    for (let m of matches) {
      const id = m.fixture.id;
      const league = m.league.name;

      if (isBadLeague(league)) continue;

      const minute = m.fixture.status.elapsed;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const score = `${m.goals.home}-${m.goals.away}`;

      const statsRes = await axios.get(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        {
          headers: { "x-apisports-key": API_KEY },
        }
      );

      const stats = statsRes.data.response;

      if (!stats[0] || !stats[1]) continue;

      function getStat(arr, type) {
        return arr.find(x => x.type === type)?.value || 0;
      }

      const homeStats = stats[0].statistics;
      const awayStats = stats[1].statistics;

      const data = {
        shots:
          getStat(homeStats, "Total Shots") +
          getStat(awayStats, "Total Shots"),
        shotsOn:
          getStat(homeStats, "Shots on Goal") +
          getStat(awayStats, "Shots on Goal"),
        attacks:
          getStat(homeStats, "Dangerous Attacks") +
          getStat(awayStats, "Dangerous Attacks"),
        corners:
          getStat(homeStats, "Corner Kicks") +
          getStat(awayStats, "Corner Kicks"),
      };

      let prev = matchMemory[id];
      let momentum = prev ? calculateMomentum(prev, data) : null;

      let signal = checkSignal(momentum, minute, score);

      // spam engelle (10 dk)
      if (signal && (!lastSent[id] || Date.now() - lastSent[id] > 600000)) {
        lastSent[id] = Date.now();

        const message = `
🟢 GİR

${home} - ${away}
Dakika: ${minute}
Skor: ${score}
Market: ${signal}

🤖 Bot Görüşü:
Canlı API verisine göre son dakikalarda baskı arttı. Şut ve tehlikeli atak yükseldiği için gol ihtimali güçlü.
        `;

        await sendTelegram(message);
      }

      matchMemory[id] = data;
    }
  } catch (err) {
    console.log("Hata:", err.message);
  }
}

setInterval(fetchMatches, 30000);

console.log("Bot çalışıyor...");
