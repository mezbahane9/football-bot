const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = 180000;
const STATS_DELAY = 1500;
const MAX_MATCH = 20;

const MIN_RADAR = 10;
const MIN_MOMENTUM = 1.5;
const ELITE_BOOST = 1.3;

const sentRadar = new Map();
const radarMemory = new Map();
const sentElite = new Set();

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

function getValue(arr, name) {
  const raw = arr.find(x => x.type === name)?.value;

  if (raw === null || raw === undefined) return 0;

  if (typeof raw === "string" && raw.includes("%")) {
    return Number(raw.replace("%", "")) || 0;
  }

  return Number(raw) || 0;
}

function extractStats(team) {
  const s = team?.statistics || [];

  return {
    shots: getValue(s, "Total Shots"),
    shotsOn: getValue(s, "Shots on Goal"),
    shotsOff: getValue(s, "Shots off Goal"),
    corners: getValue(s, "Corner Kicks"),
    inside: getValue(s, "Shots insidebox"),
    dangerous: getValue(s, "Dangerous Attacks"),
    possession: getValue(s, "Ball Possession")
  };
}

function combine(a, b) {
  return {
    shots: a.shots + b.shots,
    shotsOn: a.shotsOn + b.shotsOn,
    shotsOff: a.shotsOff + b.shotsOff,
    corners: a.corners + b.corners,
    inside: a.inside + b.inside,
    dangerous: a.dangerous + b.dangerous,
    possession: Math.round((a.possession + b.possession) / 2)
  };
}

function diff(now, old) {
  if (!old) return null;

  return {
    shots: Math.max(0, now.shots - old.shots),
    shotsOn: Math.max(0, now.shotsOn - old.shotsOn),
    shotsOff: Math.max(0, now.shotsOff - old.shotsOff),
    corners: Math.max(0, now.corners - old.corners),
    inside: Math.max(0, now.inside - old.inside),
    dangerous: Math.max(0, now.dangerous - old.dangerous)
  };
}

function pressureScore(t) {
  const score =
    t.shots * 0.3 +
    t.shotsOn * 1.4 +
    t.corners * 0.8 +
    t.inside * 0.7 +
    t.dangerous * 0.05;

  return Number(score.toFixed(1));
}

function momentumScore(d) {
  if (!d) return 0;

  const score =
    d.shots * 0.6 +
    d.shotsOn * 1.8 +
    d.corners * 1.2 +
    d.inside * 0.9 +
    d.dangerous * 0.08;

  return Number(score.toFixed(1));
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

function chooseMarket(minute, homeGoals, awayGoals) {
  const totalGoals = homeGoals + awayGoals;

  if (minute <= 45) {
    if (totalGoals === 0) {
      return {
        market: "İlk Yarı 0.5 ÜST",
        need: 1,
        risk: "Orta"
      };
    }

    if (totalGoals === 1) {
      return {
        market: "İlk Yarı 1.5 ÜST",
        need: 1,
        risk: "Orta-yüksek"
      };
    }
  }

  if (minute > 45 && minute <= 70) {
    if (totalGoals <= 1) {
      return {
        market: "Maç Sonu 1.5 ÜST",
        need: Math.max(0, 2 - totalGoals),
        risk: "Orta"
      };
    }

    if (totalGoals === 2) {
      return {
        market: "Maç Sonu 2.5 ÜST",
        need: 1,
        risk: "Orta"
      };
    }
  }

  if (minute > 70 && minute <= 85) {
    if (totalGoals <= 1) {
      return {
        market: "Maç Sonu 1.5 ÜST",
        need: Math.max(0, 2 - totalGoals),
        risk: "Orta-yüksek"
      };
    }

    if (totalGoals === 2) {
      return {
        market: "Maç Sonu 2.5 ÜST",
        need: 1,
        risk: "Orta-yüksek"
      };
    }

    if (totalGoals === 3) {
      return {
        market: "Maç Sonu 3.5 ÜST",
        need: 1,
        risk: "Yüksek"
      };
    }
  }

  return null;
}

function hasRealIncrease(d) {
  if (!d) return false;

  return (
    d.shots >= 1 ||
    d.shotsOn >= 1 ||
    d.corners >= 1 ||
    d.inside >= 1 ||
    d.dangerous >= 1
  );
}

async function analyze() {
  console.log("🔎 RADAR → ELITE MARKETLİ tarama başladı...");

  const data = await apiGet("https://v3.football.api-sports.io/fixtures?live=all");
  const matches = data?.response || [];

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

  console.log(`⚽ ${matches.length} canlı maç | İncelenecek kaliteli maç: ${filtered.length}`);

  let checked = 0;
  let statsYok = 0;
  let radarSent = 0;
  let eliteSent = 0;
  let pas = 0;

  for (const m of filtered) {
    await sleep(STATS_DELAY);

    const id = m.fixture.id;
    const minute = m.fixture.status.elapsed;

    const homeName = m.teams.home.name;
    const awayName = m.teams.away.name;
    const league = m.league.name;
    const country = m.league.country;

    const homeGoals = Number(m.goals.home || 0);
    const awayGoals = Number(m.goals.away || 0);

    const marketInfo = chooseMarket(minute, homeGoals, awayGoals);

    if (!marketInfo || marketInfo.need > 1 || minute > 85) {
      pas++;
      continue;
    }

    const statsData = await apiGet(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`
    );

    if (!statsData?.response || statsData.response.length < 2) {
      statsYok++;
      continue;
    }

    checked++;

    const homeStats = extractStats(statsData.response[0]);
    const awayStats = extractStats(statsData.response[1]);
    const totalStats = combine(homeStats, awayStats);

    const previous = radarMemory.get(id);
    const delta = previous ? diff(totalStats, previous.stats) : null;

    radarMemory.set(id, {
      stats: totalStats,
      minute,
      pressure: pressureScore(totalStats)
    });

    const pressure = pressureScore(totalStats);
    const momentum = momentumScore(delta);

    if (!hasRealIncrease(delta)) {
      pas++;
      continue;
    }

    const radarKey = `${id}_RADAR_${marketInfo.market}`;
    const eliteKey = `${id}_ELITE_${marketInfo.market}`;

    if (
      pressure >= MIN_RADAR &&
      momentum >= MIN_MOMENTUM &&
      !sentRadar.has(radarKey)
    ) {
      sentRadar.set(radarKey, {
        pressure,
        momentum,
        time: Date.now()
      });

      const radarMsg = `
🟡 <b>RADAR</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Önerilen Market:</b> ${marketInfo.market}
🥅 <b>Gereken Gol:</b> ${marketInfo.need}

📈 <b>Baskı:</b> ${pressure}
🧭 <b>Momentum:</b> ${momentum}

<b>SON ARTIŞ</b>
📍 Şut Artışı: ${delta ? delta.shots : "İlk ölçüm"}
🎯 İsabet Artışı: ${delta ? delta.shotsOn : "İlk ölçüm"}
📦 Ceza İçi Şut Artışı: ${delta ? delta.inside : "İlk ölçüm"}
🚩 Korner Artışı: ${delta ? delta.corners : "İlk ölçüm"}

👀 <b>Karar:</b> Takip et, hemen girme.
`;

      await sendTelegram(radarMsg);
      radarSent++;
    }

    if (sentRadar.has(radarKey) && !sentElite.has(eliteKey)) {
      const oldRadar = sentRadar.get(radarKey);

      const radarStillFresh =
        Date.now() - oldRadar.time <= 8 * 60 * 1000;

      const pressureGrew = pressure >= oldRadar.pressure * ELITE_BOOST;
      const momentumStrong = momentum >= 3;
      const strongData =
        delta &&
        (
          delta.shots >= 2 ||
          delta.shotsOn >= 1 ||
          delta.inside >= 1 ||
          delta.corners >= 1
        );

      if (radarStillFresh && pressureGrew && momentumStrong && strongData) {
        sentElite.add(eliteKey);

        const eliteMsg = `
🔴 <b>ELITE GİRİŞ</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>ÖNERİLEN MARKET:</b> ${marketInfo.market}
🥅 <b>Gereken Gol:</b> ${marketInfo.need}
⚠️ <b>Risk:</b> ${marketInfo.risk}

📈 <b>Baskı:</b> ${pressure} ↑
🧭 <b>Momentum:</b> ${momentum}

<b>GÜÇLENME VERİSİ</b>
📍 Şut Artışı: ${delta.shots}
🎯 İsabet Artışı: ${delta.shotsOn}
📦 Ceza İçi Şut Artışı: ${delta.inside}
🚩 Korner Artışı: ${delta.corners}

💰 <b>NET KARAR:</b> GİRİLEBİLİR
💵 <b>Stake:</b> %1 kasa

📝 <b>Not:</b>
Radar sonrası baskı ve momentum güçlendi. Market dakikaya ve skora göre seçildi. Fake veri yok.
`;

        await sendTelegram(eliteMsg);
        eliteSent++;
      }
    }
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Radar:${radarSent} | Elite:${eliteSent} | Pas:${pas}`
  );
}

async function startBot() {
  console.log("🤖 MEZBAHANE RADAR → ELITE MARKETLİ BOT BAŞLADI");

  await sendTelegram(
    "🤖 <b>MEZBAHANE RADAR → ELITE MARKETLİ BOT AKTİF ✅</b>\nRADAR market gösterir. ELITE gelirse market + stake + risk yazar. Fake veri yok."
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