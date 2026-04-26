require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 120);
const DEFAULT_ODDS = Number(process.env.DEFAULT_ODDS || 1.80);

const MIN_WARNING = 6.5;
const MIN_EARLY = 7.4;
const MIN_NORMAL = 8.0;
const MIN_ELITE = 8.7;

let memory = {};
let lastSent = {};
let activeSignals = {};
let lastStatsUpdateId = 0;
let statsSupportedLeagues = new Set();

let performance = {
  total: 0,
  win: 0,
  lose: 0
};

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

async function loadCoverage() {
  try {
    const res = await axios.get("https://v3.football.api-sports.io/leagues", {
      headers: { "x-apisports-key": API_KEY }
    });

    const leagues = res.data.response || [];
    statsSupportedLeagues.clear();

    for (const item of leagues) {
      const leagueId = item.league?.id;

      const hasStats =
        item.seasons &&
        item.seasons[0] &&
        item.seasons[0].coverage &&
        item.seasons[0].coverage.fixtures &&
        item.seasons[0].coverage.fixtures.statistics === true;

      if (leagueId && hasStats) {
        statsSupportedLeagues.add(leagueId);
      }
    }

    console.log(`Coverage yüklendi: ${leagues.length} lig`);
    console.log(`Stats destekleyen lig: ${statsSupportedLeagues.size}`);
  } catch (err) {
    console.log("Coverage yükleme hatası:", err.response?.data || err.message);
  }
}

function badLeague(leagueName = "") {
  const bad = [
    "U19", "U20", "U21", "U23",
    "Youth", "Reserve", "Reserves",
    "Women", "Friendly", "Club Friendlies",
    "Amateur", "Regional"
  ];

  return bad.some(x => leagueName.toLowerCase().includes(x.toLowerCase()));
}

function getStat(stats, type) {
  const raw = stats.find(x => x.type === type)?.value;

  if (raw === null || raw === undefined) return 0;

  if (typeof raw === "string" && raw.includes("%")) {
    return Number(raw.replace("%", "")) || 0;
  }

  return Number(raw) || 0;
}

function extractTeamStats(teamStats) {
  const s = teamStats?.statistics || [];

  return {
    shots: getStat(s, "Total Shots"),
    shotsOn: getStat(s, "Shots on Goal"),
    shotsOff: getStat(s, "Shots off Goal"),
    corners: getStat(s, "Corner Kicks"),
    possession: getStat(s, "Ball Possession"),
    dangerous: getStat(s, "Dangerous Attacks")
  };
}

function diff(now, old) {
  return {
    shots: now.shots - old.shots,
    shotsOn: now.shotsOn - old.shotsOn,
    shotsOff: now.shotsOff - old.shotsOff,
    corners: now.corners - old.corners,
    dangerous: now.dangerous - old.dangerous
  };
}

function total(a, b) {
  return {
    shots: a.shots + b.shots,
    shotsOn: a.shotsOn + b.shotsOn,
    shotsOff: a.shotsOff + b.shotsOff,
    corners: a.corners + b.corners,
    dangerous: a.dangerous + b.dangerous
  };
}

function pressureScore(d) {
  return (
    d.shots * 1.2 +
    d.shotsOn * 3.2 +
    d.shotsOff * 0.8 +
    d.corners * 2.2 +
    d.dangerous * 0.35
  );
}

function chooseSide(homeDiff, awayDiff) {
  const h = pressureScore(homeDiff);
  const a = pressureScore(awayDiff);

  if (h >= a + 4) return { side: "Ev", score: h };
  if (a >= h + 4) return { side: "Deplasman", score: a };

  return { side: "Dengeli", score: Math.max(h, a) };
}

function validMomentum(totalDiff) {
  if (totalDiff.shots < 2) return false;
  if (totalDiff.shotsOn < 1 && totalDiff.corners < 1) return false;
  if (totalDiff.dangerous < 6) return false;

  return true;
}

function confidence(minute, homeGoals, awayGoals, totalDiff, dominant) {
  let c = 5;

  c += totalDiff.shots * 0.35;
  c += totalDiff.shotsOn * 0.9;
  c += totalDiff.corners * 0.55;
  c += totalDiff.dangerous * 0.08;

  if (dominant.side !== "Dengeli") c += 0.6;
  if (totalDiff.shotsOn >= 2) c += 0.7;
  if (totalDiff.corners >= 2) c += 0.4;
  if (totalDiff.dangerous >= 14) c += 0.5;

  const goals = homeGoals + awayGoals;

  if (minute >= 18 && minute <= 44 && goals === 0) c += 0.5;
  if (minute >= 50 && minute <= 78) c += 0.4;
  if (minute > 82) c -= 0.8;

  return Math.min(10, Math.max(0, Number(c.toFixed(1))));
}

function selectMarket(minute, homeGoals, awayGoals, totalDiff, dominant) {
  const goals = homeGoals + awayGoals;

  if (minute >= 12 && minute <= 45) {
    if (goals === 0) return "İlk Yarı 0.5 ÜST";

    if (
      goals === 1 &&
      minute <= 42 &&
      totalDiff.shots >= 4 &&
      totalDiff.shotsOn >= 2 &&
      totalDiff.dangerous >= 12
    ) {
      return "İlk Yarı 1.5 ÜST";
    }

    if (dominant.side === "Ev") return "Sıradaki Gol Ev";
    if (dominant.side === "Deplasman") return "Sıradaki Gol Deplasman";
  }

  if (minute >= 46 && minute <= 90) {
    if (goals === 0) return "Maç Sonu 1.5 ÜST";
    if (goals === 1) return "Maç Sonu 1.5 ÜST";
    if (goals === 2) return "Maç Sonu 2.5 ÜST";
    if (goals === 3) return "Maç Sonu 3.5 ÜST";
    if (goals === 4) return "Maç Sonu 4.5 ÜST";

    if (dominant.side === "Ev") return "Sıradaki Gol Ev";
    if (dominant.side === "Deplasman") return "Sıradaki Gol Deplasman";
  }

  return null;
}

function signalType(conf) {
  if (conf >= MIN_ELITE) return "🔥 ELITE";
  if (conf >= MIN_NORMAL) return "🟢 NORMAL";
  if (conf >= MIN_EARLY) return "⚡ ERKEN";
  return null;
}

function probabilityFromConfidence(conf) {
  return Math.min(80, Math.max(50, Number((conf * 8).toFixed(1))));
}

function impliedProbability(odds) {
  return Number((100 / odds).toFixed(1));
}

function valuePercent(botProb, bookProb) {
  return Number((botProb - bookProb).toFixed(1));
}

function botView(type, dominant, totalDiff, value) {
  const sideText =
    dominant.side === "Dengeli"
      ? "İki takımda da tempo yükseldi"
      : `Momentum ${dominant.side} tarafına geçti`;

  if (type === "⚠️ TAKİP") {
    return `${sideText}. Baskı oluşmaya başladı ama henüz giriş seviyesi değil. Son periyotta ${totalDiff.shots} şut, ${totalDiff.shotsOn} isabetli şut, ${totalDiff.corners} korner ve ${totalDiff.dangerous} tehlikeli atak artışı var.`;
  }

  if (type === "⚡ ERKEN") {
    return `${sideText}. Erken sinyal: son periyotta ${totalDiff.shots} şut, ${totalDiff.shotsOn} isabetli şut, ${totalDiff.corners} korner ve ${totalDiff.dangerous} tehlikeli atak artışı var. Gol baskısı yeni oluşuyor. Value farkı: %${value}.`;
  }

  return `${sideText}. Son periyotta ${totalDiff.shots} şut, ${totalDiff.shotsOn} isabetli şut, ${totalDiff.corners} korner ve ${totalDiff.dangerous} tehlikeli atak artışı var. API verisi gol baskısının yükseldiğini gösteriyor. Value farkı: %${value}.`;
}

async function checkPerformance(matches) {
  for (const sid in activeSignals) {
    const sig = activeSignals[sid];
    const match = matches.find(x => String(x.fixture.id) === String(sid));

    if (!match) continue;

    const nowMinute = match.fixture.status.elapsed;
    const newHome = Number(match.goals.home || 0);
    const newAway = Number(match.goals.away || 0);

    const oldTotal = sig.homeGoals + sig.awayGoals;
    const newTotal = newHome + newAway;

    if (newTotal > oldTotal) {
      const diffMin = nowMinute - sig.minute;

      performance.win++;

      await sendTelegram(`
🎯 <b>SONUÇ: WIN</b>

<b>Maç:</b> ${sig.home} - ${sig.away}
<b>Sinyal:</b> ${sig.type}
<b>Market:</b> ${sig.market}
⏱️ <b>Gol Süresi:</b> ${diffMin} dk
`);

      delete activeSignals[sid];
      continue;
    }

    if (nowMinute - sig.minute >= 20) {
      performance.lose++;

      await sendTelegram(`
❌ <b>SONUÇ: LOSE</b>

<b>Maç:</b> ${sig.home} - ${sig.away}
<b>Sinyal:</b> ${sig.type}
<b>Market:</b> ${sig.market}
`);

      delete activeSignals[sid];
    }
  }
}

async function fetchLiveMatches() {
  try {
    const fixtures = await axios.get(
      "https://v3.football.api-sports.io/fixtures?live=all",
      {
        headers: { "x-apisports-key": API_KEY }
      }
    );

    const matches = fixtures.data.response || [];

    let skippedNoCoverage = 0;
    let skippedBadLeague = 0;
    let skippedNoStats = 0;
    let checkedStats = 0;

    console.log(`API TEST: ${matches.length} canlı maç bulundu.`);

    await checkPerformance(matches);

    for (const m of matches) {
      const id = m.fixture.id;
      const minute = m.fixture.status.elapsed;
      const leagueId = m.league.id;
      const league = m.league.name;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const homeGoals = Number(m.goals.home || 0);
      const awayGoals = Number(m.goals.away || 0);

      if (!minute || minute < 8 || minute > 90) continue;

      if (badLeague(league)) {
        skippedBadLeague++;
        continue;
      }

      if (!statsSupportedLeagues.has(leagueId)) {
        skippedNoCoverage++;
        continue;
      }

      if (!((minute >= 12 && minute <= 45) || (minute >= 46 && minute <= 90))) {
        continue;
      }

      checkedStats++;

      const statsRes = await axios.get(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        {
          headers: { "x-apisports-key": API_KEY }
        }
      );

      const stats = statsRes.data.response || [];

      if (stats.length < 2) {
        skippedNoStats++;
        continue;
      }

      const homeNow = extractTeamStats(stats[0]);
      const awayNow = extractTeamStats(stats[1]);

      const now = {
        minute,
        home: homeNow,
        away: awayNow,
        total: total(homeNow, awayNow)
      };

      const old = memory[id];
      memory[id] = now;

      if (!old) continue;

      const homeDiff = diff(homeNow, old.home);
      const awayDiff = diff(awayNow, old.away);
      const totalDiff = total(homeDiff, awayDiff);

      if (!validMomentum(totalDiff)) continue;

      const dominant = chooseSide(homeDiff, awayDiff);

      const market = selectMarket(
        minute,
        homeGoals,
        awayGoals,
        totalDiff,
        dominant
      );

      if (!market) continue;

      const conf = confidence(
        minute,
        homeGoals,
        awayGoals,
        totalDiff,
        dominant
      );

      const odds = DEFAULT_ODDS;
      const botProb = probabilityFromConfidence(conf);
      const bookProb = impliedProbability(odds);
      const value = valuePercent(botProb, bookProb);
      const isValue = value >= 5;

      const type = signalType(conf);

      if (!type && conf >= MIN_WARNING) {
        const lastWarn = lastSent[id + "_warn"] || 0;
        if (Date.now() - lastWarn < 10 * 60 * 1000) continue;

        lastSent[id + "_warn"] = Date.now();

        const warnMsg = `
⚠️ <b>TAKİP ET</b>

<b>Maç:</b> ${home} - ${away}
<b>Lig:</b> ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market Adayı:</b> ${market}
<b>Yön:</b> ${dominant.side}
<b>Güven:</b> ${conf}/10

🤖 <b>Bot Görüşü:</b>
${botView("⚠️ TAKİP", dominant, totalDiff, value)}
`;

        await sendTelegram(warnMsg);
        console.log(`UYARI: ${home} - ${away} | ${conf}/10`);
        continue;
      }

      if (!type) continue;

      const last = lastSent[id] || 0;
      if (Date.now() - last < 10 * 60 * 1000) continue;

      lastSent[id] = Date.now();

      const msg = `
${type} <b>GİR</b>

<b>Maç:</b> ${home} - ${away}
<b>Lig:</b> ${league}
<b>Dakika:</b> ${minute}
<b>Skor:</b> ${homeGoals}-${awayGoals}
<b>Market:</b> ${market}
<b>Yön:</b> ${dominant.side}
<b>Güven:</b> ${conf}/10

💰 <b>Oran:</b> ${odds}
📊 <b>Bot İhtimal:</b> %${botProb}
📉 <b>Book İhtimal:</b> %${bookProb}
🔥 <b>Value:</b> %${value} ${isValue ? "✅" : "❌"}

🤖 <b>Bot Görüşü:</b>
${botView(type, dominant, totalDiff, value)}
`;

      await sendTelegram(msg);

      activeSignals[id] = {
        minute,
        homeGoals,
        awayGoals,
        time: Date.now(),
        type,
        market,
        home,
        away
      };

      performance.total++;

      console.log(
        `SİNYAL: ${home} - ${away} | ${type} | ${market} | ${conf}/10 | Value: %${value}`
      );
    }

    console.log(
      `ÖZET → BadLeague:${skippedBadLeague} | CoverageYok:${skippedNoCoverage} | StatsBakıldı:${checkedStats} | StatsYok:${skippedNoStats}`
    );
  } catch (err) {
    console.log("HATA:", err.response?.data || err.message);
  }
}

async function initStatsOffset() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates`);
    const updates = res.data.result || [];

    if (updates.length > 0) {
      lastStatsUpdateId = updates[updates.length - 1].update_id;
      console.log("Eski Telegram komutları temizlendi.");
    }
  } catch (err) {
    console.log("Offset başlatma hatası:", err.message);
  }
}

async function checkStatsCommand() {
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastStatsUpdateId + 1}`
    );

    const updates = res.data.result || [];

    for (const update of updates) {
      lastStatsUpdateId = update.update_id;

      if (update.message?.text === "/stats") {
        const winRate = performance.total
          ? ((performance.win / performance.total) * 100).toFixed(1)
          : 0;

        await sendTelegram(`
📊 <b>PERFORMANS</b>

Toplam Sinyal: ${performance.total}
WIN: ${performance.win}
LOSE: ${performance.lose}
Başarı: %${winRate}
`);
      }
    }
  } catch (err) {
    console.log("Stats komut hatası:", err.message);
  }
}

console.log("PRO COVERAGE + UYARI BOT çalışıyor...");

setTimeout(() => {
  sendTelegram("✅ BOT TEST: Telegram bağlantısı çalışıyor.")
    .then(() => console.log("Telegram test mesajı gönderildi."))
    .catch(err =>
      console.log("Telegram test hatası:", err.response?.data || err.message)
    );
}, 10000);

async function startBot() {
  await loadCoverage();
  await initStatsOffset();

  fetchLiveMatches();

  setInterval(fetchLiveMatches, POLL_SECONDS * 1000);
  setInterval(checkStatsCommand, 15000);
}

startBot();