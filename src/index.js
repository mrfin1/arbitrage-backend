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
  '5m':  { BTC: null },
  '15m': { BTC: null }
};
let connectedClients = [];
let gapHistory = [];
let reportData = [];
let lastAlertTime = {};

const REPORT_MAX = 10000;

const ASSETS = [
  { key: 'BTC', prefix: 'btc-updown', krakenSym: 'BTC/USD', volPerMin: 30 }
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
// Registra esito dopo scadenza contratto
async function verificaEsito(entry) {
  if (!entry.closeAt || !entry.priceToBeat) return;
  const ora = Date.now();
  // Verifica solo se il contratto è scaduto da meno di 5 minuti
  if (ora < entry.closeAt || ora - entry.closeAt > 300000) return;
  const assetSym = entry.asset + '/USD';
  const prezzoFinale = krakenPrices[assetSym];
  if (!prezzoFinale) return;
  const sopra = prezzoFinale >= entry.priceToBeat;
  entry.esito = sopra ? 'UP_WINS' : 'DOWN_WINS';
  entry.prezzoFinale = prezzoFinale;
  const direzCorretta = entry.direzione === 'UP' ? sopra : !sopra;
  entry.direzCorretta = direzCorretta;
  if (entry.direzione) {
    console.log('[Esito] ' + entry.asset + '/' + entry.finestra +
      ' → ' + entry.esito + ' | Direzione ' + entry.direzione +
      ' era ' + (direzCorretta ? 'CORRETTA ✓' : 'ERRATA ✗'));
  }
}

function registraReport(asset, finestra, krakenPrice, polyMkt, score, direzione, pnlNetto) {
  const entry = {
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
    volume: polyMkt.volume || 0,
    closeAt: polyMkt.closeAt || null,
    esito: null,
    prezzoFinale: null,
    direzCorretta: null
  };
  reportData.push(entry);
  if (reportData.length > REPORT_MAX) reportData.shift();
  if (reportData.length > REPORT_MAX) reportData.shift();
}

// ── Fetch Polymarket multi-asset ──────────────────────────
async function fetchPolymarket() {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const asset of ASSETS) {
    for (const fin of FINESTRE) {
      const interval = fin.interval;

      // Cerca contratti in TUTTE le fasi della vita:
      // - da 5 intervalli fa (già quasi scaduti) fino a 2 intervalli futuri
      const tsBase = nowSec - (nowSec % interval);
      const candidati = [];
      for (let offset = -4; offset <= 2; offset++) {
        const ts = tsBase + offset * interval;
        const closeAt = ts + interval;
        const minRimasti = (closeAt - nowSec) / 60;
        if (minRimasti < 0.2 || minRimasti > 30) continue;
        candidati.push({ slug: asset.prefix + '-' + fin.key + '-' + ts, closeAt, minRimasti });
      }

      // Ordina per minRimasti crescente — vogliamo prima quelli che scadono prima
      candidati.sort((a, b) => a.minRimasti - b.minRimasti);

      let trovato = false;
      for (const item of candidati) {
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

          // Aggiorna solo se è un contratto più fresco o diverso
          const existing = polyMarkets[fin.key][asset.key];
          const isNuovoContratto = !existing || existing.slug !== item.slug;
          const isMigliore = !existing || item.minRimasti < existing.minRimasti;

          if (isNuovoContratto || isMigliore) {
            polyMarkets[fin.key][asset.key] = {
              question:    m.question || item.slug,
              slug:        item.slug,
              prezzoUp:    parseFloat((upPrice * 100).toFixed(1)),
              prezzoDown:  parseFloat((downPrice * 100).toFixed(1)),
              priceToBeat: priceToBeat,
              minRimasti:  parseFloat(item.minRimasti.toFixed(2)),
              closeAt:     item.closeAt * 1000, // timestamp ms per calcoli frontend
              volume:      m.volume24hr || m.volume || 0,
              aggiornato:  new Date().toISOString()
            };
            if (isNuovoContratto) {
              console.log('[Poly ' + asset.key + '/' + fin.key + '] NUOVO: ' + item.slug +
                ' UP:' + polyMarkets[fin.key][asset.key].prezzoUp + 'c' +
                ' ' + item.minRimasti.toFixed(1) + 'min');
            }
            trovato = true;
            break;
          }
        } catch(e) { /* slug non trovato */ }
      }

      if (!trovato && polyMarkets[fin.key][asset.key]) {
        // Aggiorna minRimasti in real-time anche senza nuovo fetch
        const m = polyMarkets[fin.key][asset.key];
        if (m.closeAt) {
          m.minRimasti = parseFloat(((m.closeAt - Date.now()) / 60000).toFixed(2));
          if (m.minRimasti < 0) {
            polyMarkets[fin.key][asset.key] = null;
            console.log('[Poly ' + asset.key + '/' + fin.key + '] Scaduto — reset');
          }
        }
      }
    }
  }
}

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

  // Verifica esiti per contratti appena scaduti
  const ora = Date.now();
  reportData.slice(-100).forEach(entry => {
    if (!entry.esito && entry.closeAt && ora >= entry.closeAt) {
      verificaEsito(entry);
    }
  });

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
      params: { channel: 'ticker', symbol: ['BTC/USD'] }
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
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    kraken: !!krakenPrices['BTC/USD'],
    btcPrice: krakenPrices['BTC/USD'] || null,
    polymarket5m:  !!polyMarkets['5m'].BTC,
    polymarket15m: !!polyMarkets['15m'].BTC,
    min5m:  polyMarkets['5m'].BTC  ? polyMarkets['5m'].BTC.minRimasti  : null,
    min15m: polyMarkets['15m'].BTC ? polyMarkets['15m'].BTC.minRimasti : null
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
      to: data.length ? data[data.length-1].ts : null,
      esiti: {
        verificati: data.filter(r => r.esito).length,
        corretti:   data.filter(r => r.direzCorretta === true).length,
        errati:     data.filter(r => r.direzCorretta === false).length,
        winRate:    (() => {
          const v = data.filter(r => r.esito && r.direzione);
          return v.length ? parseFloat((v.filter(r => r.direzCorretta).length / v.length * 100).toFixed(1)) : null;
        })()
      }
    },
    log: data
  });
});

app.get('/report/csv', (req, res) => {
  if (!reportData.length) { res.send('Nessun dato'); return; }
  const headers = ['#','timestamp','asset','finestra','kraken_usd','price_to_beat','distanza_usd','min_rimasti','score','up_cents','down_cents','segnale','pnl_1k_usd','esito','prezzo_finale','direz_corretta'];
  const rows = reportData.map((r, i) => [
    i+1, r.ts, r.asset, r.finestra, r.krakenPrice, r.priceToBeat||'',
    r.distanza, r.minRimasti, r.score, r.prezzoUp, r.prezzoDown,
    r.direzione||'ATTESA', r.pnl1k||'',
    r.esito||'', r.prezzoFinale||'', r.direzCorretta!==null?r.direzCorretta:''
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
