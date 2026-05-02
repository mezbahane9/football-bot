const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = 180000;
const STATS_DELAY = 1500;
const MAX_MATCH = 40;

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
      console.log("Rate limit. 90 sn bekleniyor...");
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

function extractStats(team) {
  const s = team?.statistics || [];

  return {
    shots: getValue(s, "Total Shots"),
    shotsOn: getValue(s, "Shots on Goal"),
    shotsOff: getValue(s, "Shots off Goal"),
    blocked: getValue(s, "Blocked Shots"),
    inside: getValue(s, "Shots insidebox"),
    outside: getValue(s, "Shots outsidebox"),
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
    dangerous: getValue(s, "Dangerous Attacks"),
    xg: getValue(s, "Expected Goals")
  };
}

function combine(a, b) {
  const out = {};
  for (const k of Object.keys(a)) {
    out[k] = (a[k] || 0) + (b[k] || 0);
  }
  return out;
}

function diff(now, old) {
  if (!old) return null;

  const out = {};
  for (const k of Object.keys(now)) {
    out[k] = Math.max(0, (now[k] || 0) - (old[k] || 0));
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

function pressureScore(t, minute) {
  let score = 0;

  score += t.shots * 0.35;
  score += t.shotsOn * 1.8;
  score += t.inside * 0.9;
  score += t.corners * 0.9;
  score += t.dangerous * 0.06;
  score += t.xg * 4.0;

  if (minute >= 50 && minute <= 80) score += 1.0;
  if (minute >= 25 && minute <= 44) score += 0.7;

  return Number(score.toFixed(1));
}

function momentumScore(d) {
  if (!d) return 0;

  const score =
    d.shots * 0.8 +
    d.shotsOn * 2.3 +
    d.inside * 1.2 +
    d.corners * 1.3 +
    d.dangerous * 0.12 +
    d.xg * 5.0;

  return Number(score.toFixed(1));
}

function marketCandidates({
  minute,
  homeGoals,
  awayGoals,
  homePressure,
  awayPressure,
  totalPressure,
  homeMomentum,
  awayMomentum,
  totalMomentum
}) {
  const total = homeGoals + awayGoals;
  const markets = [];

  const add = (market, need, score, type) => {
    if (need === 1) {
      markets.push({
        market,
        need,
        score: Number(score.toFixed(1)),
        type
      });
    }
  };

  if (minute >= 15 && minute <= 44) {
    if (total === 0) add("İlk Yarı 0.5 ÜST", 1, totalPressure + totalMomentum, "OVER");
    if (total === 1) add("İlk Yarı 1.5 ÜST", 1, totalPressure + totalMomentum - 0.5, "OVER");
    if (total === 2 && minute <= 42) add("İlk Yarı 2.5 ÜST", 1, totalPressure + totalMomentum - 1.0, "OVER");
  }

  if (minute >= 46 && minute <= 82) {
    if (total === 1) add("Maç Sonu 1.5 ÜST", 1, totalPressure + totalMomentum, "OVER");
    if (total === 2) add("Maç Sonu 2.5 ÜST", 1, totalPressure + totalMomentum, "OVER");
    if (total === 3) add("Maç Sonu 3.5 ÜST", 1, totalPressure + totalMomentum - 0.5, "OVER");
    if (total === 4 && minute <= 78) add("Maç Sonu 4.5 ÜST", 1, totalPressure + totalMomentum - 1.0, "OVER");
  }

  if (minute >= 50 && minute <= 85) {
    const homeDominant =
      homePressure >= awayPressure + 5 &&
      homeMomentum >= awayMomentum + 1.5;

    const awayDominant =
      awayPressure >= homePressure + 5 &&
      awayMomentum >= homeMomentum + 1.5;

    if (homeDominant) {
      add("Sıradaki Gol Ev Sahibi", 1, homePressure + homeMomentum + 1.5, "NEXT_GOAL_HOME");
    }

    if (awayDominant) {
      add("Sıradaki Gol Deplasman Takımı", 1, awayPressure + awayMomentum + 1.5, "NEXT_GOAL_AWAY");
    }
  }

  return markets.sort((a, b) => b.score - a.score);
}

function qualityCheck({ minute, total, delta, pressure, momentum, marketInfo }) {
  const reasons = [];
  const risks = [];

  if (!delta) return { ok: false };

  if (!marketInfo || marketInfo.need !== 1) return { ok: false };

  const isFirstHalfMarket = marketInfo.market.includes("İlk Yarı");
  const isFullTimeMarket = marketInfo.market.includes("Maç Sonu");
  const isNextGoalMarket = marketInfo.market.includes("Sıradaki Gol");

  if (isFirstHalfMarket && (minute < 15 || minute > 44)) return { ok: false };
  if (isFullTimeMarket && (minute < 46 || minute > 82)) return { ok: false };
  if (isNextGoalMarket && (minute < 50 || minute > 85)) return { ok: false };

  let points = 0;

  if (pressure >= 22) {
    points += 2;
    reasons.push("Toplam baskı çok yüksek");
  } else if (pressure >= 18) {
    points += 1;
    reasons.push("Toplam baskı yüksek");
  } else {
    risks.push("Baskı yeterince güçlü değil");
  }

  if (momentum >= 6) {
    points += 2;
    reasons.push("Momentum çok güçlü");
  } else if (momentum >= 4.5) {
    points += 1;
    reasons.push("Momentum güçlü");
  } else {
    risks.push("Momentum düşük");
  }

  if (delta.shots >= 2) {
    points += 1;
    reasons.push("Son turda şut artışı var");
  }

  if (delta.shotsOn >= 1) {
    points += 2;
    reasons.push("Son turda isabetli şut artışı var");
  } else {
    risks.push("Son turda isabet artışı yok");
  }

  if (delta.inside >= 1) {
    points += 2;
    reasons.push("Ceza içi şut artışı var");
  } else {
    risks.push("Ceza içi artış yok");
  }

  if (delta.corners >= 1 || delta.dangerous >= 5) {
    points += 1;
    reasons.push("Korner veya tehlikeli atak artışı var");
  }

  if (total.xg >= 0.8) {
    points += 2;
    reasons.push("XG güçlü destek veriyor");
  } else if (total.xg > 0) {
    points += 1;
    reasons.push("XG mevcut ama çok yüksek değil");
  } else {
    risks.push("XG API’de yok, fake XG üretilmedi");
  }

  if (delta.xg >= 0.10) {
    points += 2;
    reasons.push("Son turda XG spike var");
  }

  if (isNextGoalMarket) {
    points += 1;
    reasons.push("Baskı yönü tek tarafa dönmüş");
  }

  const confidence = Math.min(10, points);

  return {
    ok:
      confidence >= 8 &&
      pressure >= 18 &&
      momentum >= 4.5 &&
      delta.shotsOn >= 1 &&
      delta.inside >= 1,
    confidence,
    reasons,
    risks
  };
}

function shouldSend(key, minutes = 15) {
  const last = sent.get(key) || 0;

  if (Date.now() - last < minutes * 60 * 1000) return false;

  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 YÜKSEK GÜVEN GOL HER AN + TÜM MARKETLER taraması başladı...");

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
  let sentCount = 0;
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

    const stats = await getStats(id);

    if (!stats || stats.length < 2) {
      statsYok++;
      continue;
    }

    checked++;

    const homeStats = extractStats(stats[0]);
    const awayStats = extractStats(stats[1]);
    const totalStats = combine(homeStats, awayStats);

    const old = memory.get(id);

    const homeDelta = old ? diff(homeStats, old.homeStats) : null;
    const awayDelta = old ? diff(awayStats, old.awayStats) : null;
    const totalDelta = old ? diff(totalStats, old.totalStats) : null;

    memory.set(id, {
      homeStats,
      awayStats,
      totalStats,
      minute
    });

    const homePressure = pressureScore(homeStats, minute);
    const awayPressure = pressureScore(awayStats, minute);
    const totalPressure = pressureScore(totalStats, minute);

    const homeMomentum = momentumScore(homeDelta);
    const awayMomentum = momentumScore(awayDelta);
    const totalMomentum = momentumScore(totalDelta);

    const markets = marketCandidates({
      minute,
      homeGoals,
      awayGoals,
      homePressure,
      awayPressure,
      totalPressure,
      homeMomentum,
      awayMomentum,
      totalMomentum
    });

    const marketInfo = markets[0];

    if (!marketInfo) {
      pas++;
      continue;
    }

    const qc = qualityCheck({
      minute,
      total: totalStats,
      delta: totalDelta,
      pressure: totalPressure,
      momentum: totalMomentum,
      marketInfo
    });

    if (!qc.ok) {
      pas++;
      continue;
    }

    const key = `${id}_${marketInfo.market}_GOL_HER_AN`;

    if (!shouldSend(key, 15)) continue;

    const otherMarkets = markets
      .slice(1, 4)
      .map((x, i) => `${i + 2}) ${x.market} | Skor: ${x.score}`)
      .join("\n");

    const msg = `
🚨🔥 <b>GOL HER AN - YÜKSEK GÜVEN</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Önerilen Market:</b> ${marketInfo.market}
🥅 <b>Gereken Gol:</b> ${marketInfo.need}
📌 <b>Güven:</b> ${qc.confidence}/10
📊 <b>Market Skoru:</b> ${marketInfo.score}

<b>CANLI TOPLAM VERİ</b>
📈 Baskı: ${totalPressure}
🧭 Momentum: ${totalMomentum}
🎯 Toplam XG: ${totalStats.xg > 0 ? totalStats.xg : "API’de yok"}
🚀 XG Artışı: ${totalDelta ? totalDelta.xg : "İlk ölçüm"}

<b>BASKI YÖNÜ</b>
🏠 Ev Baskı: ${homePressure}
✈️ Dep Baskı: ${awayPressure}
🏠 Ev Momentum: ${homeMomentum}
✈️ Dep Momentum: ${awayMomentum}

<b>SON TUR ARTIŞ</b>
📍 Şut Artışı: ${totalDelta.shots}
🎯 İsabet Artışı: ${totalDelta.shotsOn}
📦 Ceza İçi Şut Artışı: ${totalDelta.inside}
🚩 Korner Artışı: ${totalDelta.corners}
⚡ Tehlikeli Atak Artışı: ${totalDelta.dangerous}

<b>TOPLAM İSTATİSTİK</b>
📍 Şut: ${totalStats.shots}
🎯 İsabet: ${totalStats.shotsOn}
📤 İsabetsiz: ${totalStats.shotsOff}
📦 Ceza İçi Şut: ${totalStats.inside}
🚩 Korner: ${totalStats.corners}
⚡ Tehlikeli Atak: ${totalStats.dangerous}
⚽ Topa Sahip Olma: ${totalStats.possession}%

<b>EV SAHİBİ</b>
📍 Şut: ${homeStats.shots}
🎯 İsabet: ${homeStats.shotsOn}
📦 Ceza İçi: ${homeStats.inside}
🚩 Korner: ${homeStats.corners}
⚡ Tehlikeli Atak: ${homeStats.dangerous}
🎯 XG: ${homeStats.xg > 0 ? homeStats.xg : "Yok"}

<b>DEPLASMAN</b>
📍 Şut: ${awayStats.shots}
🎯 İsabet: ${awayStats.shotsOn}
📦 Ceza İçi: ${awayStats.inside}
🚩 Korner: ${awayStats.corners}
⚡ Tehlikeli Atak: ${awayStats.dangerous}
🎯 XG: ${awayStats.xg > 0 ? awayStats.xg : "Yok"}

${otherMarkets ? `<b>DİĞER UYGUN MARKETLER</b>\n${otherMarkets}\n` : ""}

🧠 <b>NET KARAR:</b> GİRİLEBİLİR
💰 <b>Stake:</b> %0.5 - %1 kasa

✅ <b>Güçlü Sebepler:</b>
${qc.reasons.map(x => "• " + x).join("\n")}

⚠️ <b>Risk Notu:</b>
${qc.risks.length ? qc.risks.map(x => "• " + x).join("\n") : "Belirgin veri riski yok."}

⚠️ Garanti değildir. Kasa yönetimi şart.
`;

    await sendTelegram(msg);
    sentCount++;
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Gönderildi:${sentCount} | Pas:${pas}`
  );
}

async function startBot() {
  console.log("🤖 YÜKSEK GÜVEN GOL HER AN + TÜM MARKETLER BOT BAŞLADI");

  await sendTelegram(
    "🤖 <b>YÜKSEK GÜVEN GOL HER AN BOT AKTİF ✅</b>\nTüm istenen marketler eklendi. Bot sadece yüksek güvenli gol anlarını gönderir. Fake veri yok."
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