const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 25);

const MIN_ELITE = Number(process.env.MIN_ELITE || 11.5);
const DEFAULT_ODDS = Number(process.env.DEFAULT_ODDS || 1.80);

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
  } catch (err) {
    console.log("Telegram hata:", err.message);
  }
}

async function apiGet(url) {
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_KEY }
    });

    if (res.status === 429) {
      console.log("⏳ Rate limit yedik, 60 sn bekleniyor...");
      await sleep(60000);
      return null;
    }

    if (!res.ok) {
      console.log("API HTTP hata:", res.status);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.log("API hata:", err.message);
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
  if (raw === null || raw === undefined) return 0;
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

function badLeague(name = "") {
  const bad = [
    "U19", "U20", "U21", "U23",
    "Youth", "Reserve", "Reserves",
    "Women", "Friendly", "Club Friendlies",
    "Amateur", "Regional"
  ];

  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function pressureScore(stats, minute, totalGoals) {
  let score = 0;

  score += stats.shots * 0.25;
  score += stats.shotsOn * 1.35;
  score += stats.shotsOff * 0.25;
  score += stats.corners * 0.75;
  score += stats.dangerous * 0.06;

  if (minute >= 30 && minute <= 42 && totalGoals === 0) score += 1.4;
  if (minute >= 55 && minute <= 70) score += 1.5;

  if (stats.shots >= 10) score += 0.8;
  if (stats.shotsOn >= 4) score += 1.2;
  if (stats.corners >= 4) score += 0.9;
  if (stats.dangerous >= 30) score += 0.9;

  return Number(score.toFixed(1));
}

function sidePressure(teamStats) {
  return (
    teamStats.shotsOn * 1.35 +
    teamStats.corners * 0.75 +
    teamStats.dangerous * 0.06 +
    teamStats.shots * 0.25
  );
}

function chooseSide(homeStats, awayStats) {
  const h = sidePressure(homeStats);
  const a = sidePressure(awayStats);

  if (h >= a + 3) return "Ev";
  if (a >= h + 3) return "Deplasman";
  return "Dengeli";
}

function selectMarket(minute, totalGoals) {
  if (minute >= 30 && minute <= 42 && totalGoals === 0) {
    return "İlk Yarı 0.5 ÜST";
  }

  if (minute >= 55 && minute <= 70 && totalGoals <= 1) {
    return "Maç Sonu 1.5 ÜST";
  }

  return null;
}

function strictAutoFilter({ minute, totalGoals, market, score, totalStats, side }) {
  if (!market) return { ok: false, reason: "Uygun market yok" };

  if (minute < 30) return { ok: false, reason: "Dakika erken" };
  if (minute > 70) return { ok: false, reason: "Dakika geç" };

  if (side === "Dengeli") {
    return { ok: false, reason: "Tek taraflı baskı yok" };
  }

  if (score < MIN_ELITE) {
    return { ok: false, reason: "Baskı skoru elite değil" };
  }

  if (totalStats.shots < 10) {
    return { ok: false, reason: "Toplam şut düşük" };
  }

  if (totalStats.shotsOn < 4) {
    return { ok: false, reason: "İsabetli şut düşük" };
  }

  if (totalStats.corners < 4) {
    return { ok: false, reason: "Korner baskısı düşük" };
  }

  if (totalStats.dangerous < 30) {
    return { ok: false, reason: "Tehlikeli atak düşük" };
  }

  if (minute >= 60 && totalGoals === 0) {
    return { ok: false, reason: "60+ dakika 0-0 riskli" };
  }

  if (DEFAULT_ODDS < 1.60 || DEFAULT_ODDS > 2.10) {
    return { ok: false, reason: "Oran aralığı uygun değil" };
  }

  return { ok: true, reason: "Tüm auto-gir şartları sağlandı" };
}

function shouldSend(key, minutes = 15) {
  const last = sent.get(key) || 0;

  if (Date.now() - last < minutes * 60 * 1000) {
    return false;
  }

  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 AUTO GİR taraması başladı...");

  const matches = await getLiveMatches();

  const filtered = matches
    .filter(m => {
      const minute = m.fixture.status.elapsed;
      const league = m.league.name || "";

      if (!minute) return false;
      if (minute < 30 || minute > 70) return false;
      if (badLeague(league)) return false;

      return true;
    })
    .slice(0, MAX_MATCH);

  console.log(`⚽ ${matches.length} canlı maç | İncelenecek: ${filtered.length}`);

  let checked = 0;
  let statsYok = 0;
  let autoGir = 0;
  let pas = 0;

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
    const side = chooseSide(homeStats, awayStats);

    const filter = strictAutoFilter({
      minute,
      totalGoals,
      market,
      score,
      totalStats,
      side
    });

    if (!filter.ok) {
      pas++;
      continue;
    }

    const key = `${m.fixture.id}_auto_gir`;
    if (!shouldSend(key, 15)) continue;

    autoGir++;

    const msg = `
🚀 <b>AUTO GİR</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Market:</b> ${market}
➡️ <b>Yön:</b> ${side}

📈 <b>Baskı:</b> ${score}/10
📌 <b>Şut:</b> ${totalStats.shots}
🎯 <b>İsabet:</b> ${totalStats.shotsOn}
🚩 <b>Korner:</b> ${totalStats.corners}
⚡ <b>Tehlikeli Atak:</b> ${totalStats.dangerous}

💰 <b>Stake:</b> %1 - %2 kasa
🧠 <b>Karar:</b> Direkt girilebilir seviyeye en yakın sinyal.
📝 <b>Neden:</b> ${filter.reason}
⚠️ <b>Not:</b> Garanti değildir. Tek maçta yüksek kasa riski alma.
`;

    await sendTelegram(msg);
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | AUTO_GİR:${autoGir} | Pas:${pas}`
  );
}

console.log("🤖 AUTO GİR BOT AKTİF ✅");
await sendTelegram("🤖 AUTO GİR BOT AKTİF ✅\nSadece en güçlü sinyaller gönderilecek.");

await analyze();

setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.log("Ana hata:", err.message);
  }
}, POLL_INTERVAL);