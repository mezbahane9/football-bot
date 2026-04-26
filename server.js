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
      console.log("⏳ Rate limit. 90 sn bekleniyor...");
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

function badLeague(name = "") {
  const bad = [
    "U19", "U20", "U21", "U23",
    "Youth", "Reserve", "Reserves",
    "Women", "Friendly", "Club Friendlies",
    "Amateur", "Regional"
  ];

  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function teamPressure(t, minute) {
  let score = 0;

  score += t.shots * 0.30;
  score += t.shotsOn * 1.45;
  score += t.shotsOff * 0.25;
  score += t.insideBox * 0.60;
  score += t.corners * 0.80;
  score += t.dangerous * 0.065;
  score += t.possession * 0.025;

  if (t.shotsOn >= 3) score += 0.7;
  if (t.corners >= 3) score += 0.5;
  if (minute >= 30 && minute <= 44) score += 0.4;
  if (minute >= 55 && minute <= 75) score += 0.6;

  return Number(score.toFixed(1));
}

function totalPressure(total, minute) {
  let score = 0;

  score += total.shots * 0.25;
  score += total.shotsOn * 1.30;
  score += total.shotsOff * 0.20;
  score += total.insideBox * 0.55;
  score += total.corners * 0.70;
  score += total.dangerous * 0.06;

  if (total.shots >= 10) score += 0.6;
  if (total.shotsOn >= 4) score += 0.9;
  if (total.corners >= 4) score += 0.7;
  if (minute >= 30 && minute <= 44) score += 0.7;
  if (minute >= 55 && minute <= 75) score += 0.9;

  return Number(score.toFixed(1));
}

function momentumScore(delta) {
  if (!delta) return 0;

  const score =
    delta.shots * 0.6 +
    delta.shotsOn * 1.6 +
    delta.corners * 1.2 +
    delta.insideBox * 0.8 +
    delta.dangerous * 0.12;

  return Number(score.toFixed(1));
}

function momentumLabel(score) {
  if (score >= 5) return "🔥 Çok güçlü";
  if (score >= 3) return "🟢 Güçlü";
  if (score >= 1.5) return "🟡 Orta";
  if (score > 0) return "🔴 Zayıf";
  return "İlk ölçüm";
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

  if (score >= 4) return { label: "Yüksek", note: "Veriler yeterli" };
  if (score >= 2) return { label: "Orta", note: notes.join(", ") };
  return { label: "Düşük", note: notes.join(", ") || "API verisi yetersiz" };
}

function leadingSide(homePressure, awayPressure) {
  if (homePressure >= awayPressure + 2.5) return "Ev";
  if (awayPressure >= homePressure + 2.5) return "Deplasman";
  return "Dengeli";
}

function neededGoalsForMarket(market, homeGoals, awayGoals) {
  const total = homeGoals + awayGoals;

  if (market === "İlk Yarı 0.5 ÜST") return Math.max(0, 1 - total);
  if (market === "İlk Yarı 1.5 ÜST") return Math.max(0, 2 - total);

  if (market === "İlk Yarı Ev 0.5 ÜST") return Math.max(0, 1 - homeGoals);
  if (market === "İlk Yarı Ev 1.5 ÜST") return Math.max(0, 2 - homeGoals);
  if (market === "İlk Yarı Dep 0.5 ÜST") return Math.max(0, 1 - awayGoals);
  if (market === "İlk Yarı Dep 1.5 ÜST") return Math.max(0, 2 - awayGoals);

  if (market === "Maç Sonu 0.5 ÜST") return Math.max(0, 1 - total);
  if (market === "Maç Sonu 1.5 ÜST") return Math.max(0, 2 - total);
  if (market === "Maç Sonu 2.5 ÜST") return Math.max(0, 3 - total);
  if (market === "Maç Sonu 3.5 ÜST") return Math.max(0, 4 - total);

  if (market === "Sıradaki Gol Ev") return 1;
  if (market === "Sıradaki Gol Deplasman") return 1;

  return 99;
}

function marketCandidates({
  minute,
  homeGoals,
  awayGoals,
  totalGoals,
  homePressure,
  awayPressure,
  totalPress,
  side,
  momentum,
  homeStats,
  awayStats,
  totalStats
}) {
  const markets = [];

  const add = (name, baseScore, reason) => {
    markets.push({
      name,
      score: Number(baseScore.toFixed(1)),
      reason
    });
  };

  const homeStrong = homePressure >= 8.5 && homePressure >= awayPressure + 2.0;
  const awayStrong = awayPressure >= 8.5 && awayPressure >= homePressure + 2.0;

  // 0-45: İlk yarı marketleri
  if (minute >= 1 && minute <= 45) {
    if (totalGoals === 0 && minute >= 18 && minute <= 42 && totalPress >= 7) {
      add(
        "İlk Yarı 0.5 ÜST",
        totalPress + momentum,
        "İlk yarıda gol için baskı ve tempo var"
      );
    }

    if (totalGoals === 1 && minute >= 20 && minute <= 40 && totalPress >= 9.5) {
      add(
        "İlk Yarı 1.5 ÜST",
        totalPress + momentum - 0.8,
        "İlk yarıda ikinci gol için tempo yüksek"
      );
    }

    if (homeGoals === 0 && minute >= 15 && minute <= 42 && homeStrong) {
      add(
        "İlk Yarı Ev 0.5 ÜST",
        homePressure + momentum,
        "Ev sahibi baskısı ilk yarı gol için öne çıkıyor"
      );
    }

    if (awayGoals === 0 && minute >= 15 && minute <= 42 && awayStrong) {
      add(
        "İlk Yarı Dep 0.5 ÜST",
        awayPressure + momentum,
        "Deplasman baskısı ilk yarı gol için öne çıkıyor"
      );
    }

    if (homeGoals <= 1 && minute >= 20 && minute <= 40 && homePressure >= 11.5) {
      add(
        "İlk Yarı Ev 1.5 ÜST",
        homePressure + momentum - 1.0,
        "Ev sahibi çok baskılı, ilk yarıda 2. gol ihtimali aranıyor"
      );
    }

    if (awayGoals <= 1 && minute >= 20 && minute <= 40 && awayPressure >= 11.5) {
      add(
        "İlk Yarı Dep 1.5 ÜST",
        awayPressure + momentum - 1.0,
        "Deplasman çok baskılı, ilk yarıda 2. gol ihtimali aranıyor"
      );
    }
  }

  // 45-90: Maç sonu marketleri
  if (minute >= 46 && minute <= 90) {
    if (totalGoals === 0 && minute <= 80 && totalPress >= 7.5) {
      add(
        "Maç Sonu 0.5 ÜST",
        totalPress + momentum,
        "Maçta ilk gol için baskı oluşuyor"
      );
    }

    if (totalGoals <= 1 && minute <= 78 && totalPress >= 8.5) {
      add(
        "Maç Sonu 1.5 ÜST",
        totalPress + momentum,
        "Maç sonu 1.5 üst için tempo yeterli"
      );
    }

    if (totalGoals === 2 && minute <= 80 && totalPress >= 8.8) {
      add(
        "Maç Sonu 2.5 ÜST",
        totalPress + momentum,
        "Bir gol daha gerekiyor, maç baskılı"
      );
    }

    if (totalGoals === 3 && minute <= 75 && totalPress >= 10) {
      add(
        "Maç Sonu 3.5 ÜST",
        totalPress + momentum - 0.5,
        "Dördüncü gol için tempo yüksek"
      );
    }

    if (homeStrong && minute <= 85) {
      add(
        "Sıradaki Gol Ev",
        homePressure + momentum,
        "Ev sahibi baskısı sıradaki gol için önde"
      );
    }

    if (awayStrong && minute <= 85) {
      add(
        "Sıradaki Gol Deplasman",
        awayPressure + momentum,
        "Deplasman baskısı sıradaki gol için önde"
      );
    }
  }

  return markets.sort((a, b) => b.score - a.score);
}

function decisionForBestMarket({
  best,
  minute,
  homeGoals,
  awayGoals,
  totalGoals,
  totalStats,
  side,
  momentumScoreValue,
  dataConf
}) {
  if (!best) {
    return {
      send: false,
      level: "PAS",
      karar: "❌ PAS",
      risk: "Yüksek",
      stake: "Girme",
      comment: "Uygun market bulunmadı."
    };
  }

  const need = neededGoalsForMarket(best.name, homeGoals, awayGoals);
  const reasons = [];
  const risks = [];

  if (best.score >= MIN_ELITE) reasons.push("Market skoru elite seviyede");
  if (totalStats.shots >= 8) reasons.push("Şut hacmi iyi");
  if (totalStats.shotsOn >= 3) reasons.push("İsabetli şut desteği var");
  if (totalStats.corners >= 3) reasons.push("Korner baskısı var");
  if (totalStats.insideBox >= 4) reasons.push("Ceza sahası içi deneme var");
  if (totalStats.dangerous >= 20) reasons.push("Tehlikeli atak desteği var");
  if (momentumScoreValue >= 3) reasons.push("Son tur momentum artışı var");
  if (side !== "Dengeli") reasons.push("Baskı yönü net");

  if (dataConf.label === "Düşük") risks.push("Veri güveni düşük");
  if (totalStats.dangerous === 0) risks.push("Tehlikeli atak verisi 0; API eksik gösterebilir");
  if (need >= 2 && minute >= 65) risks.push("Dakika ilerledi, 2+ gol gerekiyor");
  if (side === "Dengeli" && best.name.includes("Sıradaki Gol")) risks.push("Sıradaki gol için taraf net değil");

  if (need >= 3) {
    return {
      send: false,
      level: "PAS",
      karar: "❌ PAS",
      risk: "Çok yüksek",
      stake: "Girme",
      comment: "Bu market için çok fazla gol gerekiyor."
    };
  }

  if (best.score >= MIN_ELITE && need <= 1 && dataConf.label !== "Düşük") {
    return {
      send: true,
      level: "💰🔥 ELITE",
      karar: "✅ GİRİLEBİLİR",
      risk: risks.length ? "Orta" : "Orta-düşük",
      stake: "%1 - %2 kasa",
      comment: `${best.reason}. ${reasons.join(", ")}${risks.length ? ". Risk: " + risks.join(", ") : ""}`
    };
  }

  if (best.score >= MIN_GIR && need <= 1) {
    return {
      send: true,
      level: "💰🟢 NORMAL",
      karar: "⚠️ KONTROLLÜ / DÜŞÜK STAKE",
      risk: "Orta-yüksek",
      stake: "%0.5 - %1 kasa",
      comment: `${best.reason}. ${reasons.join(", ")}${risks.length ? ". Risk: " + risks.join(", ") : ""}`
    };
  }

  if (best.score >= MIN_RADAR) {
    return {
      send: true,
      level: "⚠️ RADAR",
      karar: "👀 İZLE",
      risk: "Orta",
      stake: "Girme, takip et",
      comment: `${best.reason}. ${reasons.join(", ")}${risks.length ? ". Risk: " + risks.join(", ") : ""}`
    };
  }

  return {
    send: false,
    level: "PAS",
    karar: "❌ PAS",
    risk: "Yüksek",
    stake: "Girme",
    comment: "Baskı ve market skoru yeterli değil."
  };
}

function shouldSend(key, minutes = 12) {
  const last = sent.get(key) || 0;
  if (Date.now() - last < minutes * 60 * 1000) return false;
  sent.set(key, Date.now());
  return true;
}

async function analyze() {
  console.log("🔎 LIVE INTELLIGENCE taraması başladı...");

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

    const minute = m.fixture.status.elapsed;

    if (!minute || minute < 1 || minute > 90) {
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
    const momentumDelta = old ? diff(totalStats, old.totalStats) : null;
    memory.set(m.fixture.id, { totalStats, minute });

    const homePress = teamPressure(homeStats, minute);
    const awayPress = teamPressure(awayStats, minute);
    const totalPress = totalPressure(totalStats, minute);
    const side = leadingSide(homePress, awayPress);
    const momScore = momentumScore(momentumDelta);
    const dataConf = dataConfidence(totalStats);

    const markets = marketCandidates({
      minute,
      homeGoals,
      awayGoals,
      totalGoals,
      homePressure: homePress,
      awayPressure: awayPress,
      totalPress,
      side,
      momentum: momScore,
      homeStats,
      awayStats,
      totalStats
    });

    const best = markets[0];

    const decision = decisionForBestMarket({
      best,
      minute,
      homeGoals,
      awayGoals,
      totalGoals,
      totalStats,
      side,
      momentumScoreValue: momScore,
      dataConf
    });

    if (!decision.send) {
      pas++;
      continue;
    }

    const need = neededGoalsForMarket(best.name, homeGoals, awayGoals);

    const key = `${m.fixture.id}_${best.name}_${decision.karar}`;
    if (!shouldSend(key, decision.karar.includes("GİR") ? 15 : 10)) continue;

    const topMarkets = markets
      .slice(0, 3)
      .map((x, i) => `${i + 1}) ${x.name} | Skor: ${x.score}`)
      .join("\n");

    const msg = `
${decision.level} <b>CANLI DERİN ANALİZ</b>

⚽ <b>${homeName} - ${awayName}</b>
🌍 <b>${country} / ${league}</b>
⏱ <b>Dakika:</b> ${minute}
📊 <b>Skor:</b> ${homeGoals}-${awayGoals}

🎯 <b>Önerilen Market:</b> ${best.name}
🥅 <b>Gereken Gol:</b> ${need}
➡️ <b>Baskı Yönü:</b> ${side}

<b>BASKI OKUMASI</b>
🏠 Ev Baskı: ${homePress}/10
✈️ Dep Baskı: ${awayPress}/10
📈 Toplam Baskı: ${totalPress}/10
🧭 Momentum: ${momentumLabel(momScore)} (${momScore})
🛡 Veri Güveni: ${dataConf.label}
📌 Veri Notu: ${dataConf.note}

<b>EV SAHİBİ İSTATİSTİK</b>
📍 Şut: ${homeStats.shots}
🎯 İsabet: ${homeStats.shotsOn}
📤 İsabetsiz: ${homeStats.shotsOff}
📦 Ceza İçi Şut: ${homeStats.insideBox}
🚩 Korner: ${homeStats.corners}
⚡ Tehlikeli Atak: ${homeStats.dangerous}
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
🟨 Sarı: ${awayStats.yellow}
🟥 Kırmızı: ${awayStats.red}
⚽ Topa Sahip Olma: ${awayStats.possession}%

<b>SON TUR MOMENTUM</b>
📍 Şut Artışı: ${momentumDelta ? momentumDelta.shots : "İlk ölçüm"}
🎯 İsabet Artışı: ${momentumDelta ? momentumDelta.shotsOn : "İlk ölçüm"}
🚩 Korner Artışı: ${momentumDelta ? momentumDelta.corners : "İlk ölçüm"}
⚡ Tehlikeli Atak Artışı: ${momentumDelta ? momentumDelta.dangerous : "İlk ölçüm"}

<b>EN İYİ MARKETLER</b>
${topMarkets}

🧠 <b>NET KARAR:</b> ${decision.karar}
⚠️ <b>Risk:</b> ${decision.risk}
💰 <b>Stake:</b> ${decision.stake}

📝 <b>Bot Yorumu:</b>
${decision.comment}

⚠️ <b>Not:</b> Garanti değildir. Tek maça yüksek kasa riski alma.
`;

    await sendTelegram(msg);
    sentCount++;
  }

  console.log(
    `📊 ÖZET → Bakıldı:${checked} | StatsYok:${statsYok} | Gönderildi:${sentCount} | Pas:${pas}`
  );
}

console.log("🤖 MEZBAHANE LIVE INTELLIGENCE AKTİF ✅");
await sendTelegram(
  "🤖 MEZBAHANE LIVE INTELLIGENCE AKTİF ✅\n0-90 canlı derin analiz + market seçimi çalışıyor."
);

await analyze();

setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.log("Ana hata:", err.message);
  }
}, POLL_INTERVAL);