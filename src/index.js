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

let krakenPrices = {};
let polyMarkets = { '5m': { BTC: null }, '15m': { BTC: null } };
let connectedClients = [];
let gapHistory = [];
let lastAlertTime = {};
const VOLATILITY_PER_MIN = 30;

// ── Report storage (in memoria su Railway) ────────────────
let reportData = [];
const REPORT_MAX = 10000; // max 10k righe in memoria

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

function broadcast(data) {
  const msg = JSON.stringify(data);
  connectedClients = connectedClients.filter(c => c.readyState === WebSocket.OPEN);
  connectedClients.forEach(c => c.send(msg));
}

function calcolaScore(distanza, minRimasti) {
  if (minRimasti <= 0) return 0;
  return parseFloat((distanza / (VOLATILITY_PER_MIN * minRimasti)).toFixed(4));
}

function calcolaPnlNetto(prezzoContratto) {
  return parseFloat(((100 - prezzoContratto) - 3).toFixed(2));
}

function registraReport(krakenPrice, finestra, polyMkt, score, direzione, pnlNetto) {
  const entry = {
    ts: new Date().toISOString(),
    time: new Date().toUTCString().slice(17, 25),
    finestra,
    krakenPrice: parseFloat(krakenPrice.toFixed(2)),
    priceToBeat: polyMkt.priceToBeat,
    distanza: parseFloat((krakenPrice - (polyMkt.priceToBeat || krakenPrice)).toFixed(2)),
    minRimasti: parseFloat(polyMkt.minRimasti.toFixed(2)),
    score: parseFloat(score.toFixed(4)),
    prezzoUp: polyMkt.prezzoUp,
    prezzoDown: polyMkt.prezzoDown,
    direzione: direzione || null,
    pnl1k: pnlNetto ? parseFloat((pnlNetto / 100 * 1000).toFixed(2)) : null,
    volume: polyMkt.volume || 0
  };
  reportData.push(entry);
  if (reportData.length > REPORT_MAX) reportData.shift();
}

async function fetchPolymarket() {
  try {
    var nowSec = Math.floor(Date.now() / 1000);

    // Calcola slug deterministico basato su timestamp Unix
    // 5m: intervalli di 300 secondi
    // 15m: intervalli di 900 secondi
    var ts5m_curr  = nowSec - (nowSec % 300);
    var ts5m_next  = ts5m_curr + 300;
    var ts5m_prev  = ts5m_curr - 300;
    var ts15m_curr = nowSec - (nowSec % 900);
    var ts15m_next = ts15m_curr + 900;

    var slugsToTry = [
      { slug: 'btc-updown-5m-' + ts5m_prev,  finestra: '5m',  closeAt: ts5m_curr },
      { slug: 'btc-updown-5m-' + ts5m_curr,  finestra: '5m',  closeAt: ts5m_next },
      { slug: 'btc-updown-5m-' + ts5m_next,  finestra: '5m',  closeAt: ts5m_next + 300 },
      { slug: 'btc-updown-15m-' + ts15m_curr, finestra: '15m', closeAt: ts15m_next },
      { slug: 'btc-updown-15m-' + ts15m_next, finestra: '15m', closeAt: ts15m_next + 900 },
      { slug: 'btc-updown-15m-' + (ts15m_next + 900), finestra: '15m', closeAt: ts15m_next + 1800 },
    ];

    for (var i = 0; i < slugsToTry.length; i++) {
      var item = slugsToTry[i];
      var minRimasti = (item.closeAt - nowSec) / 60;
      if (minRimasti < 2 || minRimasti > 25) continue; // minimo 2 min per avere tempo di operare

      try {
        var r = await axios.get('https://gamma-api.polymarket.com/markets', {
          params: { slug: item.slug },
          timeout: 6000
        });

        if (!r.data || !r.data.length) continue;

        var m = r.data[0];
        if (!m.outcomePrices) continue;

        var prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices) : m.outcomePrices;

        var upPrice   = parseFloat(prices[0]);
        var downPrice = parseFloat(prices[1]);

        if (isNaN(upPrice) || isNaN(downPrice)) continue;

        // Price to beat: dal campo startPrice, startMidpoint, o prezzo Kraken corrente
        var priceToBeat = null;
        if (m.startPrice && parseFloat(m.startPrice) > 1000) priceToBeat = parseFloat(m.startPrice);
        else if (m.startMidpoint && parseFloat(m.startMidpoint) > 1000) priceToBeat = parseFloat(m.startMidpoint);
        else priceToBeat = krakenPrices['BTC/USD'] || null;

        // Aggiorna sempre con il mercato con meno tempo rimasto (più vicino alla scadenza)
        var existing = polyMarkets[item.finestra].BTC;
        if (existing && existing.minRimasti <= minRimasti && existing.minRimasti > 0) continue;

        polyMarkets[item.finestra].BTC = {
          question:    m.question || item.slug,
          slug:        item.slug,
          prezzoUp:    parseFloat((upPrice * 100).toFixed(1)),
          prezzoDown:  parseFloat((downPrice * 100).toFixed(1)),
          priceToBeat: priceToBeat,
          minRimasti:  parseFloat(minRimasti.toFixed(2)),
          volume:      m.volume24hr || m.volume || 0,
          aggiornato:  new Date().toISOString()
        };

        console.log('[Poly ' + item.finestra + '] ✓ slug:' + item.slug +
          ' UP:' + polyMarkets[item.finestra].BTC.prezzoUp + 'c' +
          ' DN:' + polyMarkets[item.finestra].BTC.prezzoDown + 'c' +
          ' ' + minRimasti.toFixed(1) + 'min rimasti');

      } catch(e) {
        // slug non trovato — normale, proviamo il prossimo
      }
    }

  } catch(err) {
    console.error('[Polymarket] Errore:', err.message);
  }
}

async function controllaGap() {
  const btcPrice = krakenPrices['BTC/USD'];
  if (!btcPrice) return;
  const segnali = [];
  for (const finestra of ['5m', '15m']) {
    const m = polyMarkets[finestra].BTC;
    if (!m || !m.priceToBeat || m.minRimasti < 0.5) continue;
    const distanza = btcPrice - m.priceToBeat;
    const score = calcolaScore(distanza, m.minRimasti);
    const direzione = score > 1.0 ? 'UP' : score < -1.0 ? 'DOWN' : null;
    const prezzoContratto = direzione === 'UP' ? m.prezzoUp : direzione === 'DOWN' ? m.prezzoDown : null;
    const pnlNetto = direzione ? calcolaPnlNetto(prezzoContratto) : null;
    const profittevole = pnlNetto !== null && pnlNetto > 0;
    const segnale = {
      asset: 'BTC', finestra, krakenPrice: btcPrice, priceToBeat: m.priceToBeat,
      distanzaDollar: parseFloat(distanza.toFixed(2)), minRimasti: m.minRimasti,
      score: parseFloat(score.toFixed(4)), direzione, prezzoContratto, pnlNetto,
      profittevole, question: m.question, timestamp: new Date().toISOString()
    };
    segnali.push(segnale);
    gapHistory.push(segnale);
    if (gapHistory.length > 1000) gapHistory.shift();
    if (profittevole && direzione && puoMandareAlert('BTC-' + finestra + '-' + direzione)) {
      const msg = (direzione === 'UP' ? 'UP' : 'DOWN') + ' SEGNALE BTC/' + finestra +
        '\nKraken: $' + btcPrice.toLocaleString('en') +
        '\nTarget: $' + m.priceToBeat.toLocaleString('en') +
        '\nDistanza: ' + (distanza > 0 ? '+' : '') + distanza.toFixed(0) + '$' +
        '\nTempo: ' + m.minRimasti.toFixed(1) + ' min' +
        '\nScore: ' + score.toFixed(2) +
        '\nContratto: ' + prezzoContratto + 'c' +
        '\nP&L $1K: +$' + (pnlNetto / 100 * 1000).toFixed(2);
      await sendTelegram(msg);
    }
  }
  broadcast({ type: 'signals', data: segnali });
  broadcast({ type: 'polymarkets', data: polyMarkets });
}

function connettiKraken() {
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  ws.on('open', () => {
    console.log('[Kraken] Connesso');
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } }));
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'ticker' && msg.data) msg.data.forEach(t => { krakenPrices[t.symbol] = t.last; });
    } catch(e) {}
  });
  ws.on('close', () => { console.log('[Kraken] Riconnessione...'); setTimeout(connettiKraken, 5000); });
  ws.on('error', err => console.error('[Kraken]', err.message));
}


// DEBUG — mostra mercati raw da Polymarket
app.get('/debug/polymarket', async function(req, res) {
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { active: true, limit: 50, order: 'volume', ascending: false },
      timeout: 10000
    });
    const markets = r.data || [];
    const btc = markets.filter(m => {
      const t = (m.question || m.slug || '').toLowerCase();
      return t.includes('bitcoin') || t.includes('btc');
    }).map(m => ({
      question: m.question,
      slug: m.slug,
      endDate: m.endDate || m.end_date_iso || m.endDateIso,
      outcomePrices: m.outcomePrices,
      volume: m.volume,
      active: m.active
    }));
    res.json({ total: markets.length, btc_count: btc.length, btc_markets: btc });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok', timestamp: new Date().toISOString(),
  kraken: Object.keys(krakenPrices).length > 0,
  polymarket5m: !!polyMarkets['5m'].BTC,
  polymarket15m: !!polyMarkets['15m'].BTC
}));
app.get('/prices', (req, res) => res.json({ kraken: krakenPrices, polymarkets: polyMarkets }));
app.get('/report', function(req, res) {
  var limit = parseInt(req.query.limit) || 5000;
  var data = reportData.slice(-limit);
  var signals = data.filter(function(r) { return r.direzione !== null; });
  var scores = data.map(function(r) { return Math.abs(r.score); });
  var avgScore = scores.length ? scores.reduce(function(s,v){return s+v;},0)/scores.length : 0;
  var maxScore = scores.length ? Math.max.apply(null, scores) : 0;
  var totalPnl = signals.reduce(function(s,r){return s+(r.pnl1k||0);},0);
  res.json({
    meta: {
      totalEntries: data.length,
      signals: signals.length,
      avgScore: parseFloat(avgScore.toFixed(4)),
      maxScore: parseFloat(maxScore.toFixed(4)),
      totalPnl1k: parseFloat(totalPnl.toFixed(2)),
      scoreThreshold: 1.0,
      from: data.length ? data[0].ts : null,
      to: data.length ? data[data.length-1].ts : null
    },
    log: data
  });
});

app.get('/report/csv', function(req, res) {
  var data = reportData;
  if (!data.length) { res.send('Nessun dato'); return; }
  var sep = ',';
  var headers = ['#','timestamp','finestra','kraken_usd','price_to_beat','distanza_usd','min_rimasti','score','up_cents','down_cents','segnale','pnl_1k_usd','volume'];
  var rows = data.map(function(r, i) {
    return [i+1, r.ts, r.finestra, r.krakenPrice, r.priceToBeat||'', r.distanza, r.minRimasti, r.score, r.prezzoUp, r.prezzoDown, r.direzione||'ATTESA', r.pnl1k||'', r.volume].join(sep);
  });
  var csv = headers.join(sep) + '\n' + rows.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=arbitrage_report.csv');
  res.send(csv);
});

app.get('/signals/history', (req, res) => res.json(gapHistory.slice(-200)));
app.post('/test-alert', async (req, res) => { await sendTelegram('Test alert ok!'); res.json({ ok: true }); });

const server = app.listen(PORT, () => console.log('[Server] Porta ' + PORT));
const wss = new WebSocket.Server({ server });
wss.on('connection', ws => {
  connectedClients.push(ws);
  ws.send(JSON.stringify({ type: 'prices', data: { kraken: krakenPrices, polymarkets: polyMarkets } }));
  ws.on('close', () => console.log('[WS] Disconnesso'));
});

connettiKraken();
fetchPolymarket();
setInterval(fetchPolymarket, 5000);
setInterval(controllaGap, 3000);
console.log('[Sistema] Backend avviato');
sendTelegram('Backend Arbitrage Terminal avviato');
