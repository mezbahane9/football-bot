// ================= ENV =================
const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000); // 3 dk
const MAX_MATCH = Number(process.env.MAX_MATCH || 20); // aynı turda incelenecek maç

// ================= UTIL =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= DAKİKA FİLTRESİ =================
function dakikaFiltresi(match) {
  const dakika = match.minute;
  const toplamGol = (match.goals.home || 0) + (match.goals.away || 0);

  if (dakika >= 75) return false;
  if (dakika >= 70 && (3 - toplamGol) >= 2) return false; // 2 gol lazım → kes
  if (dakika >= 65 && toplamGol <= 1) return false;       // 0-0 / 1-0 → kes
  if (dakika >= 60 && toplamGol === 0) return false;      // 0-0 → kes

  return true;
}

// ================= BASKI HESABI =================
function calculatePressure({ shotsOnGoal = 0, dangerous = 0, corners = 0 }) {
  return (shotsOnGoal * 1.5) + (dangerous * 0.05) + (corners * 0.7);
}

// ================= GOL KOKUSU =================
function golKokusu({ shotsOnGoal = 0, dangerous = 0, corners = 0 }, minute) {
  // 50+ dk, şut + tehlikeli atak + korner yükselmişse
  if (minute >= 50 && shotsOnGoal >= 4 && dangerous >= 25 && corners >= 3) {
    return true;
  }
  return false;
}

// ================= TELEGRAM =================
async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.log("Telegram hata:", err.message);
  }
}

// ================= API CALLS =================
async function getLiveMatches() {
  try {
    const res = await fetch("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": API_KEY }
    });
    const data = await res.json();
    return data.response || [];
  } catch (err) {
    console.log("Live fetch hata:", err.message);
    return [];
  }
}

async function getStats(fixtureId) {
  try {
    const res = await fetch(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`, {
      headers: { "x-apisports-key": API_KEY }
    });

    // rate-limit koruma
    if (res.status === 429) {
      console.log("⛔ Rate limit, bekleniyor...");
      await sleep(2000);
      return null;
    }

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

  for (let match of matches.slice(0, MAX_MATCH)) {
    const minute = match.fixture.status.elapsed;
    const goals = match.goals;

    const statsData = await getStats(match.fixture.id);
    if (!statsData) continue;

    const homeStatsArr = statsData[0]?.statistics || [];

    const stats = {};
    homeStatsArr.forEach(s => {
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

    // ❌ Minimum baskı (para modu)
    if (pressure < 9) continue;

    // ================= GOL KOKUSU =================
    if (golKokusu({
      shotsOnGoal: stats["Shots on Goal"],
      dangerous: stats["Dangerous Attacks"],
      corners: stats["Corner Kicks"]
    }, minute)) {

      const msg = `
🚨 <b>GOL KOKUSU</b>

⚽ ${match.teams.home.name} - ${match.teams.away.name}
⏱ Dakika: ${minute}
📊 Skor: ${goals.home} - ${goals.away}

🔥 Baskı artıyor
📈 Şut & atak yükselişte

🎯 Market: GOL GELİR (1.5 / 2.5)
⚠️ Hızlı gir fırsat
`;

      await sendTelegram(msg);
    }

    // ================= NORMAL ELITE =================
    sinyal++;

    const mesaj = `
🔥 <b>ELITE GİR</b>

⚽ ${match.teams.home.name} - ${match.teams.away.name}
⏱ Dakika: ${minute}
📊 Skor: ${goals.home} - ${goals.away}

📈 Baskı: ${pressure.toFixed(1)}

🎯 Market: 2.5 ÜST
💰 Küçük stake ile gir
`;

    await sendTelegram(mesaj);

    // küçük gecikme → API limit yememek için
    await sleep(1200);
  }

  console.log(`📊 Sinyal: ${sinyal}`);
}

// ================= LOOP =================
console.log("🤖 BOT + PARA MODU + DAKİKA + GOL KOKUSU AKTİF");

setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.log("Ana hata:", err.message);
  }
}, POLL_INTERVAL);