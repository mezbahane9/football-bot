const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 25);

const MIN_RADAR = Number(process.env.MIN_RADAR || 6.5);
const MIN_NORMAL = Number(process.env.MIN_NORMAL || 8.5);
const MIN_ELITE = Number(process.env.MIN_ELITE || 10.5);

const sent = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  } catch (e) {
    console.log("Telegram hata:", e.message);
  }
}

async function apiGet(url) {
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_KEY }
    });

    if (res.status === 429) {
      console.log("⏳ Rate limit yedik, 60 sn bekliyorum...");
      await sleep(60000);
      return null;
    }

    if (!res.ok) {
      console.log("API HTTP hata:", res.status);
      return null;
    }

    return await res.json();
  } catch (e) {
    console.log("API fetch hata:", e.message);
    return null;
  }
}

async function getLiveMatches() {
  const data = await apiGet("https://v3.football.api-sports.io/fixtures?live=all");
  return data?.response || [];
}

async function getStats(fixtureId) {
  const data = await apiGet(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`);
  return data?.response || [];
}

function getValue(arr, name) {
  const raw = arr.find(x => x.type === name)?.value;
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "string" && raw.includes("%")) return Number(raw.replace("%", "")) || 0;
  return Number(raw) || 0;
}

function extractTeamStats(team) {
  const s = team?.statistics || [];
  return {
    shots: getValue(s, "Total Shots"),
    shotsOn: getValue(s, "Shots on Goal"),
    shotsOff: getValue(s, "Shots off Goal"),
    corners: getValue(s, "Corner Kicks"),
    dangerous: getValue(s, "Dangerous Attacks")
  };
}

function combine(a, b) {
  return {
    shots: a.shots + b.shots,
    shotsOn: a.shotsOn + b.shotsOn,
    shotsOff: a.shotsOff + b.shotsOff,
    corners: a.corners + b.corners,
    dangerous: a.dangerous + b.dangerous
  };
}

function pressureScore(t, minute, totalGoals) {
  let score = 0;

  score += t.shots * 0.25;
  score += t.shotsOn * 1.25;
  score += t.shotsOff * 0.25;
  score += t.corners * 0.65;
  score += t.dangerous * 0.055;

  if (minute >= 30 && minute <= 42 && totalGoals === 0) score += 1.2;
  if (minute >= 55 && minute <= 72) score += 1.4;

  if (t.shotsOn >= 3) score += 1.0;
  if (t.corners >= 4) score += 0.7;
  if (t.dangerous >= 35) score += 0.8;

  return Number(score.toFixed(1));
}

function side(home, away) {
  const h = pressureScore(home, 60, 1);
  const a = pressureScore(away, 60, 1);

  if (h >= a + 2.5) return "Ev";
  if (a >= h + 2.5) return "Deplasman";
  return "Dengeli";
}

function badLeague(name = "") {
  const bad = ["U19", "U20", "U21", "U23", "Youth", "Reserve", "Women", "Friendly", "Amateur", "Regional"];
  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function selectMarket(minute, goals) {
  if (minute >= 25 && minute <= 42 && goals === 0) {
    return "İlk Yarı 0.5 ÜST";
  }

  if (minute >= 50 && minute <= 75) {
    if (goals <= 1) return "Maç Sonu 1.5 ÜST";
    if (goals === 2) return "Maç Sonu 2.5 ÜST";
    if (goals === 3 && minute <= 68) return "Maç Sonu 3.5 ÜST";
  }

  return null;
}

function dakikaFiltresi(minute, totalGoals, market) {
  if (minute < 25) return false;
  if (minute > 75) return false;

  if (minute >= 60 && totalGoals === 0 && market !== "İlk Yarı 0.5 ÜST") return false;
  if (minute >= 65 && totalGoals <= 1 && market !== "Maç Sonu 1.5 ÜST") return false;
  if (minute >= 70 && totalGoals <= 1) return false;

  return true;
}

function signalLevel(score) {
  if (score >= MIN_ELITE) return "💰🔥 ELITE GİR";
  if (score >= MIN_NORMAL) return "💰🟢 NORMAL GİR";
  if (score >= MIN_RADAR) return "⚠️ RADAR TAKİP";
  return null;
}

function shouldSend(key, minutes = 10) {
  const last = sent.get(key) || 0;
  if (Date.now() - last < minutes * 60 * 1000) return false;
  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 Tarama başladı...");

  const matches = await getLiveMatches();
  const filtered = matches
    .filter(m => {
      const minute = m.fixture.status.elapsed;
      const league = m.league.name || "";
      if (!minute) return false;
      if (minute < 25 || minute > 75) return false;
      if (badLeague(league)) return false;
      return true;
    })
    .slice(0, MAX_MATCH);

  console.log(`⚽ ${matches.length} canlı maç | İncelenecek: ${filtered.length}`);

  let checked = 0;
  let statsYok = 0;
  let radar = 0;
  let signal = 0;

  for (const m of filtered) {
    await sleep(1200);

    const minute = m.fixture.status.elapsed;
    const homeName = m.teams.home.name;
    const awayName = m.teams.away.name;
    const league = m.league.name;
    const country = m.league.country;
    const homeGoals = Number(m.goals.home || 0);
    const awayGoals = Number(m.goals.away || 0);
    const totalGoals = homeGoals + awayGoals;

    const market = selectMarket(minute, totalGoals);
    if (!market) continue;
    if (!dakikaFiltresi(minute, totalGoals, market)) continue;

    const stats = await getStats(m.fixture.id);

    if (!stats || stats.length < 2) {
      statsYok++;
      continue;
    }

    checked++;

    const homeStats = extractTeamStats(stats[0]);
    const awayStats = extractTeamStats(stats[1]);
    const totalStats = combine(homeStats, awayStats);

    const score = pressureScore(totalStats, minute, totalGoals);
    const yon = side(homeStats, awayStats);
    const level = signalLevel(score);

    if (!level) continue;

    const key = `${m.fixture.id}_${level.includes("RADAR") ? "radar" : "signal"}`;
    if (!shouldSend(key, level.includes("RADAR") ? 12 : 15)) continue;

    const msg = `
${level}

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Market:</b> ${market}
➡️ <b>Yön:</b> ${yon}

📈 <b>Baskı:</b> ${score}/10
📌 <b>Şut:</b> ${totalStats.shots}
🎯 <b>İsabet:</b> ${totalStats.shotsOn}
🚩 <b>Korner:</b> ${totalStats.corners}
⚡ <b>Tehlikeli Atak:</b> ${totalStats.dangerous}

${level.includes("RADAR") ? "👀 İzlemede kal. Net giriş değil." : "⚠️ Küçük stake ile değerlendir."}
`;

    await sendTelegram(msg);

    if (level.includes("RADAR")) radar++;
    else signal++;
  }

  console.log(`📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Radar:${radar} | Sinyal:${signal}`);
}

console.log("🤖 FINAL BOT AKTİF ✅ Para modu + radar + dakika filtresi çalışıyor.");
await sendTelegram("🤖 FINAL BOT AKTİF ✅\nPara modu + radar + dakika filtresi çalışıyor.");

await analyze();

setInterval(async () => {
  try {
    await analyze();
  } catch (e) {
    console.log("Ana hata:", e.message);
  }
}, POLL_INTERVAL);