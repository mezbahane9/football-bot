const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 20);
const STATS_DELAY = Number(process.env.STATS_DELAY || 1500);

const MIN_ELITE = Number(process.env.MIN_ELITE || 11.0);

const sent = new Map();
const memory = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      console.log("⏳ Rate limit. 90 saniye bekleniyor...");
      await sleep(90000);
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
    blocked: getValue(s, "Blocked Shots"),
    insideBox: getValue(s, "Shots insidebox"),
    outsideBox: getValue(s, "Shots outsidebox"),
    corners: getValue(s, "Corner Kicks"),
    dangerous: getValue(s, "Dangerous Attacks"),
    possession: getValue(s, "Ball Possession"),
    yellow: getValue(s, "Yellow Cards"),
    red: getValue(s, "Red Cards"),
    xg: getValue(s, "Expected Goals")
  };
}

function combine(a, b) {
  const out = {};

  for (const key of Object.keys(a)) {
    out[key] = (a[key] || 0) + (b[key] || 0);
  }

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

function badLeague(name = "") {
  const bad = [
    "U19",
    "U20",
    "U21",
    "U23",
    "Youth",
    "Reserve",
    "Reserves",
    "Women",
    "Friendly",
    "Club Friendlies",
    "Amateur",
    "Regional"
  ];

  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function momentumScore(delta) {
  if (!delta) return 0;

  const score =
    delta.shots * 0.6 +
    delta.shotsOn * 1.6 +
    delta.corners * 1.2 +
    delta.insideBox * 0.8 +
    delta.dangerous * 0.12 +
    delta.xg * 3.5;

  return Number(score.toFixed(1));
}

function momentumLabel(score) {
  if (score >= 5) return "🔥 Çok güçlü";
  if (score >= 3) return "🟢 Güçlü";
  if (score >= 1.5) return "🟡 Orta";
  if (score > 0) return "🔴 Zayıf";
  return "İlk ölçüm / veri artışı yok";
}

function teamPressure(t, minute) {
  let score = 0;

  score += t.shots * 0.25;
  score += t.shotsOn * 1.25;
  score += t.insideBox * 0.55;
  score += t.corners * 0.65;
  score += t.dangerous * 0.04;
  score += t.xg * 3.0;

  if (minute >= 55 && minute <= 80) score += 0.6;
  if (t.red > 0) score -= 1.5;

  return Number(score.toFixed(1));
}

function totalPressure(total, minute) {
  let score = 0;

  score += total.shots * 0.25;
  score += total.shotsOn * 1.3;
  score += total.insideBox * 0.6;
  score += total.corners * 0.7;
  score += total.dangerous * 0.05;
  score += total.xg * 3.2;

  if (minute >= 55 && minute <= 80) score += 0.8;

  return Number(score.toFixed(1));
}

function leadingSide(homePressure, awayPressure) {
  if (homePressure >= awayPressure + 2.5) return "Ev";
  if (awayPressure >= homePressure + 2.5) return "Deplasman";
  return "Dengeli";
}

function dataCheck(total) {
  if (!total.xg || total.xg <= 0) {
    return {
      ok: false,
      reason: "XG verisi API’den gelmiyor"
    };
  }

  return {
    ok: true,
    reason: "XG API’den geliyor"
  };
}

function chooseMarket(minute, totalGoals, side) {
  if (minute <= 45) {
    if (totalGoals === 0) return "İlk Yarı 0.5 ÜST";
    if (totalGoals === 1) return "İlk Yarı 1.5 ÜST";
  }

  if (minute >= 46) {
    if (totalGoals <= 1) return "Maç Sonu 1.5 ÜST";
    if (totalGoals === 2) return "Maç Sonu 2.5 ÜST";
    if (side === "Ev") return "Sıradaki Gol Ev";
    if (side === "Deplasman") return "Sıradaki Gol Deplasman";
  }

  return null;
}

function neededGoal(market, homeGoals, awayGoals) {
  const total = homeGoals + awayGoals;

  if (market === "İlk Yarı 0.5 ÜST") return Math.max(0, 1 - total);
  if (market === "İlk Yarı 1.5 ÜST") return Math.max(0, 2 - total);
  if (market === "Maç Sonu 1.5 ÜST") return Math.max(0, 2 - total);
  if (market === "Maç Sonu 2.5 ÜST") return Math.max(0, 3 - total);
  if (market === "Sıradaki Gol Ev") return 1;
  if (market === "Sıradaki Gol Deplasman") return 1;

  return 99;
}

function shouldSignal({
  totalPress,
  totalXg,
  momentum,
  need,
  minute
}) {
  if (!totalXg || totalXg < 0.8) return false;
  if (!momentum || momentum <= 0) return false;
  if (totalPress < MIN_ELITE) return false;
  if (need > 1) return false;
  if (minute > 85) return false;

  return true;
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
  console.log("🔎 REAL XG taraması başladı...");

  const matches = await getLiveMatches();

  const filtered = matches
    .filter(m => {
      const minute = m.fixture.status.elapsed;
      const league = m.league.name || "";

      if (!minute) return false;
      if (minute < 1 || minute > 90) return false;
      if (badLeague(league)) return false;

      return true;
    })
    .slice(0, MAX_MATCH);

  console.log(`⚽ ${matches.length} canlı maç | İncelenecek: ${filtered.length}`);

  let checked = 0;
  let statsYok = 0;
  let xgYok = 0;
  let sentCount = 0;
  let pas = 0;

  for (const m of filtered) {
    await sleep(STATS_DELAY);

    const fixtureId = m.fixture.id;
    const minute = m.fixture.status.elapsed;

    const homeName = m.teams.home.name;
    const awayName = m.teams.away.name;

    const league = m.league.name;
    const country = m.league.country;

    const homeGoals = Number(m.goals.home || 0);
    const awayGoals = Number(m.goals.away || 0);
    const totalGoals = homeGoals + awayGoals;

    const stats = await getStats(fixtureId);

    if (!stats || stats.length < 2) {
      statsYok++;
      continue;
    }

    checked++;

    const homeStats = extractTeamStats(stats[0]);
    const awayStats = extractTeamStats(stats[1]);
    const totalStats = combine(homeStats, awayStats);

    const check = dataCheck(totalStats);

    if (!check.ok) {
      xgYok++;
      continue;
    }

    const old = memory.get(fixtureId);
    const delta = old ? diff(totalStats, old.totalStats) : null;

    memory.set(fixtureId, {
      totalStats,
      minute
    });

    const momScore = momentumScore(delta);

    const homePress = teamPressure(homeStats, minute);
    const awayPress = teamPressure(awayStats, minute);
    const totalPress = totalPressure(totalStats, minute);
    const side = leadingSide(homePress, awayPress);

    const market = chooseMarket(minute, totalGoals, side);

    if (!market) {
      pas++;
      continue;
    }

    const need = neededGoal(market, homeGoals, awayGoals);

    const signalOk = shouldSignal({
      totalPress,
      totalXg: totalStats.xg,
      momentum: momScore,
      need,
      minute
    });

    if (!signalOk) {
      pas++;
      continue;
    }

    const key = `${fixtureId}_${market}_REAL_XG`;

    if (!shouldSend(key, 15)) {
      continue;
    }

    const msg = `
🔥 <b>ELITE REAL XG SİNYAL</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Önerilen Market:</b> ${market}
🥅 <b>Gereken Gol:</b> ${need}
➡️ <b>Baskı Yönü:</b> ${side}

<b>REAL DATA OKUMASI</b>
🏠 Ev Baskı: ${homePress}/10
✈️ Dep Baskı: ${awayPress}/10
📈 Toplam Baskı: ${totalPress}/10
🎯 XG: ${totalStats.xg}
🧭 Momentum: ${momentumLabel(momScore)} (${momScore})
🛡 Veri Durumu: ${check.reason}

<b>EV SAHİBİ İSTATİSTİK</b>
📍 Şut: ${homeStats.shots}
🎯 İsabet: ${homeStats.shotsOn}
📤 İsabetsiz: ${homeStats.shotsOff}
📦 Ceza İçi Şut: ${homeStats.insideBox}
🚩 Korner: ${homeStats.corners}
⚡ Tehlikeli Atak: ${homeStats.dangerous}
🎯 XG: ${homeStats.xg}
🟨 Sarı: ${homeStats.yellow}
🟥 Kırmızı: ${homeStats.red}
⚽ Topa Sahip Olma: ${homeStats.possession}%

<b>DEPLASMAN İSTATİSTİK</b>
📍 Şut: ${awayStats.shots}
🎯 İsabet: ${awayStats.shotsOn}
📤 İsabetsiz: ${awayStats.shotsOff}
📦 Ceza İçi Şut: ${awayStats.insideBox}
🚩 Korner: ${awayStats.corners}
⚡ Tehlikeli Atak: ${awayStats.dangerous}
🎯 XG: ${awayStats.xg}
🟨 Sarı: ${awayStats.yellow}
🟥 Kırmızı: ${awayStats.red}
⚽ Topa Sahip Olma: ${awayStats.possession}%

<b>SON TUR MOMENTUM</b>
📍 Şut Artışı: ${delta ? delta.shots : "İlk ölçüm"}
🎯 İsabet Artışı: ${delta ? delta.shotsOn : "İlk ölçüm"}
🚩 Korner Artışı: ${delta ? delta.corners : "İlk ölçüm"}
📦 Ceza İçi Şut Artışı: ${delta ? delta.insideBox : "İlk ölçüm"}
🎯 XG Artışı: ${delta ? delta.xg : "İlk ölçüm"}

🧠 <b>NET KARAR:</b> ✅ GİRİLEBİLİR
⚠️ <b>Risk:</b> Orta
💰 <b>Stake:</b> %1 - %2 kasa

📝 <b>Bot Yorumu:</b>
XG API’den geliyor. Momentum artışı var. Baskı skoru elite seviyede. Fake/uydurma veri kullanılmadı.

⚠️ <b>Not:</b> Garanti değildir. Tek maça yüksek kasa riski alma.
`;

    await sendTelegram(msg);
    sentCount++;
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | XGYok:${xgYok} | Gönderildi:${sentCount} | Pas:${pas}`
  );
}

async function startBot() {
  console.log("🤖 MEZBAHANE REAL XG BOT BAŞLADI");

  await sendTelegram(
    "🤖 <b>MEZBAHANE REAL XG BOT AKTİF ✅</b>\nXG + Momentum filtreli gerçek veri sistemi çalışıyor."
  );

  await analyze();

  setInterval(async () => {
    try {
      await analyze();
    } catch (err) {
      console.log("Ana hata:", err.message);
    }
  }, POLL_INTERVAL);
}

startBot();