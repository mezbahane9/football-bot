require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ⏱️ Daha canlı takip (API limitine göre 60–90 arası öneririm)
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const DEFAULT_ODDS = Number(process.env.DEFAULT_ODDS || 1.80);

// 🎯 Para modu eşikleri
const MIN_NORMAL = 8.0;
const MIN_ELITE = 8.7;
const MIN_VALUE = 6;

// ⭐ VIP ligler (geniş ama kaliteli set)
const VIP_LEAGUES = [
  "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1",
  "Süper Lig", "Eredivisie", "Primeira Liga",
  "Brasileirão", "Serie A Brazil", "Argentina", "Liga Profesional",
  "MLS", "Championship", "Belgium", "Jupiler Pro League",
  "Austria", "Super League", "Denmark", "Superliga",
  "Switzerland", "Super League", "Norway", "Eliteserien",
  "Sweden", "Allsvenskan"
];

let memory = {};
let lastSent = {};
let activeSignals = {};
let lastStatsUpdateId = 0;

let performance = { total: 0, win: 0, lose: 0 };

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

// ❌ çöp ligleri ele
function badLeague(name = "") {
  const bad = ["U19","U20","U21","U23","Youth","Reserve","Women","Friendly","Amateur","Regional"];
  return bad.some(x => name.toLowerCase().includes(x.toLowerCase()));
}

// ⭐ VIP kontrol
function isVipLeague(name = "") {
  return VIP_LEAGUES.some(l => name.toLowerCase().includes(l.toLowerCase()));
}

function getStat(stats, type) {
  const raw = stats.find(x => x.type === type)?.value;
  if (raw == null) return 0;
  if (typeof raw === "string" && raw.includes("%")) return Number(raw.replace("%","")) || 0;
  return Number(raw) || 0;
}

function extractTeamStats(teamStats) {
  const s = teamStats?.statistics || [];
  return {
    shots: getStat(s,"Total Shots"),
    shotsOn: getStat(s,"Shots on Goal"),
    shotsOff: getStat(s,"Shots off Goal"),
    corners: getStat(s,"Corner Kicks"),
    dangerous: getStat(s,"Dangerous Attacks")
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

function total(a,b){
  return {
    shots: a.shots + b.shots,
    shotsOn: a.shotsOn + b.shotsOn,
    shotsOff: a.shotsOff + b.shotsOff,
    corners: a.corners + b.corners,
    dangerous: a.dangerous + b.dangerous
  };
}

// 💣 para modu momentum (sert)
function validMoneyMomentum(t){
  if (t.shots < 3) return false;
  if (t.shotsOn < 2) return false;
  if (t.dangerous < 10) return false;
  return true;
}

function pressureScore(d){
  return d.shots*1.2 + d.shotsOn*3.2 + d.shotsOff*0.8 + d.corners*2.2 + d.dangerous*0.35;
}

function chooseSide(h,a){
  const hs = pressureScore(h);
  const as = pressureScore(a);
  if (hs >= as + 4) return "Ev";
  if (as >= hs + 4) return "Deplasman";
  return "Dengeli";
}

function confidence(min, hg, ag, t, side){
  let c = 5;
  c += t.shots*0.35 + t.shotsOn*0.95 + t.corners*0.55 + t.dangerous*0.08;

  if (side !== "Dengeli") c += 0.6;
  if (t.shotsOn >= 3) c += 0.8;
  if (t.dangerous >= 15) c += 0.5;

  const goals = hg + ag;

  // 0–45 boost
  if (min >= 18 && min <= 40 && goals === 0) c += 0.6;

  // 45–90 boost
  if (min >= 50 && min <= 75) c += 0.4;

  if (min > 75) c -= 1.0;

  return Math.min(10, Math.max(0, Number(c.toFixed(1))));
}

// 🎯 iki ayrı motor
function selectMarket(min, hg, ag, t, side){
  const goals = hg + ag;

  // 🟡 0–45 motoru (ilk yarı)
  if (min >= 15 && min <= 40 && goals === 0){
    return "İlk Yarı 0.5 ÜST";
  }

  // 🔵 45–90 motoru (maç sonu)
  if (min >= 50 && min <= 75){
    if (goals <= 1) return "Maç Sonu 1.5 ÜST";
    if (goals === 2) return "Maç Sonu 2.5 ÜST";
    if (goals === 3) return "Maç Sonu 3.5 ÜST";
  }

  return null;
}

function signalType(c){
  if (c >= MIN_ELITE) return "🔥 ELITE";
  if (c >= MIN_NORMAL) return "🟢 NORMAL";
  return null;
}

function probability(c){ return Math.min(80, Math.max(50, c*8)); }
function implied(o){ return 100/o; }
function value(b, bk){ return Number((b-bk).toFixed(1)); }

async function fetchLiveMatches(){
  try{
    const res = await axios.get("https://v3.football.api-sports.io/fixtures?live=all",{
      headers:{ "x-apisports-key": API_KEY }
    });

    const matches = res.data.response || [];
    console.log(`API TEST: ${matches.length} canlı maç`);

    for (const m of matches){
      const id = m.fixture.id;
      const min = m.fixture.status.elapsed;
      const league = m.league.name;
      const home = m.teams.home.name;
      const away = m.teams.away.name;
      const hg = Number(m.goals.home||0);
      const ag = Number(m.goals.away||0);

      if (!min || min < 12 || min > 75) continue;

      if (badLeague(league)) continue;
      if (!isVipLeague(league)) continue; // ⭐ VIP aktif

      const statsRes = await axios.get(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
        { headers:{ "x-apisports-key": API_KEY } }
      );

      const stats = statsRes.data.response || [];
      if (stats.length < 2) continue;

      const hNow = extractTeamStats(stats[0]);
      const aNow = extractTeamStats(stats[1]);

      const now = { minute:min, home:hNow, away:aNow, total: total(hNow,aNow) };
      const old = memory[id];
      memory[id] = now;
      if (!old) continue;

      const hDiff = diff(hNow, old.home);
      const aDiff = diff(aNow, old.away);
      const tDiff = total(hDiff,aDiff);

      if (!validMoneyMomentum(tDiff)) continue;

      const side = chooseSide(hDiff,aDiff);
      const market = selectMarket(min,hg,ag,tDiff,side);
      if (!market) continue;

      const conf = confidence(min,hg,ag,tDiff,side);
      const type = signalType(conf);
      if (!type) continue;

      const botProb = probability(conf);
      const bookProb = implied(DEFAULT_ODDS);
      const val = value(botProb, bookProb);
      if (val < MIN_VALUE) continue;

      const last = lastSent[id] || 0;
      if (Date.now() - last < 10*60*1000) continue;
      lastSent[id] = Date.now();

      await sendTelegram(`
💰 ${type} <b>VIP GİR</b>

<b>Maç:</b> ${home} - ${away}
<b>Lig:</b> ${league}
<b>Dakika:</b> ${min}
<b>Skor:</b> ${hg}-${ag}
<b>Market:</b> ${market}
<b>Yön:</b> ${side}
<b>Güven:</b> ${conf}/10

💰 <b>Oran:</b> ${DEFAULT_ODDS}
🔥 <b>Value:</b> %${val}
`);

      console.log(`SİNYAL: ${home}-${away} | ${market} | ${conf} | %${val}`);
    }

  }catch(err){
    console.log("HATA:", err.response?.data || err.message);
  }
}

async function start(){
  fetchLiveMatches();
  setInterval(fetchLiveMatches, POLL_SECONDS*1000);
}

console.log("💰 VIP PARA BOTU aktif...");
start();