// MEZBAHANE BOT - DEBUG + NORMAL + ELITE SİNYAL SİSTEMİ

const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

// ENV
const API_KEY = process.env.API_KEY || process.env.API_FOOTBALL_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 4);
const MIN_PRESSURE = Number(process.env.MIN_PRESSURE || 10);
const MIN_MOMENTUM = Number(process.env.MIN_MOMENTUM || 1);
const MIN_SHOT = Number(process.env.MIN_SHOT || 0);
const MIN_DANGER_ATTACK = Number(process.env.MIN_DANGER_ATTACK || 3);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 180000);

let sentSignals = new Set();

app.get("/", (req, res) => {
  res.send("Mezbahane Bot Aktif ✅");
});

async function sendTelegramMessage(text) {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log("❌ Telegram ENV eksik:", {
        TELEGRAM_TOKEN: !!TELEGRAM_TOKEN,
        TELEGRAM_CHAT_ID: !!TELEGRAM_CHAT_ID,
      });
      return;
    }

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }
    );

    console.log("✅ Telegram mesaj gönderildi");
  } catch (err) {
    console.log("❌ Telegram gönderim hatası:", err.response?.data || err.message);
  }
}

function getStat(stats, names) {
  if (!Array.isArray(stats)) return 0;

  for (const item of stats) {
    const type = String(item.type || "").toLowerCase();

    for (const name of names) {
      if (type.includes(name.toLowerCase())) {
        let value = item.value;

        if (typeof value === "string") {
          value = value.replace("%", "");
        }

        return Number(value) || 0;
      }
    }
  }

  return 0;
}

function calculateScores(homeStats, awayStats, minute) {
  const homeShotsOn = getStat(homeStats, ["shots on goal", "shots on target"]);
  const awayShotsOn = getStat(awayStats, ["shots on goal", "shots on target"]);

  const homeShotsOff = getStat(homeStats, ["shots off goal", "shots off target"]);
  const awayShotsOff = getStat(awayStats, ["shots off goal", "shots off target"]);

  const homeCorners = getStat(homeStats, ["corner kicks"]);
  const awayCorners = getStat(awayStats, ["corner kicks"]);

  const homeDanger = getStat(homeStats, ["dangerous attacks"]);
  const awayDanger = getStat(awayStats, ["dangerous attacks"]);

  const totalShotsOn = homeShotsOn + awayShotsOn;
  const totalShotsOff = homeShotsOff + awayShotsOff;
  const totalCorners = homeCorners + awayCorners;
  const totalDanger = homeDanger + awayDanger;

  const pressure =
    totalShotsOn * 4 +
    totalShotsOff * 1.5 +
    totalCorners * 2 +
    Math.floor(totalDanger / 5);

  const momentum =
    totalShotsOn * 2 +
    totalCorners +
    Math.floor(totalDanger / 10);

  let confidence = 0;

  if (totalShotsOn >= 1) confidence += 2;
  if (totalShotsOn >= 2) confidence += 2;
  if (totalShotsOff >= 3) confidence += 1;
  if (totalCorners >= 3) confidence += 1;
  if (totalDanger >= 20) confidence += 1;
  if (totalDanger >= 35) confidence += 1;
  if (minute >= 15 && minute <= 80) confidence += 1;

  const trueXG =
    totalShotsOn * 0.32 +
    totalShotsOff * 0.08 +
    totalCorners * 0.06 +
    totalDanger * 0.015;

  return {
    totalShotsOn,
    totalShotsOff,
    totalCorners,
    totalDanger,
    pressure: Math.round(pressure),
    momentum: Math.round(momentum),
    confidence: Math.min(10, Math.round(confidence)),
    trueXG: Number(trueXG.toFixed(2)),
  };
}

function isNormalSignal(score) {
  return (
    score.confidence >= MIN_CONFIDENCE &&
    score.pressure >= MIN_PRESSURE &&
    score.momentum >= MIN_MOMENTUM &&
    score.totalShotsOn >= MIN_SHOT &&
    score.totalDanger >= MIN_DANGER_ATTACK
  );
}

function isEliteSignal(score) {
  return (
    score.confidence >= 7 &&
    score.pressure >= 17 &&
    score.momentum >= 4 &&
    score.totalShotsOn >= 2 &&
    score.totalDanger >= 18 &&
    score.trueXG >= 0.85
  );
}

async function getLiveFixtures() {
  const url = "https://v3.football.api-sports.io/fixtures?live=all";

  const response = await axios.get(url, {
    headers: {
      "x-apisports-key": API_KEY,
    },
  });

  return response.data.response || [];
}

async function getFixtureStats(fixtureId) {
  const url = `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`;

  const response = await axios.get(url, {
    headers: {
      "x-apisports-key": API_KEY,
    },
  });

  return response.data.response || [];
}

async function scanMatches() {
  try {
    console.log("🔎 YÜKSEK GÜVEN GOL HER AN taraması başladı...");

    if (!API_KEY) {
      console.log("❌ API_KEY eksik");
      return;
    }

    const fixtures = await getLiveFixtures();

    console.log(`⚽ ${fixtures.length} canlı maç bulundu`);

    let checked = 0;
    let statsYok = 0;
    let sent = 0;
    let passed = 0;

    for (const match of fixtures) {
      try {
        const fixtureId = match.fixture?.id;
        const home = match.teams?.home?.name || "Ev Sahibi";
        const away = match.teams?.away?.name || "Deplasman";
        const league = match.league?.name || "Lig";
        const country = match.league?.country || "";
        const minute = match.fixture?.status?.elapsed || 0;
        const goalsHome = match.goals?.home ?? 0;
        const goalsAway = match.goals?.away ?? 0;

        if (!fixtureId || minute < 8 || minute > 85) {
          passed++;
          continue;
        }

        checked++;

        const stats = await getFixtureStats(fixtureId);

        if (!Array.isArray(stats) || stats.length < 2) {
          statsYok++;
          console.log(`⚠️ Stats yok: ${home} - ${away}`);
          continue;
        }

        const homeStats = stats[0]?.statistics || [];
        const awayStats = stats[1]?.statistics || [];

        const score = calculateScores(homeStats, awayStats, minute);

        const signalKey = `${fixtureId}-${goalsHome}-${goalsAway}`;

        const normalSignal = isNormalSignal(score);
        const eliteSignal = isEliteSignal(score);

        if ((normalSignal || eliteSignal) && !sentSignals.has(signalKey)) {
          const signalType = eliteSignal ? "🔥 ELITE GOL HER AN" : "✅ NORMAL GOL BEKLENTİSİ";

          const message = `
${signalType}

⚽ <b>${home} - ${away}</b>
🏆 ${country} / ${league}
⏱ Dakika: ${minute}
📊 Skor: ${goalsHome}-${goalsAway}

🎯 İsabetli Şut: ${score.totalShotsOn}
🥅 Toplam Şut: ${score.totalShotsOn + score.totalShotsOff}
🚩 Korner: ${score.totalCorners}
⚡ Tehlikeli Atak: ${score.totalDanger}

🔥 Pressure: ${score.pressure}
📈 Momentum: ${score.momentum}
🧠 Confidence: ${score.confidence}/10
📌 True XG: ${score.trueXG}

📣 Sinyal: Gol her an gelebilir.
          `.trim();

          await sendTelegramMessage(message);

          sentSignals.add(signalKey);
          sent++;
        } else {
          passed++;

          console.log("PAS NEDENİ:", {
            mac: `${home} - ${away}`,
            dakika: minute,
            skor: `${goalsHome}-${goalsAway}`,
            confidence: score.confidence,
            pressure: score.pressure,
            momentum: score.momentum,
            shotsOn: score.totalShotsOn,
            dangerousAttacks: score.totalDanger,
            trueXG: score.trueXG,
            gerekli: {
              MIN_CONFIDENCE,
              MIN_PRESSURE,
              MIN_MOMENTUM,
              MIN_SHOT,
              MIN_DANGER_ATTACK,
            },
          });
        }
      } catch (innerErr) {
        console.log("⚠️ Maç işleme hatası:", innerErr.response?.data || innerErr.message);
      }
    }

    console.log(
      `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Gönderildi:${sent} | Pas:${passed}`
    );
  } catch (err) {
    console.log("❌ Genel tarama hatası:", err.response?.data || err.message);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Server ${PORT} portunda çalışıyor`);

  await sendTelegramMessage(
    "🤖 YÜKSEK GÜVEN GOL HER AN BOT AKTİF ✅\nTüm canlı maçlar taranıyor."
  );

  scanMatches();

  setInterval(scanMatches, POLL_INTERVAL_MS);
});