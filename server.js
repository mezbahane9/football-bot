const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 20);
const STATS_DELAY = Number(process.env.STATS_DELAY || 1500);

const MIN_RADAR = Number(process.env.MIN_RADAR || 7.0);
const MIN_NORMAL = Number(process.env.MIN_NORMAL || 9.0);
const MIN_ELITE = Number(process.env.MIN_ELITE || 10.5);

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
      console.log("⏳ Rate limit yedik. 90 sn bekleniyor...");
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
    offsides: getValue(s, "Offsides"),
    fouls: getValue(s, "Fouls"),
    yellow: getValue(s, "Yellow Cards"),
    red: getValue(s, "Red Cards"),
    possession: getValue(s, "Ball Possession"),
    saves: getValue(s, "Goalkeeper Saves"),
    passes: getValue(s, "Total passes"),
    accuratePasses: getValue(s, "Passes accurate"),
    passPercent: getValue(s, "Passes %"),
    dangerous: getValue(s, "Dangerous Attacks")
  };
}

function combine(a, b) {
  return {
    shots: a.shots + b.shots,
    shotsOn: a.shotsOn + b.shotsOn,
    shotsOff: a.shotsOff + b.shotsOff,
    blocked: a.blocked + b.blocked,
    insideBox: a.insideBox + b.insideBox,
    outsideBox: a.outsideBox + b.outsideBox,
    corners: a.corners + b.corners,
    offsides: a.offsides + b.offsides,
    fouls: a.fouls + b.fouls,
    yellow: a.yellow + b.yellow,
    red: a.red + b.red,
    possession: a.possession + b.possession,
    saves: a.saves + b.saves,
    passes: a.passes + b.passes,
    accuratePasses: a.accuratePasses + b.accuratePasses,
    passPercent: a.passPercent + b.passPercent,
    dangerous: a.dangerous + b.dangerous
  };
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

function kalanGol(market, totalGoals) {
  if (!market) return 99;
  if (market.includes("0.5")) return Math.max(0, 1 - totalGoals);
  if (market.includes("1.5")) return Math.max(0, 2 - totalGoals);
  if (market.includes("2.5")) return Math.max(0, 3 - totalGoals);
  if (market.includes("3.5")) return Math.max(0, 4 - totalGoals);
  return 99;
}

function sideScore(t) {
  return (
    t.shots * 0.25 +
    t.shotsOn * 1.35 +
    t.shotsOff * 0.25 +
    t.insideBox * 0.55 +
    t.corners * 0.75 +
    t.dangerous * 0.06 +
    t.possession * 0.025
  );
}

function chooseSide(home, away) {
  const h = sideScore(home);
  const a = sideScore(away);

  if (h >= a + 3) return "Ev";
  if (a >= h + 3) return "Deplasman";
  return "Dengeli";
}

function pressureScore(total, minute, totalGoals, momentum) {
  let score = 0;

  score += total.shots * 0.25;
  score += total.shotsOn * 1.35;
  score += total.shotsOff * 0.25;
  score += total.insideBox * 0.55;
  score += total.corners * 0.75;
  score += total.dangerous * 0.06;

  if (minute >= 30 && minute <= 42 && totalGoals === 0) score += 1.3;
  if (minute >= 55 && minute <= 70) score += 1.5;

  if (total.shots >= 10) score += 0.7;
  if (total.shotsOn >= 3) score += 0.8;
  if (total.shotsOn >= 4) score += 1.1;
  if (total.corners >= 3) score += 0.5;
  if (total.corners >= 4) score += 0.8;
  if (total.dangerous >= 30) score += 0.8;

  if (momentum) {
    if (momentum.shotsOn >= 1) score += 0.7;
    if (momentum.corners >= 1) score += 0.5;
    if (momentum.shots >= 2) score += 0.4;
    if (momentum.dangerous >= 5) score += 0.5;
  }

  return Number(score.toFixed(1));
}

function momentumLabel(momentum) {
  if (!momentum) return "İlk ölçüm";

  const points =
    momentum.shots * 0.6 +
    momentum.shotsOn * 1.5 +
    momentum.corners * 1.1 +
    momentum.dangerous * 0.12;

  if (points >= 4) return "🔥 Çok güçlü";
  if (points >= 2) return "🟢 Güçlü";
  if (points >= 1) return "🟡 Orta";
  return "🔴 Zayıf";
}

function dataConfidence(total) {
  let score = 0;
  const notes = [];

  if (total.shots > 0) score++;
  else notes.push("Şut verisi zayıf");

  if (total.shotsOn > 0) score++;
  else notes.push("İsabet verisi zayıf");

  if (total.corners > 0) score++;
  else notes.push("Korner verisi zayıf");

  if (total.dangerous > 0) score++;
  else notes.push("Tehlikeli atak API’de 0 görünüyor");

  if (score >= 4) return { label: "Yüksek", notes: "Veriler yeterli" };
  if (score >= 2) return { label: "Orta", notes: notes.join(", ") };
  return { label: "Düşük", notes: notes.join(", ") || "API verisi yetersiz" };
}

function signalLevel(score) {
  if (score >= MIN_ELITE) return "💰🔥 ELITE";
  if (score >= MIN_NORMAL) return "💰🟢 NORMAL";
  if (score >= MIN_RADAR) return "⚠️ RADAR";
  return null;
}

function kararMotoru({ minute, totalGoals, market, score, total, side, momentum, dataConf }) {
  const need = kalanGol(market, totalGoals);
  const reasons = [];
  const risks = [];

  if (!market) {
    return { send: false, karar: "❌ PAS", risk: "Yüksek", stake: "Girme", neden: "Uygun market yok." };
  }

  if (minute < 25 || minute > 75) {
    return { send: false, karar: "❌ PAS", risk: "Yüksek", stake: "Girme", neden: "Dakika aralığı uygun değil." };
  }

  if (minute >= 60 && totalGoals === 0 && market !== "Maç Sonu 1.5 ÜST") {
    return { send: false, karar: "❌ PAS", risk: "Yüksek", stake: "Girme", neden: "60+ 0-0 iken yüksek over riskli." };
  }

  if (minute >= 65 && need >= 2) {
    return { send: false, karar: "❌ PAS", risk: "Yüksek", stake: "Girme", neden: "Dakika ilerledi ve 2+ gol gerekiyor." };
  }

  if (score >= 10.5) reasons.push("Baskı skoru yüksek");
  if (total.shots >= 10) reasons.push("Toplam şut yüksek");
  if (total.shotsOn >= 3) reasons.push("İsabetli şut var");
  if (total.corners >= 3) reasons.push("Korner baskısı var");
  if (total.dangerous >= 20) reasons.push("Tehlikeli atak desteği var");
  if (side !== "Dengeli") reasons.push("Baskı yönü net");

  if (momentum && (momentum.shotsOn >= 1 || momentum.corners >= 1 || momentum.dangerous >= 5)) {
    reasons.push("Son turda momentum artışı var");
  }

  if (dataConf.label === "Düşük") risks.push("Veri güveni düşük");
  if (side === "Dengeli") risks.push("Tek taraflı baskı net değil");
  if (need >= 2) risks.push("Gereken gol sayısı fazla");
  if (total.dangerous === 0) risks.push("Tehlikeli atak API’de 0; veri eksik olabilir");

  if (score >= MIN_ELITE && need <= 1 && side !== "Dengeli" && dataConf.label !== "Düşük") {
    return {
      send: true,
      karar: "✅ GİRİLEBİLİR",
      risk: risks.length ? "Orta" : "Orta-düşük",
      stake: "%1 - %2 kasa",
      neden: reasons.join(", ") || "Elite şartlar sağlandı."
    };
  }

  if (score >= MIN_NORMAL && need <= 1) {
    return {
      send: true,
      karar: "⚠️ KONTROLLÜ / DÜŞÜK STAKE",
      risk: "Orta-yüksek",
      stake: "%0.5 - %1 kasa",
      neden: `${reasons.join(", ") || "Baskı var"}${risks.length ? ". Risk: " + risks.join(", ") : ""}`
    };
  }

  if (score >= MIN_RADAR) {
    return {
      send: true,
      karar: "👀 İZLE",
      risk: "Orta",
      stake: "Girme, takip et",
      neden: `${reasons.join(", ") || "Maç ısınıyor"}${risks.length ? ". Risk: " + risks.join(", ") : ""}`
    };
  }

  return { send: false, karar: "❌ PAS", risk: "Yüksek", stake: "Girme", neden: "Baskı yeterli değil." };
}

function shouldSend(key, minutes = 12) {
  const last = sent.get(key) || 0;
  if (Date.now() - last < minutes * 60 * 1000) return false;
  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 Detaylı tarama başladı...");

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
  let sentCount = 0;
  let pas = 0;

  for (const m of filtered) {
    await sleep(STATS_DELAY);

    const minute = m.fixture.status.elapsed;

    if (!minute || minute < 25 || minute > 75) {
      pas++;
      continue;
    }

    const homeName = m.teams.home.name;
    const awayName = m.teams.away.name;
    const league = m.league.name;
    const country = m.league.country;

    const homeGoals = Number(m.goals.home || 0);
    const awayGoals = Number(m.goals.away || 0);
    const totalGoals = homeGoals + awayGoals;

    const market = selectMarket(minute, totalGoals);

    if (!market) {
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

    const old = memory.get(m.fixture.id);
    const momentum = old ? diff(totalStats, old.totalStats) : null;
    memory.set(m.fixture.id, { totalStats, minute });

    const side = chooseSide(homeStats, awayStats);
    const dataConf = dataConfidence(totalStats);
    const score = pressureScore(totalStats, minute, totalGoals, momentum);
    const level = signalLevel(score);

    if (!level) {
      pas++;
      continue;
    }

    const decision = kararMotoru({
      minute,
      totalGoals,
      market,
      score,
      total: totalStats,
      side,
      momentum,
      dataConf
    });

    if (!decision.send) {
      pas++;
      continue;
    }

    const need = kalanGol(market, totalGoals);

    const key = `${m.fixture.id}_${decision.karar}_${market}`;
    if (!shouldSend(key, decision.karar.includes("GİR") ? 15 : 12)) continue;

    const msg = `
${level} <b>SİNYAL</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Market:</b> ${market}
🥅 <b>Gereken Gol:</b> ${need}
➡️ <b>Yön:</b> ${side}

📈 <b>Baskı Skoru:</b> ${score}/10
🧭 <b>Momentum:</b> ${momentumLabel(momentum)}
🛡 <b>Veri Güveni:</b> ${dataConf.label}
📌 <b>Veri Notu:</b> ${dataConf.notes}

<b>GENEL İSTATİSTİK</b>
📍 Şut: ${totalStats.shots}
🎯 İsabetli Şut: ${totalStats.shotsOn}
📤 İsabetsiz Şut: ${totalStats.shotsOff}
🧱 Bloklanan Şut: ${totalStats.blocked}
📦 Ceza Sahası İçi Şut: ${totalStats.insideBox}
🚩 Korner: ${totalStats.corners}
⚡ Tehlikeli Atak: ${totalStats.dangerous}
🟨 Sarı Kart: ${totalStats.yellow}
🟥 Kırmızı Kart: ${totalStats.red}

<b>SON TUR MOMENTUM</b>
📍 Şut Artışı: ${momentum ? momentum.shots : "İlk ölçüm"}
🎯 İsabet Artışı: ${momentum ? momentum.shotsOn : "İlk ölçüm"}
🚩 Korner Artışı: ${momentum ? momentum.corners : "İlk ölçüm"}
⚡ Tehlikeli Atak Artışı: ${momentum ? momentum.dangerous : "İlk ölçüm"}

🧠 <b>NET KARAR:</b> ${decision.karar}
⚠️ <b>Risk:</b> ${decision.risk}
💰 <b>Stake:</b> ${decision.stake}
📝 <b>Neden:</b> ${decision.neden}

⚠️ <b>Not:</b> Garanti değildir. Kasa yönetimi şart.
`;

    await sendTelegram(msg);
    sentCount++;
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Gönderildi:${sentCount} | Pas:${pas}`
  );
}

console.log("🤖 MEZBAHANE DETAIL PRO AKTİF ✅");
await sendTelegram(
  "🤖 MEZBAHANE DETAIL PRO AKTİF ✅\nAPI dostu detaylı momentum + karar sistemi çalışıyor."
);

await analyze();

setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.log("Ana hata:", err.message);
  }
}, POLL_INTERVAL);