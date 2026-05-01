const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 20);
const STATS_DELAY = Number(process.env.STATS_DELAY || 1500);

const MIN_ELITE = Number(process.env.MIN_ELITE || 8.5);
const XG_SPIKE_MIN = Number(process.env.XG_SPIKE_MIN || 0.03);
const MIN_RADAR_PRESS = Number(process.env.MIN_RADAR_PRESS || 8.5);
const MIN_RADAR_MOMENTUM = Number(process.env.MIN_RADAR_MOMENTUM || 1.2);

const sent = new Map();
const memory = new Map();
const radarMemory = new Map();

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
    insideBox: getValue(s, "Shots insidebox"),
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
    "U19", "U20", "U21", "U23",
    "Youth", "Reserve", "Reserves",
    "Women", "Friendly", "Club Friendlies",
    "Amateur", "Regional"
  ];

  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function goodLeague(name = "") {
  const good = [
    "Premier League",
    "La Liga",
    "Bundesliga",
    "Serie A",
    "Ligue 1",

    "Champions League",
    "Europa League",
    "Conference League",

    "Eredivisie",
    "Primeira Liga",
    "Super Lig",
    "Süper Lig",
    "Jupiler Pro League",
    "Scottish Premiership",
    "MLS",
    "Brasileirão",
    "Brasileirao",
    "Liga Profesional",

    "Championship",
    "2. Bundesliga",
    "Serie B",
    "Ligue 2",
    "Segunda División",
    "Segunda Division",
    "Eerste Divisie",

    "1. Lig",
    "TFF 1. Lig"
  ];

  return good.some(x => name.toLowerCase().includes(x.toLowerCase()));
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

function xgSpike(delta) {
  if (!delta) return 0;
  return Number((delta.xg || 0).toFixed(2));
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

function chooseMarket(minute, totalGoals) {
  if (minute <= 45) {
    if (totalGoals === 0) return "İlk Yarı 0.5 ÜST";
    if (totalGoals === 1) return "İlk Yarı 1.5 ÜST";
  }

  if (minute >= 46) {
    if (totalGoals <= 1) return "Maç Sonu 1.5 ÜST";
    if (totalGoals === 2) return "Maç Sonu 2.5 ÜST";
  }

  return null;
}

function neededGoal(market, homeGoals, awayGoals) {
  const total = homeGoals + awayGoals;

  if (market === "İlk Yarı 0.5 ÜST") return Math.max(0, 1 - total);
  if (market === "İlk Yarı 1.5 ÜST") return Math.max(0, 2 - total);
  if (market === "Maç Sonu 1.5 ÜST") return Math.max(0, 2 - total);
  if (market === "Maç Sonu 2.5 ÜST") return Math.max(0, 3 - total);

  return 99;
}

function hasRealAttackIncrease(delta) {
  if (!delta) return false;

  return (
    delta.shots >= 1 ||
    delta.shotsOn >= 1 ||
    delta.insideBox >= 1 ||
    delta.corners >= 1 ||
    delta.dangerous >= 1 ||
    delta.xg >= XG_SPIKE_MIN
  );
}

function signalDecision({
  fixtureId,
  total,
  totalPress,
  momentum,
  spike,
  delta,
  need,
  minute
}) {
  if (!delta) {
    return { send: false, type: "NONE" };
  }

  if (need > 1 || minute > 85) {
    return { send: false, type: "NONE" };
  }

  const xgExists = total.xg > 0;
  const realAttack = hasRealAttackIncrease(delta);

  const radarTime = radarMemory.get(fixtureId);
  const wasRadarRecently =
    radarTime && Date.now() - radarTime <= 5 * 60 * 1000;

  const ultra =
    wasRadarRecently &&
    xgExists &&
    total.xg >= 0.7 &&
    spike >= XG_SPIKE_MIN &&
    momentum >= 2.0 &&
    totalPress >= MIN_ELITE &&
    realAttack;

  if (ultra) {
    radarMemory.delete(fixtureId);

    return {
      send: true,
      type: "ULTRA",
      title: "🚨🔥 ULTRA REAL SPIKE",
      karar: "💣 ANLIK GİR",
      stake: "%1 - %2 kasa",
      note: "Önce RADAR geldi, ardından XG + momentum + gerçek pozisyon artışı güçlendi. Fake veri kullanılmadı."
    };
  }

  const elite =
    xgExists &&
    total.xg >= 0.7 &&
    spike >= XG_SPIKE_MIN &&
    momentum >= 1.5 &&
    totalPress >= MIN_ELITE &&
    realAttack;

  if (elite) {
    return {
      send: true,
      type: "ELITE",
      title: "🔥 PRO REAL XG ELITE",
      karar: "✅ GİRİLEBİLİR",
      stake: "%1 - %2 kasa",
      note: "XG API’den geliyor. XG spike var. Momentum ve gerçek pozisyon artışı var."
    };
  }

  const radar =
    !xgExists &&
    totalPress >= MIN_RADAR_PRESS &&
    momentum >= MIN_RADAR_MOMENTUM &&
    realAttack;

  if (radar) {
    radarMemory.set(fixtureId, Date.now());

    return {
      send: true,
      type: "RADAR",
      title: "⚠️ REAL RADAR",
      karar: "👀 İZLE / GİRME",
      stake: "Girme, takip et",
      note: "XG API’den gelmiyor. Fake XG üretilmedi. Sadece gerçek şut/korner/ceza içi/momentum verisiyle radar bildirimi."
    };
  }

  return { send: false, type: "NONE" };
}

function shouldSend(key, minutes = 12) {
  const last = sent.get(key) || 0;

  if (Date.now() - last < minutes * 60 * 1000) {
    return false;
  }

  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 ELITE + RADAR + ULTRA REAL kaliteli lig taraması başladı...");

  const matches = await getLiveMatches();

  const filtered = matches
    .filter(m => {
      const minute = m.fixture.status.elapsed;
      const league = m.league.name || "";

      if (!minute) return false;
      if (minute < 1 || minute > 90) return false;

      if (badLeague(league)) return false;
      if (!goodLeague(league)) return false;

      return true;
    })
    .slice(0, MAX_MATCH);

  console.log(`⚽ ${matches.length} canlı maç | Kaliteli lig incelenecek: ${filtered.length}`);

  let checked = 0;
  let statsYok = 0;
  let ultraSent = 0;
  let eliteSent = 0;
  let radarSent = 0;
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

    const old = memory.get(fixtureId);
    const delta = old ? diff(totalStats, old.totalStats) : null;

    memory.set(fixtureId, {
      totalStats,
      minute
    });

    const momentum = momentumScore(delta);
    const spike = xgSpike(delta);
    const totalPress = totalPressure(totalStats, minute);

    const market = chooseMarket(minute, totalGoals);

    if (!market) {
      pas++;
      continue;
    }

    const need = neededGoal(market, homeGoals, awayGoals);

    const decision = signalDecision({
      fixtureId,
      total: totalStats,
      totalPress,
      momentum,
      spike,
      delta,
      need,
      minute
    });

    if (!decision.send) {
      pas++;
      continue;
    }

    const key = `${fixtureId}_${market}_${decision.type}`;

    const cooldown =
      decision.type === "ULTRA" ? 20 :
      decision.type === "ELITE" ? 15 :
      10;

    if (!shouldSend(key, cooldown)) {
      continue;
    }

    const msg = `
${decision.title} <b>SİNYAL</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Market:</b> ${market}
🥅 <b>Gereken Gol:</b> ${need}

<b>GERÇEK API VERİSİ</b>
📈 Baskı: ${totalPress}
🎯 Toplam XG: ${totalStats.xg > 0 ? totalStats.xg : "YOK"}
🚀 XG Spike: ${spike > 0 ? "+" + spike : "YOK"}
🧭 Momentum: ${momentum}

<b>SON TUR ARTIŞ</b>
📍 Şut Artışı: ${delta ? delta.shots : "İlk ölçüm"}
🎯 İsabet Artışı: ${delta ? delta.shotsOn : "İlk ölçüm"}
📦 Ceza İçi Şut Artışı: ${delta ? delta.insideBox : "İlk ölçüm"}
🚩 Korner Artışı: ${delta ? delta.corners : "İlk ölçüm"}
⚡ Tehlikeli Atak Artışı: ${delta ? delta.dangerous : "İlk ölçüm"}
🎯 XG Artışı: ${delta ? delta.xg : "İlk ölçüm"}

<b>TOPLAM İSTATİSTİK</b>
📍 Şut: ${totalStats.shots}
🎯 İsabet: ${totalStats.shotsOn}
📦 Ceza İçi Şut: ${totalStats.insideBox}
🚩 Korner: ${totalStats.corners}
⚡ Tehlikeli Atak: ${totalStats.dangerous}

🧠 <b>NET KARAR:</b> ${decision.karar}
💰 <b>Stake:</b> ${decision.stake}

📝 <b>Not:</b>
${decision.note}

⚠️ Garanti değildir. Kasa yönetimi şart.
`;

    await sendTelegram(msg);

    if (decision.type === "ULTRA") ultraSent++;
    if (decision.type === "ELITE") eliteSent++;
    if (decision.type === "RADAR") radarSent++;
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Ultra:${ultraSent} | Elite:${eliteSent} | Radar:${radarSent} | Pas:${pas}`
  );
}

async function startBot() {
  console.log("🤖 MEZBAHANE ELITE + RADAR + ULTRA REAL BOT BAŞLADI");

  await sendTelegram(
    "🤖 <b>MEZBAHANE ELITE + RADAR + ULTRA REAL BOT AKTİF ✅</b>\nRADAR izleme, ELITE giriş, ULTRA radar sonrası güçlenme sistemi aktif. Fake veri yok."
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