import fetch from "node-fetch";

// ================= ENV =================
const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ================= TELEGRAM =================
async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.log("Telegram hata:", err.message);
  }
}

// ================= BAŞLANGIÇ =================
console.log("🤖 BOT BAŞLADI...");
await sendTelegram("🤖 BOT AKTİF ✅\nSistem çalışıyor...");

// ================= AYARLAR =================
const POLL_INTERVAL = 60 * 1000; // 60 saniye
const MIN_PRESSURE = 8; // düşürürsen daha çok sinyal gelir

// ================= ANA FONKSİYON =================
async function scanMatches() {
  try {
    console.log("🔍 Tarama başladı...");

    const res = await fetch("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: {
        "x-apisports-key": API_KEY
      }
    });

    const data = await res.json();

    if (!data.response) {
      console.log("⚠️ Veri yok");
      return;
    }

    let sinyal = 0;

    for (const match of data.response.slice(0, 20)) {
      const statsRes = await fetch(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${match.fixture.id}`, {
        headers: {
          "x-apisports-key": API_KEY
        }
      });

      const statsData = await statsRes.json();

      if (!statsData.response || statsData.response.length === 0) continue;

      const homeStats = statsData.response[0].statistics;
      const awayStats = statsData.response[1].statistics;

      const getStat = (arr, name) =>
        parseInt(arr.find(s => s.type === name)?.value || 0);

      const shotsOn = getStat(homeStats, "Shots on Goal") + getStat(awayStats, "Shots on Goal");
      const dangerous = getStat(homeStats, "Dangerous Attacks") + getStat(awayStats, "Dangerous Attacks");
      const corners = getStat(homeStats, "Corner Kicks") + getStat(awayStats, "Corner Kicks");

      const pressure = shotsOn * 2 + dangerous * 0.1 + corners * 0.5;

      const minute = match.fixture.status.elapsed;

      if (minute < 30) continue; // erken çöpleri kes
      if (pressure < MIN_PRESSURE) continue;

      sinyal++;

      const home = match.teams.home.name;
      const away = match.teams.away.name;
      const score = `${match.goals.home}-${match.goals.away}`;

      const msg = `
🔥 <b>ELITE GİR</b>

⚽ ${home} - ${away}
⏱ Dakika: ${minute}
📊 Skor: ${score}

💥 Baskı: ${pressure.toFixed(1)}
🎯 Market: 2.5 ÜST
💸 Oran: 1.70 - 1.90

⚠️ Küçük stake ile gir
`;

      await sendTelegram(msg);
    }

    console.log("📊 Sinyal:", sinyal);

  } catch (err) {
    console.log("❌ HATA:", err.message);
  }
}

// ================= LOOP =================
setInterval(scanMatches, POLL_INTERVAL);