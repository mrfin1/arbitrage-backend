const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3001;

// ── Stato ────────────────────────────────────────────────
let krakenPrices = {};
let polyMarkets = {
  '5m':  { BTC: null, ETH: null, SOL: null, XRP: null, DOGE: null },
  '15m': { BTC: null, ETH: null, SOL: null, XRP: null, DOGE: null }
};
let connectedClients = [];
let gapHistory = [];
let reportData = [];
let lastAlertTime = {};

const REPORT_MAX = 10000;

const ASSETS = [
  { key: 'BTC',  prefix: 'btc-updown',  krakenSym: 'BTC/USD',  volPerMin: 30   },
  { key: 'ETH',  prefix: 'eth-updown',  krakenSym: 'ETH/USD',  volPerMin: 2    },
  { key: 'SOL',  prefix: 'sol-updown',  krakenSym: 'SOL/USD',  volPerMin: 0.5  },
  { key: 'XRP',  prefix: 'xrp-updown',  krakenSym: 'XRP/USD',  volPerMin: 0.05 },
  { key: 'DOGE', prefix: 'doge-updown', krakenSym: 'DOGE/USD', volPerMin: 0.01 }
];

const FINESTRE = [
  { key: '5m',  interval: 300 },
  { key: '15m', interval: 900 }
];

// ── Telegram ─────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML'
    });
  } catch (err) { console.error('[Telegram]', err.message); }
}

function puoMandareAlert(key) {
  const now = Date.now();
  if (!lastAlertTime[key] || now - lastAlertTime[key] > 180000) {
    lastAlertTime[key] = now; return true;
  }
  return false;
}

// ── Broadcast WebSocket ───────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  connectedClients = connectedClients.filter(c => c.readyState === WebSocket.OPEN);
  connectedClients.forEach(c => c.send(msg));
}

// ── Formula score ─────────────────────────────────────────
function calcolaScore(distanza, minRimasti, volPerMin) {
  if (minRimasti <= 0) return 0;
  return parseFloat((distanza / (volPerMin * minRimasti)).toFixed(4));
}

function calcolaPnlNetto(prezzoContratto) {
  return parseFloat(((100 - prezzoContratto) - 3).toFixed(2));
}

// Verifica se l'operazione è realmente profittevole
// Il contratto non deve costare più di 75c (altrimenti guadagno < 22c lordi)
function isOperazioneProfittevole(prezzoContratto, pnlNetto) {
  if (!prezzoContratto || !pnlNetto) return false;
  if (prezzoContratto > 75) return false;  // mercato già prezzato
  if (pnlNetto < 5) return false;           // minimo 5c netti
  return true;
}

// ── Report ────────────────────────────────────────────────
function registraReport(asset, finestra, krakenPrice, polyMkt, score, direzione, pnlNetto) {
  reportData.push({
    ts: new Date().toISOString(),
    asset: asset,
    finestra: finestra,
    krakenPrice: parseFloat(krakenPrice.toFixed(2)),
    priceToBeat: polyMkt.priceToBeat,
    distanza: parseFloat((krakenPrice - (polyMkt.priceToBeat || krakenPrice)).toFixed(2)),
    minRimasti: parseFloat(polyMkt.minRimasti.toFixed(2)),
    score: parseFloat(score.toFixed(4)),
    prezzoUp: polyMkt.prezzoUp,
    prezzoDown: polyMkt.prezzoDown,
    prezzoContratto: direzione ? (direzione === 'UP' ? polyMkt.prezzoUp : polyMkt.prezzoDown) : null,
    direzione: direzione || null,
    profittevole: isOperazioneProfittevole(
      direzione ? (direzione === 'UP' ? polyMkt.prezzoUp : polyMkt.prezzoDown) : null,
      pnlNetto
    ),
    pnl1k: pnlNetto ? parseFloat((pnlNetto / 100 * 1000).toFixed(2)) : null,
    volume: polyMkt.volume || 0
  });
  if (reportData.length > REPORT_MAX) reportData.shift();
}

// ── Fetch Polymarket multi-asset ──────────────────────────
async function fetchPolymarket() {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const asset of ASSETS) {
    for (const fin of FINESTRE) {
      const interval = fin.interval;
      const ts_curr = nowSec - (nowSec % interval);
      const slugsToTry = [
        { slug: asset.prefix + '-' + fin.key + '-' + (ts_curr - interval), closeAt: ts_curr },
        { slug: asset.prefix + '-' + fin.key + '-' + ts_curr,              closeAt: ts_curr + interval },
        { slug: asset.prefix + '-' + fin.key + '-' + (ts_curr + interval), closeAt: ts_curr + interval * 2 }
      ];

      for (const item of slugsToTry) {
        const minRimasti = (item.closeAt - nowSec) / 60;
        if (minRimasti < 2 || minRimasti > 25) continue;

        // Skip se abbiamo già un mercato valido per questo asset/finestra
        const existing = polyMarkets[fin.key][asset.key];
        if (existing && existing.minRimasti >= minRimasti && existing.minRimasti > 2) continue;

        try {
          const r = await axios.get('https://gamma-api.polymarket.com/markets', {
            params: { slug: item.slug }, timeout: 5000
          });
          if (!r.data || !r.data.length) continue;
          const m = r.data[0];
          if (!m.outcomePrices) continue;

          const prices = typeof m.outcomePrices === 'string'
            ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          const upPrice   = parseFloat(prices[0]);
          const downPrice = parseFloat(prices[1]);
          if (isNaN(upPrice) || isNaN(downPrice)) continue;

          const priceToBeat = (m.startPrice && parseFloat(m.startPrice) > 0)
            ? parseFloat(m.startPrice)
            : (krakenPrices[asset.krakenSym] || null);

          polyMarkets[fin.key][asset.key] = {
            question:    m.question || item.slug,
            slug:        item.slug,
            prezzoUp:    parseFloat((upPrice * 100).toFixed(1)),
            prezzoDown:  parseFloat((downPrice * 100).toFixed(1)),
            priceToBeat: priceToBeat,
            minRimasti:  parseFloat(minRimasti.toFixed(2)),
            volume:      m.volume24hr || m.volume || 0,
            aggiornato:  new Date().toISOString()
          };

          console.log('[Poly ' + asset.key + '/' + fin.key + '] ' +
            polyMarkets[fin.key][asset.key].prezzoUp + 'c/' +
            polyMarkets[fin.key][asset.key].prezzoDown + 'c | ' +
            minRimasti.toFixed(1) + 'min');
          break;
        } catch(e) { /* slug non trovato */ }
      }
    }
  }
}

// ── Controlla segnali ─────────────────────────────────────
async function controllaGap() {
  // Resetta mercati scaduti
  for (const fin of FINESTRE) {
    for (const asset of ASSETS) {
      const m = polyMarkets[fin.key][asset.key];
      if (m && m.minRimasti < 0.5) {
        polyMarkets[fin.key][asset.key] = null;
      }
    }
  }

  const segnali = [];

  for (const asset of ASSETS) {
    const assetPrice = krakenPrices[asset.krakenSym];
    if (!assetPrice) continue;

    for (const fin of FINESTRE) {
      const m = polyMarkets[fin.key][asset.key];
      if (!m || !m.priceToBeat || m.minRimasti < 2) continue;

      const distanza = assetPrice - m.priceToBeat;
      const score = calcolaScore(distanza, m.minRimasti, asset.volPerMin);
      const direzione = score > 1.0 ? 'UP' : score < -1.0 ? 'DOWN' : null;
      const prezzoContratto = direzione === 'UP' ? m.prezzoUp : direzione === 'DOWN' ? m.prezzoDown : null;
      const pnlNetto = direzione ? calcolaPnlNetto(prezzoContratto) : null;
      const profittevole = pnlNetto !== null && pnlNetto > 0;

      const segnale = {
        asset: asset.key,
        finestra: fin.key,
        krakenPrice: assetPrice,
        priceToBeat: m.priceToBeat,
        distanzaDollar: parseFloat(distanza.toFixed(2)),
        minRimasti: m.minRimasti,
        score: parseFloat(score.toFixed(4)),
        direzione,
        prezzoContratto,
        pnlNetto,
        profittevole,
        question: m.question,
        timestamp: new Date().toISOString()
      };

      segnali.push(segnale);
      gapHistory.push(segnale);
      if (gapHistory.length > 1000) gapHistory.shift();

      registraReport(asset.key, fin.key, assetPrice, m, score, direzione, pnlNetto);

      if (profittevole && direzione && puoMandareAlert(asset.key + '-' + fin.key + '-' + direzione)) {
        const emoji = direzione === 'UP' ? 'UP' : 'DOWN';
        const msg = emoji + ' SEGNALE ' + asset.key + '/' + fin.key +
          '\nKraken: $' + assetPrice.toLocaleString('en') +
          '\nTarget: $' + m.priceToBeat.toLocaleString('en') +
          '\nDistanza: ' + (distanza > 0 ? '+' : '') + distanza.toFixed(2) + '$' +
          '\nTempo: ' + m.minRimasti.toFixed(1) + ' min' +
          '\nScore: ' + score.toFixed(2) +
          '\nContratto: ' + prezzoContratto + 'c' +
          '\nP&L $1K: +$' + (pnlNetto / 100 * 1000).toFixed(2);
        await sendTelegram(msg);
      }
    }
  }

  broadcast({ type: 'signals', data: segnali });
  broadcast({ type: 'polymarkets', data: polyMarkets });
}

// ── Kraken WebSocket ──────────────────────────────────────
function connettiKraken() {
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  ws.on('open', () => {
    console.log('[Kraken] Connesso');
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'ticker', symbol: ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','DOGE/USD'] }
    }));
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'ticker' && msg.data) {
        msg.data.forEach(t => { krakenPrices[t.symbol] = t.last; });
      }
    } catch(e) {}
  });
  ws.on('close', () => { console.log('[Kraken] Riconnessione...'); setTimeout(connettiKraken, 5000); });
  ws.on('error', err => console.error('[Kraken]', err.message));
}

// ── HTTP Routes ───────────────────────────────────────────
app.get('/health', (req, res) => {
  const status = {};
  for (const a of ASSETS) {
    for (const f of FINESTRE) {
      status[a.key + '_' + f.key] = !!polyMarkets[f.key][a.key];
    }
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    kraken: Object.keys(krakenPrices).length,
    polymarkets: status
  });
});

app.get('/prices', (req, res) => res.json({ kraken: krakenPrices, polymarkets: polyMarkets }));

app.get('/report', (req, res) => {
  const limit = parseInt(req.query.limit) || 5000;
  const data = reportData.slice(-limit);
  const signals = data.filter(r => r.direzione !== null);
  const scores = data.map(r => Math.abs(r.score));
  const avgScore = scores.length ? scores.reduce((s,v) => s+v, 0) / scores.length : 0;
  const maxScore = scores.length ? Math.max(...scores) : 0;
  const totalPnl = signals.reduce((s,r) => s + (r.pnl1k||0), 0);
  res.json({
    meta: {
      totalEntries: data.length,
      signals: signals.length,
      avgScore: parseFloat(avgScore.toFixed(4)),
      maxScore: parseFloat(maxScore.toFixed(4)),
      totalPnl1k: parseFloat(totalPnl.toFixed(2)),
      from: data.length ? data[0].ts : null,
      to: data.length ? data[data.length-1].ts : null
    },
    log: data
  });
});

app.get('/report/csv', (req, res) => {
  if (!reportData.length) { res.send('Nessun dato'); return; }
  const headers = ['#','timestamp','asset','finestra','kraken_usd','price_to_beat','distanza_usd','min_rimasti','score','up_cents','down_cents','segnale','pnl_1k_usd'];
  const rows = reportData.map((r, i) => [
    i+1, r.ts, r.asset, r.finestra, r.krakenPrice, r.priceToBeat||'',
    r.distanza, r.minRimasti, r.score, r.prezzoUp, r.prezzoDown,
    r.direzione||'ATTESA', r.pnl1k||''
  ].join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=arbitrage_report.csv');
  res.send(headers.join(',') + '\n' + rows.join('\n'));
});

app.get('/signals/history', (req, res) => res.json(gapHistory.slice(-200)));
app.post('/test-alert', async (req, res) => {
  await sendTelegram('Test alert ok! Sistema multi-asset attivo: BTC ETH SOL XRP DOGE');
  res.json({ ok: true });
});

// ── WebSocket server ──────────────────────────────────────
const server = app.listen(PORT, () => console.log('[Server] Porta ' + PORT));
const wss = new WebSocket.Server({ server });
wss.on('connection', ws => {
  connectedClients.push(ws);
  ws.send(JSON.stringify({ type: 'prices', data: { kraken: krakenPrices, polymarkets: polyMarkets } }));
  ws.on('close', () => console.log('[WS] Disconnesso'));
});

// ── Avvio ─────────────────────────────────────────────────
connettiKraken();
fetchPolymarket();
setInterval(fetchPolymarket, 5000);
setInterval(controllaGap, 3000);
console.log('[Sistema] Backend multi-asset avviato — BTC ETH SOL XRP DOGE');
sendTelegram('Backend avviato — multi-asset: BTC ETH SOL XRP DOGE');
