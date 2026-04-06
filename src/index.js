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
let krakenPrices = {};        // { 'BTC/USD': 83200, ... }
let polyMarkets = {           // mercati attivi per finestra
  '5m':  { BTC: null },
  '15m': { BTC: null }
};
let lastAlertTime = {};
let connectedClients = [];
let gapHistory = [];

// Volatilità attesa BTC per minuto (in USD) — calibrata sui test reali
// BTC si muove mediamente $20-40 al minuto in condizioni normali
const VOLATILITY_PER_MIN = 30;

// ── Telegram ─────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('[Telegram] Inviato');
  } catch (err) {
    console.error('[Telegram] Errore:', err.message);
  }
}

function puoMandareAlert(key) {
  const now = Date.now();
  if (!lastAlertTime[key] || now - lastAlertTime[key] > 3 * 60 * 1000) {
    lastAlertTime[key] = now;
    return true;
  }
  return false;
}

// ── Broadcast WebSocket ───────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  connectedClients = connectedClients.filter(c => c.readyState === WebSocket.OPEN);
  connectedClients.forEach(c => c.send(msg));
}

// ── Formula score (basata sui test reali) ─────────────────
// score = (distanza_target / volatilità_attesa) × (1 + momentum_factor)
// score > 1.0  → BUY UP segnale
// score < -1.0 → BUY DOWN segnale
// |score| < 1.0 → nessun segnale (troppo vicino al target)
function calcolaScore(distanzaDollar, minutiRimasti, momentumDir) {
  if (minutiRimasti <= 0) return 0;
  const volAttesa = VOLATILITY_PER_MIN * minutiRimasti;
  const momentumFactor = momentumDir === 'up' ? 0.2 : momentumDir === 'down' ? -0.2 : 0;
  const score = (distanzaDollar / volAttesa) * (1 + momentumFactor);
  return parseFloat(score.toFixed(4));
}

// Stima P&L netto in centesimi
// Se BUY UP a prezzo X¢: guadagno lordo = (100 - X)¢, costi = 3¢
// Se BUY DOWN a prezzo X¢: guadagno lordo = (100 - X)¢, costi = 3¢
function calcolaPnlNetto(prezzoContratto, direzione) {
  const COSTI = 3; // 2¢ fee + 1¢ slippage
  if (direzione === 'UP') {
    return parseFloat(((100 - prezzoContratto) - COSTI).toFixed(2));
  } else {
    return parseFloat(((100 - prezzoContratto) - COSTI).toFixed(2));
  }
}

// ── Fetch mercati Polymarket Up/Down ─────────────────────
async function fetchPolymarket() {
  try {
    const keywords = ['bitcoin up', 'btc up', 'bitcoin price'];
    
    const res = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: {
        active: true,
        limit: 50,
        order: 'volume',
        ascending: false
      },
      timeout: 8000
    });

    if (!res.data || !res.data.length) return;

    // Filtra mercati BTC up/down con scadenza breve
    const now = Date.now();
    const mercatiBtc = res.data.filter(m => {
      const testo = (m.question || m.slug || '').toLowerCase();
      const isBtc = testo.includes('bitcoin') || testo.includes('btc');
      const isUpDown = testo.includes('up') || testo.includes('down') || testo.includes('above') || testo.includes('below');
      const hasPrezzi = m.outcomePrices;
      return isBtc && isUpDown && hasPrezzi;
    });

    // Per ogni mercato calcola minuti rimasti
    const conScadenza = mercatiBtc.map(m => {
      let minRimasti = null;
      if (m.endDate || m.end_date_iso) {
        const end = new Date(m.endDate || m.end_date_iso);
        minRimasti = (end - now) / 60000;
      }
      return { ...m, minRimasti };
    }).filter(m => m.minRimasti !== null && m.minRimasti > 0.5 && m.minRimasti <= 20);

    // Separa per finestra 5m e 15m
    const mercati5m  = conScadenza.filter(m => m.minRimasti <= 6);
    const mercati15m = conScadenza.filter(m => m.minRimasti > 6 && m.minRimasti <= 17);

    // Prendi il mercato con volume più alto per ogni finestra
    const best5m  = mercati5m.sort((a,b)  => (b.volume||0) - (a.volume||0))[0];
    const best15m = mercati15m.sort((a,b) => (b.volume||0) - (a.volume||0))[0];

    [{ mercato: best5m, finestra: '5m' }, { mercato: best15m, finestra: '15m' }].forEach(({ mercato, finestra }) => {
      if (!mercato) return;
      try {
        const prices = typeof mercato.outcomePrices === 'string'
          ? JSON.parse(mercato.outcomePrices)
          : mercato.outcomePrices;

        const prezzoUp   = parseFloat(prices[0]);
        const prezzoDown = parseFloat(prices[1]);

        // Estrai il price to beat dalla domanda del mercato
        // es. "Will BTC be above $69,836 at 14:30?"
        const targetMatch = (mercato.question || '').match(/\$?([\d,]+)/g);
        const priceToBeat = targetMatch ? parseFloat(targetMatch[targetMatch.length-1].replace(/[\$,]/g,'')) : null;

        polyMarkets[finestra].BTC = {
          question: mercato.question || mercato.slug,
          prezzoUp: parseFloat((prezzoUp * 100).toFixed(1)),     // in centesimi
          prezzoDown: parseFloat((prezzoDown * 100).toFixed(1)), // in centesimi
          priceToBeat,
          minRimasti: parseFloat(mercato.minRimasti.toFixed(2)),
          volume: mercato.volume || 0,
          aggiornato: new Date().toISOString()
        };

        console.log(`[Polymarket ${finestra}] BTC: UP ${(prezzoUp*100).toFixed(1)}¢ DOWN ${(prezzoDown*100).toFixed(1)}¢ | Target: $${priceToBeat} | Scade in: ${mercato.minRimasti.toFixed(1)}m`);
      } catch(e) {
        console.error(`[Polymarket ${finestra}] Errore parsing:`, e.message);
      }
    });

  } catch (err) {
    console.error('[Polymarket] Errore fetch:', err.message);
  }
}

// ── Calcola segnali e alert ───────────────────────────────
async function controllaGap() {
  const btcPrice = krakenPrices['BTC/USD'];
  if (!btcPrice) return;

  const segnali = [];

  for (const finestra of ['5m', '15m']) {
    const m = polyMarkets[finestra].BTC;
    if (!m || !m.priceToBeat || m.minRimasti < 0.5) continue;

    const distanza = btcPrice - m.priceToBeat;  // + = sopra target, - = sotto
    // Momentum semplificato — in futuro userà buffer prezzi Kraken
    const momentum = 'neutral';
    const score = calcolaScore(distanza, m.minRimasti, momentum);

    const direzione = score > 1.0 ? 'UP' : score < -1.0 ? 'DOWN' : null;
    const prezzoContratto = direzione === 'UP' ? m.prezzoUp : direzione === 'DOWN' ? m.prezzoDown : null;
    const pnlNetto = direzione ? calcolaPnlNetto(prezzoContratto, direzione) : null;
    const profittevole = pnlNetto !== null && pnlNetto > 0;

    const segnale = {
      asset: 'BTC',
      finestra,
      krakenPrice: btcPrice,
      priceToBeat: m.priceToBeat,
      distanzaDollar: parseFloat(distanza.toFixed(2)),
      distanzaPct: parseFloat((distanza / btcPrice * 100).toFixed(4)),
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

    // Salva storico
    gapHistory.push(segnale);
    if (gapHistory.length > 1000) gapHistory.shift();

    // Alert Telegram se segnale profittevole
    if (profittevole && direzione && puoMandareAlert(`BTC-${finestra}-${direzione}`)) {
      const emoji = direzione === 'UP' ? '🟢' : '🔴';
      const msg =
        `${emoji} <b>SEGNALE BTC/${finestra} — ${direzione}</b>\n\n` +
        `📊 Kraken: <b>$${btcPrice.toLocaleString('en')}</b>\n` +
        `🎯 Target: <b>$${m.priceToBeat.toLocaleString('en')}</b>\n` +
        `📏 Distanza: <b>${distanza > 0 ? '+' : ''}$${distanza.toFixed(0)}</b>\n` +
        `⏱ Tempo rimasto: <b>${m.minRimasti.toFixed(1)} min</b>\n` +
        `📈 Score: <b>${score.toFixed(2)}</b>\n` +
        `💰 Contratto ${direzione}: <b>${prezzoContratto}¢</b>\n` +
        `💵 P&L netto su $1,000: <b>+$${(pnlNetto / 100 * 1000).toFixed(2)}</b>\n\n` +
        `⏰ ${new Date().toUTCString()}`;
      await sendTelegram(msg);
    }
  }

  broadcast({ type: 'signals', data: segnali });
  broadcast({ type: 'polymarkets', data: polyMarkets });
}

// ── Kraken WebSocket ──────────────────────────────────────
function connettiKraken() {
  console.log('[Kraken] Connessione...');
  const ws = new WebSocket('wss://ws.kraken.com/v2');

  ws.on('open', () => {
    console.log('[Kraken] Connesso');
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'ticker', symbol: ['BTC/USD'] }
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'ticker' && msg.data) {
        msg.data.forEach(tick => {
          krakenPrices[tick.symbol] = tick.last;
        });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('[Kraken] Disconnesso — riconnessione in 5s...');
    setTimeout(connettiKraken, 5000);
  });

  ws.on('error', err => console.error('[Kraken] Errore:', err.message));
}

// ── HTTP Routes ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    kraken: Object.keys(krakenPrices).length > 0,
    polymarket5m: !!polyMarkets['5m'].BTC,
    polymarket15m: !!polyMarkets['15m'].BTC
  });
});

app.get('/prices', (req, res) => {
  res.json({
    kraken: krakenPrices,
    polymarkets: polyMarkets
  });
});

app.get('/signals/history', (req, res) => {
  res.json(gapHistory.slice(-200));
});

app.post('/test-alert', async (req, res) => {
  await sendTelegram('🧪 <b>Test alert</b> — sistema operativo!');
  res.json({ ok: true });
});

// ── WebSocket server ──────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[Server] Porta ${PORT}`);
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  console.log('[WS] Client connesso');
  connectedClients.push(ws);
  ws.send(JSON.stringify({ type: 'prices', data: { kraken: krakenPrices, polymarkets: polyMarkets } }));
  ws.on('close', () => console.log('[WS] Client disconnesso'));
});

// ── Avvio ─────────────────────────────────────────────────
connettiKraken();
fetchPolymarket();

setInterval(fetchPolymarket, 15000);  // Polymarket ogni 15 secondi
setInterval(controllaGap, 3000);      // Controlla segnali ogni 3 secondi

console.log('[Sistema] Arbitrage Terminal backend v2 avviato');
sendTelegram('🚀 <b>Arbitrage Terminal v2</b> — backend avviato\nFormula: distanza target + tempo rimasto + volatilità');
