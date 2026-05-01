const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 180000);
const MAX_MATCH = Number(process.env.MAX_MATCH || 20);
const STATS_DELAY = Number(process.env.STATS_DELAY || 1500);

const MIN_ELITE = Number(process.env.MIN_ELITE || 10.0);
const XG_SPIKE_MIN = Number(process.env.XG_SPIKE_MIN || 0.05);

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
        parse_mode: "HTML"
      })
    });
  } catch {}
}

async function apiGet(url) {
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

async function getLiveMatches() {
  const data = await apiGet("https://v3.football.api-sports.io/fixtures?live=all");
  return data?.response || [];
}

async function getStats(id) {
  const data = await apiGet(
    `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`
  );
  return data?.response || [];
}

function getValue(arr, name) {
  const raw = arr.find(x => x.type === name)?.value;
  if (!raw) return 0;
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
    insideBox: getValue(s, "Shots insidebox"),
    corners: getValue(s, "Corner Kicks"),
    dangerous: getValue(s, "Dangerous Attacks"),
    possession: getValue(s, "Ball Possession"),
    xg: getValue(s, "Expected Goals")
  };
}

function combine(a, b) {
  const out = {};
  for (const k in a) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

function diff(now, old) {
  if (!old) return null;
  const out = {};
  for (const k in now) {
    out[k] = Math.max(0, (now[k] || 0) - (old[k] || 0));
  }
  return out;
}

function momentumScore(d) {
  if (!d) return 0;
  return (
    d.shots * 0.6 +
    d.shotsOn * 1.5 +
    d.corners * 1.0 +
    d.insideBox * 0.7 +
    d.dangerous * 0.1 +
    d.xg * 3
  );
}

function xgSpike(d) {
  if (!d) return 0;
  return Number((d.xg || 0).toFixed(2));
}

function totalPressure(t) {
  return (
    t.shots * 0.25 +
    t.shotsOn * 1.3 +
    t.insideBox * 0.6 +
    t.corners * 0.7 +
    t.dangerous * 0.05 +
    t.xg * 3
  );
}

function shouldSignal({ press, xg, momentum, spike, need }) {
  if (!xg || xg < 0.7) return false;
  if (!momentum || momentum <= 0) return false;
  if (!spike || spike < XG_SPIKE_MIN) return false;
  if (press < MIN_ELITE) return false;
  if (need > 1) return false;
  return true;
}

async function analyze() {
  console.log("🔎 REAL XG SPIKE scan...");

  const matches = await getLiveMatches();

  for (const m of matches.slice(0, MAX_MATCH)) {
    await sleep(STATS_DELAY);

    const id = m.fixture.id;
    const minute = m.fixture.status.elapsed;
    if (!minute || minute > 90) continue;

    const home = m.teams.home.name;
    const away = m.teams.away.name;

    const homeG = m.goals.home || 0;
    const awayG = m.goals.away || 0;
    const totalG = homeG + awayG;

    const stats = await getStats(id);
    if (!stats || stats.length < 2) continue;

    const homeS = extractTeamStats(stats[0]);
    const awayS = extractTeamStats(stats[1]);
    const total = combine(homeS, awayS);

    if (!total.xg || total.xg === 0) continue;

    const old = memory.get(id);
    const delta = old ? diff(total, old) : null;
    memory.set(id, total);

    const momentum = momentumScore(delta);
    const spike = xgSpike(delta);
    const press = totalPressure(total);

    const need = Math.max(0, 2 - totalG);

    if (!shouldSignal({
      press,
      xg: total.xg,
      momentum,
      spike,
      need
    })) continue;

    if (sent.has(id)) continue;
    sent.set(id, true);

    const msg = `
🔥 <b>REAL XG SPIKE SİNYAL</b>

⚽ ${home} - ${away}
⏱ ${minute}. dk
📊 Skor: ${homeG}-${awayG}

📈 Baskı: ${press.toFixed(1)}
🎯 XG: ${total.xg}
🚀 Spike: +${spike}
🧭 Momentum: ${momentum.toFixed(1)}

🧠 <b>GİR</b>
`;

    await sendTelegram(msg);
  }
}

async function start() {
  await sendTelegram("🤖 BOT AKTİF (REAL XG SPIKE)");
  analyze();
  setInterval(analyze, POLL_INTERVAL);
}

start();