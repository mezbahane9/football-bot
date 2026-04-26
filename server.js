require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 120);

const MIN_EARLY = 7.4;
const MIN_NORMAL = 8.0;
const MIN_ELITE = 8.7;

const DEFAULT_ODDS = 1.80;

let memory = {};
let lastSent = {};
let activeSignals = {};
let performance = { total: 0, win: 0, lose: 0 };

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML"
  });
}

function badLeague(name="") {
  return ["U19","U20","U21","U23","Youth","Reserve","Women","Friendly"]
    .some(x => name.toLowerCase().includes(x.toLowerCase()));
}

function getStat(stats, type) {
  const v = stats.find(x => x.type === type)?.value;
  if (!v) return 0;
  if (typeof v === "string") return Number(v.replace("%","")) || 0;
  return Number(v);
}

function extract(t) {
  const s = t.statistics || [];
  return {
    shots: getStat(s,"Total Shots"),
    shotsOn: getStat(s,"Shots on Goal"),
    corners: getStat(s,"Corner Kicks"),
    dangerous: getStat(s,"Dangerous Attacks")
  };
}

function diff(a,b){
  return {
    shots:a.shots-b.shots,
    shotsOn:a.shotsOn-b.shotsOn,
    corners:a.corners-b.corners,
    dangerous:a.dangerous-b.dangerous
  }
}

function valid(d){
  if(d.shots<2){console.log("❌ Momentum zayıf");return false}
  if(d.shotsOn<1 && d.corners<1){console.log("❌ İsabet/korn yok");return false}
  if(d.dangerous<6){console.log("❌ Tehlikeli atak az");return false}
  return true;
}

function confidence(d){
  let c=5;
  c+=d.shots*0.3;
  c+=d.shotsOn*1;
  c+=d.corners*0.5;
  c+=d.dangerous*0.08;
  return Math.min(10,c);
}

function signalType(c){
  if(c>=MIN_ELITE) return "🔥 ELITE";
  if(c>=MIN_NORMAL) return "🟢 NORMAL";
  if(c>=MIN_EARLY) return "⚡ ERKEN";
  console.log("❌ Güven düşük");
  return null;
}

function prob(c){return Math.min(80,Math.max(50,c*8))}
function imp(o){return 100/o}
function val(p,b){return (p-b).toFixed(1)}

async function run(){

  const res = await axios.get("https://v3.football.api-sports.io/fixtures?live=all",{
    headers:{"x-apisports-key":API_KEY}
  });

  const matches = res.data.response || [];
  console.log("CANLI:",matches.length);

  for(const m of matches){

    const id=m.fixture.id;
    const minute=m.fixture.status.elapsed;
    const league=m.league.name;

    if(!minute || minute<10 || minute>90){
      console.log("❌ Dakika uygun değil");
      continue;
    }

    if(badLeague(league)){
      console.log("❌ Lig elendi");
      continue;
    }

    const statsRes = await axios.get(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`,
      {headers:{"x-apisports-key":API_KEY}}
    );

    const stats=statsRes.data.response;
    if(!stats || stats.length<2){
      console.log("❌ Stats yok");
      continue;
    }

    const home=extract(stats[0]);
    const away=extract(stats[1]);

    if(!memory[id]){
      memory[id]={home,away};
      continue;
    }

    const d = {
      shots:(home.shots-memory[id].home.shots)+(away.shots-memory[id].away.shots),
      shotsOn:(home.shotsOn-memory[id].home.shotsOn)+(away.shotsOn-memory[id].away.shotsOn),
      corners:(home.corners-memory[id].home.corners)+(away.corners-memory[id].away.corners),
      dangerous:(home.dangerous-memory[id].home.dangerous)+(away.dangerous-memory[id].away.dangerous)
    };

    memory[id]={home,away};

    if(!valid(d)) continue;

    const conf = confidence(d);
    const type = signalType(conf);
    if(!type) continue;

    const odds=DEFAULT_ODDS;
    const bp=prob(conf);
    const ip=imp(odds);
    const value=val(bp,ip);

    console.log("✅ SİNYAL:",conf,value);

    await sendTelegram(`
${type} GİR

Dakika: ${minute}
Güven: ${conf.toFixed(1)}

Value: %${value}
`);

  }
}

console.log("PRO DEBUG BOT ÇALIŞIYOR");

setInterval(run, POLL_SECONDS*1000);
run();