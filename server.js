const axios = require("axios");

// ENV
const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL) || 180000; // 3 dk
const MAX_MATCHES = Number(process.env.MAX_MATCHES_PER_ROUND) || 20;

console.log("🤖 BOT + PARA MODU + RADAR + AUTO TRACK AKTİF");

// ================= TELEGRAM =================
async function sendTelegram(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    });
  } catch (err) {
    console.log("Telegram hata:", err.message);
  }
}

// ================= API =================
async function getLiveMatches() {
  try {
    const res = await axios.get(
      "https://v3.football.api-sports.io/fixtures?live=all",
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    return res.data.response || [];
  } catch (err) {
    const hata = err.response?.data || err.message;

    console.log("🚨 API HATA:", hata);

    // RATE LIMIT koruma
    if (JSON.stringify(hata).includes("Too many requests")) {
      console.log("⏳ Rate limit → bekleniyor...");
      await new Promise(r => setTimeout(r, 60000));
    }

    return [];
  }
}

// ================= STATS =================
async function getStats(fixtureId) {
  try {
    const res = await axios.get(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    return res.data.response;
  } catch (err) {
    return null;
  }
}

// ================= BASİT MOMENTUM =================
function calculatePressure(stats) {
  try {
    const home = stats[0].statistics;
    const away = stats[1].statistics;

    const get = (arr, name) =>
      arr.find(x => x.type === name)?.value || 0;

    const pressure =
      get(home, "Shots on Goal") * 2 +
      get(home, "Shots off Goal") +
      get(home, "Corner Kicks") * 1.5 +
      get(home, "Dangerous Attacks") * 0.1;

    return pressure;
  } catch {
    return 0;
  }
}

// ================= ANA LOOP =================
async function runBot() {
  const matches = await getLiveMatches();

  console.log(`⚽ ${matches.length} canlı maç | İncelenecek: ${MAX_MATCHES}`);

  let checked = 0;
  let signal = 0;

  for (let m of matches.slice(0, MAX_MATCHES)) {
    const fixture = m.fixture;
    const teams = m.teams;
    const goals = m.goals;
    const minute = m.fixture.status.elapsed;

    const stats = await getStats(fixture.id);
    if (!stats) continue;

    checked++;

    const pressure = calculatePressure(stats);

    // ================= SİNYAL ŞART =================
    if (
      pressure > 10 &&   // momentum
      minute >= 60 && minute <= 75 && // para zamanı
      goals.home + goals.away <= 3
    ) {
      signal++;

      const msg = `
💰🔥 <b>ELITE GİR</b>

🏟 ${teams.home.name} - ${teams.away.name}
⏱ Dakika: ${minute}
⚽ Skor: ${goals.home}-${goals.away}

📊 Baskı: ${pressure.toFixed(1)}/10

🎯 Market: Maç Sonu 2.5 ÜST
💸 Oran: ~1.70 - 1.90

⚠️ Küçük stake gir
      `;

      await sendTelegram(msg);
    }
  }

  console.log(`📊 ÖZET → Bakıldı: ${checked} | Sinyal: ${signal}`);
}

// ================= LOOP =================
setInterval(runBot, POLL_INTERVAL);

// TEST MESAJI
sendTelegram("🤖 BOT + AUTO WIN TRACK AKTİF");