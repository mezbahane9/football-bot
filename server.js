import fetch from "node-fetch";

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = (process.env.POLL_INTERVAL || 120) * 1000;

const MAX_MATCHES = parseInt(process.env.MAX_MATCHES_PER_ROUND || "40");

const MIN_RADAR = parseFloat(process.env.MIN_RADAR || "4.0");
const MIN_NORMAL = parseFloat(process.env.MIN_NORMAL || "5.3");
const MIN_ELITE = parseFloat(process.env.MIN_ELITE || "7.0");
const MIN_VALUE = parseFloat(process.env.MIN_VALUE || "1.3");

console.log("💰 VIP PARA BOTU + RADAR AKTİF...");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms);

async function getLiveMatches() {
  try {
    const res = await fetch("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": API_KEY },
    });
    const data = await res.json();
    return data.response || [];
  } catch (e) {
    console.log("CANLI MAÇ HATASI:", e);
    return [];
  }
}

async function getStats(fixtureId) {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      { headers: { "x-apisports-key": API_KEY } }
    );
    const data = await res.json();
    return data.response || [];
  } catch {
    return null;
  }
}

function getStat(teamStats, type) {
  const stat = teamStats.find((s) => s.type === type);
  return stat ? parseInt(stat.value) || 0 : 0;
}

function calculateMomentum(home, away, minute) {
  const hShots = getStat(home, "Shots on Goal");
  const aShots = getStat(away, "Shots on Goal");

  const hDanger = getStat(home, "Dangerous Attacks");
  const aDanger = getStat(away, "Dangerous Attacks");

  let score =
    (hShots + aShots) * 0.7 +
    (hDanger + aDanger) * 0.05;

  if (minute > 60) score *= 1.2;
  if (minute > 75) score *= 1.4;

  return score;
}

async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.log("Telegram hata:", e);
  }
}

async function main() {
  while (true) {
    try {
      const matches = await getLiveMatches();

      console.log(`API TEST: ${matches.length} canlı maç`);

      let statsChecked = 0;
      let statsMissing = 0;
      let radar = 0;
      let signal = 0;

      for (let i = 0; i < matches.length; i++) {
        if (statsChecked >= MAX_MATCHES) break;

        const m = matches[i];

        const fixtureId = m.fixture.id;
        const minute = m.fixture.status.elapsed || 0;

        const stats = await getStats(fixtureId);

        // ❌ STAT YOKSA GEÇ
        if (!stats || stats.length < 2) {
          statsMissing++;
          continue;
        }

        statsChecked++;

        const home = stats[0].statistics;
        const away = stats[1].statistics;

        const momentum = calculateMomentum(home, away, minute);

        // 🔍 RADAR
        if (momentum >= MIN_RADAR) {
          radar++;

          if (momentum >= MIN_NORMAL) {
            let level = "⚡ NORMAL";

            if (momentum >= MIN_ELITE) {
              level = "🔥 ELITE";
            }

            signal++;

            const msg = `
${level} SİNYAL

${m.teams.home.name} vs ${m.teams.away.name}
Dakika: ${minute}
Momentum: ${momentum.toFixed(2)}
            `;

            await sendTelegram(msg);
            console.log("SİNYAL GÖNDERİLDİ");
          }
        }

        // ⚠️ RATE LIMIT KORUMA
        await sleep(1200);
      }

      console.log(
        `ÖZET → StatsBakıldı:${statsChecked} | StatsYok:${statsMissing} | Radar:${radar} | Sinyal:${signal}`
      );
    } catch (e) {
      console.log("GENEL HATA:", e);
    }

    await sleep(POLL_INTERVAL);
  }
}

main();