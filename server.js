import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

// ENV
const API_KEY = process.env.API_FOOTBALL_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_MS || 120000);
const RESULT_INTERVAL = Number(process.env.RESULT_CHECK_INTERVAL_MS || 180000);

// Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Sayaçlar
let stats = {
  win: 0,
  lose: 0,
  total: 0
};

// Sinyaller (hafızada tutulur)
let signals = []; 
/*
signal objesi:
{
  id, fixtureId, home, away,
  market, line, minute, status: "pending|win|lose",
  createdAt
}
*/

// === API helper ===
const api = axios.create({
  baseURL: "https://v3.football.api-sports.io",
  headers: { "x-apisports-key": API_KEY }
});

// === ÖRNEK SİNYAL FONKSİYONU (senin botuna bağla) ===
async function sendSignal({ fixtureId, home, away, minute, market, line }) {
  const text = `
🔥 ELITE GİR

Maç: ${home} - ${away}
Dakika: ${minute}
Market: ${market} ${line}

⏳ Takip ediliyor...
`;

  await bot.sendMessage(CHAT_ID, text);

  // Kaydet
  signals.push({
    id: Date.now(),
    fixtureId,
    home,
    away,
    market,   // örn: "OVER"
    line,     // örn: 2.5
    minute,
    status: "pending",
    createdAt: Date.now()
  });

  stats.total++;
}

// === MAÇ SONU KONTROL ===
async function checkResults() {
  for (let s of signals) {
    if (s.status !== "pending") continue;

    try {
      const res = await api.get(`/fixtures?id=${s.fixtureId}`);
      const fixture = res.data.response?.[0];

      if (!fixture) continue;

      const isFinished = ["FT", "AET", "PEN"].includes(fixture.fixture.status.short);
      if (!isFinished) continue;

      const homeGoals = fixture.goals.home;
      const awayGoals = fixture.goals.away;
      const totalGoals = homeGoals + awayGoals;

      let result = "lose";

      // Şu an sadece OVER sistemi örnek
      if (s.market === "OVER") {
        if (totalGoals > s.line) result = "win";
      }

      s.status = result;

      if (result === "win") stats.win++;
      else stats.lose++;

      await bot.sendMessage(CHAT_ID, `
📊 SONUÇ

Maç: ${s.home} - ${s.away}
Skor: ${homeGoals}-${awayGoals}

${result === "win" ? "✅ WIN" : "❌ LOSE"}

📈 Win: ${stats.win}
📉 Lose: ${stats.lose}
🎯 Winrate: %${((stats.win / stats.total) * 100).toFixed(1)}
      `);

    } catch (err) {
      console.log("Result check error:", err.message);
    }
  }
}

// === DEMO: CANLI MAÇLARDAN ÖRNEK SİNYAL (test için) ===
async function fetchLiveAndSendExample() {
  try {
    const res = await api.get("/fixtures?live=all");
    const list = res.data.response;

    if (!list || list.length === 0) return;

    // Basit: 60+ dakika ve 0-2 gibi maç bul
    const pick = list.find(f =>
      f.fixture.status.elapsed >= 60 &&
      (f.goals.home + f.goals.away) >= 2
    );

    if (!pick) return;

    await sendSignal({
      fixtureId: pick.fixture.id,
      home: pick.teams.home.name,
      away: pick.teams.away.name,
      minute: pick.fixture.status.elapsed,
      market: "OVER",
      line: 2.5
    });

  } catch (e) {
    console.log("Live fetch error:", e.message);
  }
}

// === LOOPLAR ===
setInterval(fetchLiveAndSendExample, POLL_INTERVAL);
setInterval(checkResults, RESULT_INTERVAL);

// Başlangıç
bot.sendMessage(CHAT_ID, "🤖 BOT + AUTO WIN TRACK aktif");
console.log("Bot çalışıyor...");