const API_KEY = process.env.API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POLL_INTERVAL = 180000;
const STATS_DELAY = 1500;
const MAX_MATCH = 20;

const MIN_RADAR = 10;
const MIN_MOMENTUM = 1.5;
const ELITE_BOOST = 1.3; // artış çarpanı

const sentRadar = new Map();
const radarMemory = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML"
    })
  });
}

async function apiGet(url) {
  const res = await fetch(url, {
    headers: { "x-apisports-key": API_KEY }
  });
  if (!res.ok) return null;
  return await res.json();
}

function getValue(arr, name) {
  const v = arr.find(x => x.type === name)?.value;
  if (!v) return 0;
  if (typeof v === "string") return Number(v.replace("%", ""));
  return Number(v);
}

function extract(team) {
  const s = team.statistics;
  return {
    shots: getValue(s, "Total Shots"),
    shotsOn: getValue(s, "Shots on Goal"),
    corners: getValue(s, "Corner Kicks"),
    inside: getValue(s, "Shots insidebox"),
    dangerous: getValue(s, "Dangerous Attacks")
  };
}

function score(t) {
  return (
    t.shots * 0.3 +
    t.shotsOn * 1.4 +
    t.corners * 0.8 +
    t.inside * 0.6 +
    t.dangerous * 0.05
  );
}

function momentum(delta) {
  if (!delta) return 0;
  return (
    delta.shots * 0.6 +
    delta.shotsOn * 1.8 +
    delta.corners * 1.2 +
    delta.inside * 0.8
  );
}

async function analyze() {
  const data = await apiGet("https://v3.football.api-sports.io/fixtures?live=all");
  const matches = data?.response || [];

  for (const m of matches.slice(0, MAX_MATCH)) {
    await sleep(STATS_DELAY);

    const id = m.fixture.id;
    const minute = m.fixture.status.elapsed;
    if (!minute || minute > 90) continue;

    const statsData = await apiGet(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`
    );

    if (!statsData?.response || statsData.response.length < 2) continue;

    const home = extract(statsData.response[0]);
    const away = extract(statsData.response[1]);

    const total = {
      shots: home.shots + away.shots,
      shotsOn: home.shotsOn + away.shotsOn,
      corners: home.corners + away.corners,
      inside: home.inside + away.inside,
      dangerous: home.dangerous + away.dangerous
    };

    const sc = score(total);

    const prev = radarMemory.get(id);
    const delta = prev
      ? {
          shots: total.shots - prev.shots,
          shotsOn: total.shotsOn - prev.shotsOn,
          corners: total.corners - prev.corners,
          inside: total.inside - prev.inside
        }
      : null;

    radarMemory.set(id, total);

    const mom = momentum(delta);

    // 🟡 RADAR
    if (sc > MIN_RADAR && mom > MIN_MOMENTUM && !sentRadar.has(id)) {
      sentRadar.set(id, { sc, time: Date.now() });

      await sendTelegram(`
🟡 <b>RADAR</b>

${m.teams.home.name} - ${m.teams.away.name}
Dakika: ${minute}

Baskı: ${sc.toFixed(1)}
Momentum: ${mom.toFixed(1)}

👀 Takip et
      `);
    }

    // 🔴 ELITE
    if (sentRadar.has(id)) {
      const old = sentRadar.get(id);

      if (sc > old.sc * ELITE_BOOST && mom > 2) {
        sentRadar.delete(id);

        await sendTelegram(`
🔴 <b>ELITE GİRİŞ</b>

${m.teams.home.name} - ${m.teams.away.name}
Dakika: ${minute}

Baskı: ${sc.toFixed(1)} ↑
Momentum: ${mom.toFixed(1)}

💰 GİR
        `);
      }
    }
  }
}

setInterval(analyze, POLL_INTERVAL);
analyze();