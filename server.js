const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = 120000;
const MAX_MATCH = 35;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(msg) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    })
  });
}

async function api(url) {
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_KEY }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function get(stat, name) {
  const v = stat.find(x => x.type === name)?.value;
  if (!v) return 0;
  if (typeof v === "string") return Number(v.replace("%","")) || 0;
  return Number(v);
}

function extract(team) {
  const s = team.statistics;
  return {
    shots: get(s,"Total Shots"),
    on: get(s,"Shots on Goal"),
    off: get(s,"Shots off Goal"),
    corner: get(s,"Corner Kicks"),
    danger: get(s,"Dangerous Attacks")
  };
}

function calcMomentum(t) {
  let m = 0;
  m += t.on * 2;
  m += t.corner * 1.2;
  m += t.danger * 0.08;
  m += t.shots * 0.5;
  return m.toFixed(1);
}

function confidence(t) {
  if (t.danger === 0) return "⚠️ Orta (Veri eksik olabilir)";
  if (t.on >= 4 && t.corner >= 4) return "🟢 Yüksek";
  if (t.on >= 2) return "🟡 Orta";
  return "🔴 Düşük";
}

function decision({minute, goals, stats}) {
  const needGoal = goals < 2;
  const strong =
    stats.on >= 3 &&
    stats.corner >= 3 &&
    stats.shots >= 8;

  if (minute >= 30 && minute <= 70 && needGoal && strong) {
    return "✅ GİR";
  }

  if (strong) return "⚠️ BEKLE";
  return "❌ PAS";
}

async function run() {
  console.log("Tarama başladı...");

  const live = await api("https://v3.football.api-sports.io/fixtures?live=all");
  if (!live) return;

  const matches = live.response.slice(0, MAX_MATCH);

  for (const m of matches) {
    await sleep(1200);

    const minute = m.fixture.status.elapsed;
    if (!minute || minute < 25) continue;

    const statsData = await api(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${m.fixture.id}`
    );

    if (!statsData || statsData.response.length < 2) continue;

    const home = extract(statsData.response[0]);
    const away = extract(statsData.response[1]);

    const total = {
      shots: home.shots + away.shots,
      on: home.on + away.on,
      off: home.off + away.off,
      corner: home.corner + away.corner,
      danger: home.danger + away.danger
    };

    const goals = (m.goals.home || 0) + (m.goals.away || 0);

    const dec = decision({minute, goals, stats: total});

    if (dec === "❌ PAS") continue;

    const msg = `
⚽ <b>${m.teams.home.name} - ${m.teams.away.name}</b>
🌍 ${m.league.country} / ${m.league.name}
⏱ Dakika: ${minute}
📊 Skor: ${m.goals.home}-${m.goals.away}

📈 <b>DETAY ANALİZ</b>
Şut: ${total.shots}
İsabet: ${total.on}
Korner: ${total.corner}
Tehlikeli Atak: ${total.danger}

⚡ Momentum: ${calcMomentum(total)}
📊 Veri Güveni: ${confidence(total)}

🎯 Gol ihtiyacı: ${2 - goals}
🧠 Karar: <b>${dec}</b>

💰 Stake: %1-2
`;

    await send(msg);
  }
}

console.log("🤖 PRO ANALİZ BOT AKTİF");
await send("🤖 PRO ANALİZ BOT AKTİF");

setInterval(run, POLL_INTERVAL);
run();