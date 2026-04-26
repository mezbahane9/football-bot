// ================= ENV =================
const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000); // 3 dk

// ================= DAKİKA FİLTRESİ =================
function dakikaFiltresi(match) {
  const dakika = match.minute;
  const ev = match.goals.home;
  const dep = match.goals.away;
  const toplamGol = ev + dep;

  if (dakika >= 75) return false;
  if (dakika >= 70 && (3 - toplamGol) >= 2) return false;
  if (dakika >= 65 && toplamGol <= 1) return false;
  if (dakika >= 60 && toplamGol === 0) return false;

  return true;
}

// ================= BASKI =================
function calculatePressure(stats) {
  const shots = stats.shotsOnGoal || 0;
  const dangerous = stats.dangerous || 0;
  const corners = stats.corners || 0;

  return (shots * 1.5) + (dangerous * 0.05) + (corners * 0.7);
}

// ================= TELEGRAM =================
async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.log("Telegram hata:", err.message);
  }
}

// ================= LIVE MATCH =================
async function getLiveMatches() {
  try {
    const res = await fetch("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: {
        "x-apisports-key": API_KEY
      }
    });

    const data = await res.json();
    return data.response || [];
  } catch (err) {
    console.log("Live fetch hata:", err.message);
    return [];
  }
}

// ================= STATS =================
async function getStats(fixtureId) {
  try {
    const res = await fetch(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`, {
      headers: {
        "x-apisports-key": API_KEY
      }
    });

    const data = await res.json();

    if (!data.response || data.response.length === 0) return null;

    return data.response;
  } catch (err) {
    console.log("Stats hata:", err.message);
    return null;
  }
}

// ================= ANALİZ =================
async function analyze() {
  console.log("🔎 Tarama başladı...");

  const matches = await getLiveMatches();
  let sinyal = 0;

  for (let match of matches.slice(0, 20)) {
    const minute = match.fixture.status.elapsed;
    const goals = match.goals;

    const statsData = await getStats(match.fixture.id);
    if (!statsData) continue;

    const homeStats = statsData[0]?.statistics || [];

    const stats = {};
    homeStats.forEach(s => {
      stats[s.type] = Number(s.value) || 0;
    });

    const pressure = calculatePressure({
      shotsOnGoal: stats["Shots on Goal"],
      dangerous: stats["Dangerous Attacks"],
      corners: stats["Corner Kicks"]
    });

    const matchObj = {
      minute,
      goals,
      pressure
    };

    // ❌ Dakika filtresi
    if (!dakikaFiltresi(matchObj)) continue;

    // ❌ Minimum baskı
    if (pressure < 9) continue;

    // ✔ Sinyal bulundu
    sinyal++;

    const mesaj = `
🔥 ELITE GİR

⚽ ${match.teams.home.name} - ${match.teams.away.name}
⏱ Dakika: ${minute}
📊 Skor: ${goals.home} - ${goals.away}

📈 Baskı: ${pressure.toFixed(1)}

🎯 Market: 2.5 ÜST
💰 Küçük stake ile gir
`;

    await sendTelegram(mesaj);
  }

  console.log(`📊 Sinyal: ${sinyal}`);
}

// ================= LOOP =================
console.log("🤖 BOT + PARA MODU + DAKİKA FİLTRESİ AKTİF");

setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.log("Ana hata:", err.message);
  }
}, POLL_INTERVAL);