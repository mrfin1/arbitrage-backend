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

async function fetchPolymarket() {
  try {
    var now = Date.now();
    var found5m = false;
    var found15m = false;

    // Strategia 1: cerca per slug btc-updown con volume recente
    var endpoints = [
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false',
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=end_date_min&ascending=true'
    ];

    var allMarkets = [];
    for (var e = 0; e < endpoints.length; e++) {
      try {
        var r = await axios.get(endpoints[e], { timeout: 8000 });
        if (r.data && r.data.length) {
          allMarkets = allMarkets.concat(r.data);
        }
      } catch(err) { console.log('[Poly] endpoint ' + e + ' fallito'); }
    }

    // Deduplicazione per id
    var seen = {};
    allMarkets = allMarkets.filter(function(m) {
      if (seen[m.id]) return false;
      seen[m.id] = true;
      return true;
    });

    console.log('[Polymarket] Totale mercati ricevuti: ' + allMarkets.length);

    // Filtra mercati BTC up/down con scadenza futura
    var btcUpDown = allMarkets.filter(function(m) {
      var t = (m.question || m.slug || '').toLowerCase();
      var isBtcUpDown = t.includes('bitcoin up or down') || t.includes('btc-updown') || t.includes('btc up or down');
      if (!isBtcUpDown) return false;
      if (!m.outcomePrices) return false;
      if (m.closed) return false;
      var endStr = m.endDate || m.endDateIso || m.end_date_iso;
      if (!endStr) return false;
      var minR = (new Date(endStr) - now) / 60000;
      return minR > 0.3;
    }).map(function(m) {
      var endStr = m.endDate || m.endDateIso || m.end_date_iso;
      var minR = (new Date(endStr) - now) / 60000;
      return Object.assign({}, m, { minRimasti: minR });
    });

    console.log('[Polymarket] Mercati BTC Up/Down attivi: ' + btcUpDown.length);
    btcUpDown.forEach(function(m) {
      console.log('  -> ' + m.question + ' | ' + m.minRimasti.toFixed(1) + 'min');
    });

    // Scegli migliore per 5m (scade entro 6 min) e 15m (scade entro 17 min)
    var best5m  = btcUpDown.filter(function(m){ return m.minRimasti <= 6; })
                           .sort(function(a,b){ return a.minRimasti - b.minRimasti; })[0];
    var best15m = btcUpDown.filter(function(m){ return m.minRimasti > 6 && m.minRimasti <= 17; })
                           .sort(function(a,b){ return a.minRimasti - b.minRimasti; })[0];

    // Se non troviamo niente nella finestra 15m, prendi quello con più tempo rimasto fino a 20min
    if (!best15m) {
      best15m = btcUpDown.filter(function(m){ return m.minRimasti > 6 && m.minRimasti <= 25; })
                         .sort(function(a,b){ return a.minRimasti - b.minRimasti; })[0];
    }

    [['5m', best5m], ['15m', best15m]].forEach(function(pair) {
      var fin = pair[0]; var mercato = pair[1];
      if (!mercato) {
        console.log('[Poly ' + fin + '] Nessun mercato trovato');
        return;
      }
      try {
        var prices = typeof mercato.outcomePrices === 'string'
          ? JSON.parse(mercato.outcomePrices) : mercato.outcomePrices;

        // Price to beat: dal campo startPrice o dalla domanda
        var priceToBeat = null;
        if (mercato.startPrice) priceToBeat = parseFloat(mercato.startPrice);
        if (!priceToBeat && mercato.question) {
          // es: "Bitcoin Up or Down - April 7, 2:15AM-2:20AM ET"
          // il price to beat è nei dati del contratto, non nel titolo
          // usiamo il prezzo Kraken attuale come approssimazione
          priceToBeat = krakenPrices['BTC/USD'] || null;
        }

        polyMarkets[fin].BTC = {
          question:   mercato.question || mercato.slug,
          prezzoUp:   parseFloat((parseFloat(prices[0]) * 100).toFixed(1)),
          prezzoDown: parseFloat((parseFloat(prices[1]) * 100).toFixed(1)),
          priceToBeat: priceToBeat,
          minRimasti: parseFloat(mercato.minRimasti.toFixed(2)),
          volume:     mercato.volume24hr || mercato.volume || 0,
          aggiornato: new Date().toISOString()
        };
        console.log('[Poly ' + fin + '] ✓ UP:' + polyMarkets[fin].BTC.prezzoUp +
          'c DN:' + polyMarkets[fin].BTC.prezzoDown +
          'c | ' + mercato.minRimasti.toFixed(1) + 'min | ' + mercato.question);
      } catch(e) {
        console.error('[Poly ' + fin + '] Errore parsing:', e.message);
      }
    });

  } catch(err) {
    console.error('[Polymarket] Errore generale:', err.message);
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
setInterval(fetchPolymarket, 15000);
setInterval(controllaGap, 3000);
console.log('[Sistema] Backend avviato');
sendTelegram('Backend Arbitrage Terminal avviato');
