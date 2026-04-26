const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 25);

const MIN_RADAR = Number(process.env.MIN_RADAR || 6.5);
const MIN_NORMAL = Number(process.env.MIN_NORMAL || 8.5);
const MIN_ELITE = Number(process.env.MIN_ELITE || 10.5);

const sent = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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
      headers: {
        "x-apisports-key": API_KEY
      }
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
  const raw = arr.find((x) => x.type === name)?.value;

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

function pressureScore(stats, minute, totalGoals) {
  let score = 0;

  score += stats.shots * 0.25;
  score += stats.shotsOn * 1.25;
  score += stats.shotsOff * 0.25;
  score += stats.corners * 0.65;
  score += stats.dangerous * 0.055;

  if (minute >= 30 && minute <= 42 && totalGoals === 0) score += 1.2;
  if (minute >= 55 && minute <= 72) score += 1.4;

  if (stats.shotsOn >= 3) score += 1.0;
  if (stats.corners >= 3) score += 0.5;
  if (stats.corners >= 4) score += 0.7;
  if (stats.dangerous >= 35) score += 0.8;

  return Number(score.toFixed(1));
}

function chooseSide(homeStats, awayStats) {
  const h =
    homeStats.shotsOn * 1.25 +
    homeStats.corners * 0.65 +
    homeStats.dangerous * 0.055;

  const a =
    awayStats.shotsOn * 1.25 +
    awayStats.corners * 0.65 +
    awayStats.dangerous * 0.055;

  if (h >= a + 2.5) return "Ev";
  if (a >= h + 2.5) return "Deplasman";

  return "Dengeli";
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

  return bad.some((x) => name.toLowerCase().includes(x.toLowerCase()));
}

function selectMarket(minute, totalGoals) {
  if (minute >= 25 && minute <= 42 && totalGoals === 0) {
    return "İlk Yarı 0.5 ÜST";
  }

  if (minute >= 25 && minute <= 40 && totalGoals === 1) {
    return "İlk Yarı 1.5 ÜST";
  }

  if (minute >= 50 && minute <= 75) {
    if (totalGoals <= 1) return "Maç Sonu 1.5 ÜST";
    if (totalGoals === 2) return "Maç Sonu 2.5 ÜST";
    if (totalGoals === 3 && minute <= 68) return "Maç Sonu 3.5 ÜST";
  }

  return null;
}

function dakikaFiltresi(minute, totalGoals, market) {
  if (minute < 25) return false;
  if (minute > 75) return false;

  if (minute >= 60 && totalGoals === 0 && market.includes("2.5")) return false;
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

function kalanGolHesapla(market, totalGoals) {
  if (market.includes("0.5")) return Math.max(0, 1 - totalGoals);
  if (market.includes("1.5")) return Math.max(0, 2 - totalGoals);
  if (market.includes("2.5")) return Math.max(0, 3 - totalGoals);
  if (market.includes("3.5")) return Math.max(0, 4 - totalGoals);

  return 1;
}

function kararMotoru({ minute, totalGoals, market, score, stats, level }) {
  const kalanGol = kalanGolHesapla(market, totalGoals);

  let karar = "⚠️ BEKLE";
  let risk = "Orta";
  let stake = "Küçük stake";
  const nedenler = [];

  if (score >= 10.5) nedenler.push("Baskı çok yüksek");
  if (score >= 8.5 && score < 10.5) nedenler.push("Baskı iyi seviyede");
  if (stats.shots >= 10) nedenler.push("Toplam şut yüksek");
  if (stats.shotsOn >= 3) nedenler.push("İsabetli şut iyi");
  if (stats.corners >= 3) nedenler.push("Korner baskısı var");
  if (minute >= 30 && minute <= 42 && market.includes("İlk Yarı")) {
    nedenler.push("İlk yarı gol için uygun dakika");
  }
  if (minute >= 55 && minute <= 70) {
    nedenler.push("İkinci yarı gol bölgesi");
  }

  if (minute >= 60 && totalGoals === 0 && market.includes("2.5")) {
    return {
      karar: "❌ PAS",
      risk: "Çok yüksek",
      stake: "Girme",
      neden:
        "60+ dakika 0-0 iken 2.5 üst için 3 gol gerekir. Bu market mantıklı değil."
    };
  }

  if (minute >= 65 && kalanGol >= 2) {
    return {
      karar: "❌ PAS",
      risk: "Yüksek",
      stake: "Girme",
      neden:
        "Dakika ilerlemiş ve en az 2 gol gerekiyor. Baskı olsa bile risk fazla."
    };
  }

  if (level.includes("RADAR")) {
    return {
      karar: "👀 İZLE",
      risk: "Orta",
      stake: "Girme / takip et",
      neden:
        nedenler.length > 0
          ? nedenler.join(", ") + ". Ama net giriş seviyesine tam ulaşmamış."
          : "Maç ısınıyor ama net giriş için veri henüz yeterli değil."
    };
  }

  if (score >= 10.5 && kalanGol <= 1) {
    karar = "✅ GİRİLEBİLİR";
    risk = "Orta";
    stake = "Küçük / orta stake";
  } else if (score >= 8.5 && kalanGol <= 1) {
    karar = "⚠️ DÜŞÜK STAKE";
    risk = "Orta-yüksek";
    stake = "Küçük stake";
  } else if (score >= 10.5 && kalanGol === 2 && minute < 60) {
    karar = "⚠️ AGRESİF GİRİŞ";
    risk = "Yüksek";
    stake = "Çok küçük stake";
  }

  return {
    karar,
    risk,
    stake,
    neden:
      nedenler.length > 0
        ? nedenler.join(", ")
        : "Baskı var ama net giriş için ek teyit zayıf."
  };
}

function shouldSend(key, minutes = 10) {
  const last = sent.get(key) || 0;

  if (Date.now() - last < minutes * 60 * 1000) {
    return false;
  }

  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 Tarama başladı...");

  const matches = await getLiveMatches();

  const filtered = matches
    .filter((m) => {
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
    if (!market) continue;

    if (!dakikaFiltresi(minute, totalGoals, market)) {
      pas++;
      continue;
    }

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
    const level = signalLevel(score);

    if (!level) continue;

    const decision = kararMotoru({
      minute,
      totalGoals,
      market,
      score,
      stats: totalStats,
      level
    });

    if (decision.karar.includes("PAS")) {
      pas++;
      continue;
    }

    const key = `${m.fixture.id}_${level.includes("RADAR") ? "radar" : "signal"}`;

    if (!shouldSend(key, level.includes("RADAR") ? 12 : 15)) continue;

    const msg = `
${level}

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

🧠 <b>NET KARAR:</b> ${decision.karar}
⚠️ <b>Risk:</b> ${decision.risk}
💰 <b>Stake:</b> ${decision.stake}
📝 <b>Neden:</b> ${decision.neden}
`;

    await sendTelegram(msg);

    if (level.includes("RADAR")) radar++;
    else signal++;
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Radar:${radar} | Sinyal:${signal} | Pas:${pas}`
  );
}

console.log("🤖 MEZBAHANE FINAL PRO AKTİF ✅");
await sendTelegram(
  "🤖 MEZBAHANE FINAL PRO AKTİF ✅\nRadar + Normal + Elite + Net Karar sistemi çalışıyor."
);

await analyze();

setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.log("Ana hata:", err.message);
  }
}, POLL_INTERVAL);