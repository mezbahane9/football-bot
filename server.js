const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 20);
const STATS_DELAY = Number(process.env.STATS_DELAY || 1500);

const MIN_RADAR = Number(process.env.MIN_RADAR || 7.0);
const MIN_GIR = Number(process.env.MIN_GIR || 9.5);
const MIN_ELITE = Number(process.env.MIN_ELITE || 11.0);

const sent = new Map();
const memory = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML"
      })
    });
  } catch {}
}

async function apiGet(url) {
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_KEY }
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getLiveMatches() {
  const data = await apiGet("https://v3.football.api-sports.io/fixtures?live=all");
  return data?.response || [];
}

async function getStats(fixtureId) {
  const data = await apiGet(
    `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`
  );
  return data?.response || [];
}

function getValue(arr, name) {
  const raw = arr.find(x => x.type === name)?.value;
  if (!raw) return 0;
  if (typeof raw === "string" && raw.includes("%")) {
    return Number(raw.replace("%", "")) || 0;
  }
  return Number(raw) || 0;
}

function extractTeamStats(team) {
  const s = team?.statistics || [];

  return {
    shots: getValue(s, "Total Shots"),
    shotsOn: getValue(s, "Shots on Goal"),
    shotsOff: getValue(s, "Shots off Goal"),
    insideBox: getValue(s, "Shots insidebox"),
    corners: getValue(s, "Corner Kicks"),
    dangerous: getValue(s, "Dangerous Attacks"),
    possession: getValue(s, "Ball Possession"),
    xg: getValue(s, "Expected Goals") // 🔥 XG EKLENDİ
  };
}

function combine(a, b) {
  const out = {};
  for (const key of Object.keys(a)) out[key] = (a[key] || 0) + (b[key] || 0);
  return out;
}

function diff(now, old) {
  if (!old) return null;
  const out = {};
  for (const key of Object.keys(now)) {
    out[key] = Math.max(0, (now[key] || 0) - (old[key] || 0));
  }
  return out;
}

function momentumScore(delta) {
  if (!delta) return 0;

  return (
    delta.shots * 0.6 +
    delta.shotsOn * 1.6 +
    delta.corners * 1.2 +
    delta.insideBox * 0.8 +
    delta.dangerous * 0.12
  );
}

// 🔥 XG ZORUNLU DATA KONTROL
function dataCheck(total) {
  if (!total.xg || total.xg === 0) {
    return {
      ok: false,
      reason: "XG verisi API’den gelmiyor"
    };
  }

  return { ok: true };
}

// 🔥 KARAR SİSTEMİ (EN KRİTİK)
function shouldBet({
  score,
  need,
  xg,
  momentum
}) {
  if (!xg || xg < 0.8) return false;
  if (!momentum || momentum === 0) return false;
  if (score < MIN_ELITE) return false;
  if (need > 1) return false;

  return true;
}

async function analyze() {
  const matches = await getLiveMatches();

  for (const m of matches.slice(0, MAX_MATCH)) {
    await sleep(STATS_DELAY);

    const minute = m.fixture.status.elapsed;
    if (!minute || minute < 1 || minute > 90) continue;

    const home = m.teams.home.name;
    const away = m.teams.away.name;

    const homeGoals = m.goals.home || 0;
    const awayGoals = m.goals.away || 0;
    const totalGoals = homeGoals + awayGoals;

    const stats = await getStats(m.fixture.id);
    if (!stats || stats.length < 2) continue;

    const homeStats = extractTeamStats(stats[0]);
    const awayStats = extractTeamStats(stats[1]);
    const total = combine(homeStats, awayStats);

    // 🔥 DATA CHECK
    const check = dataCheck(total);
    if (!check.ok) continue;

    const old = memory.get(m.fixture.id);
    const delta = old ? diff(total, old.total) : null;
    memory.set(m.fixture.id, { total });

    const momentum = momentumScore(delta);

    const score = (
      total.shots * 0.25 +
      total.shotsOn * 1.3 +
      total.insideBox * 0.6 +
      total.corners * 0.7 +
      total.dangerous * 0.05
    );

    const need = Math.max(0, 2 - totalGoals);

    if (!shouldBet({
      score,
      need,
      xg: total.xg,
      momentum
    })) continue;

    const key = m.fixture.id + "_ELITE";
    if (sent.has(key)) continue;
    sent.set(key, true);

    const msg = `
🔥 <b>ELITE REAL SİNYAL</b>

⚽ ${home} - ${away}
⏱ Dakika: ${minute}
📊 Skor: ${homeGoals}-${awayGoals}

🎯 Market: Maç Sonu 1.5 ÜST

📈 Baskı Skoru: ${score.toFixed(1)}
🎯 XG: ${total.xg}
🧭 Momentum: ${momentum.toFixed(1)}

🧠 <b>Karar: GİR</b>
`;

    await sendTelegram(msg);
  }
}

setInterval(analyze, POLL_INTERVAL);
analyze();