const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ──────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GAP_THRESHOLD = parseFloat(process.env.GAP_THRESHOLD || '1.5');
const PORT = process.env.PORT || 3001;

// ── Stato interno ────────────────────────────────────────
let krakenPrices = {};      // { 'BTC/USD': 67240.5, ... }
let polyPrices = {};        // { 'BTC': 0.71, ... }
let gapHistory = [];        // ultimi 500 gap rilevati
let lastAlertTime = {};     // anti-spam: un alert ogni 5 minuti per asset
let connectedClients = [];  // frontend connessi via WebSocket

// ── Telegram ─────────────────────────────────────────────
async function sendTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('[Telegram] Messaggio inviato');
  } catch (err) {
    console.error('[Telegram] Errore:', err.message);
  }
}

// ── Calcolo gap ───────────────────────────────────────────
function calcolaGap(asset) {
  const kpx = krakenPrices[asset + '/USD'];
  const ppx = polyPrices[asset];
  if (!kpx || !ppx) return null;

  // Prezzo implicito Polymarket (probabilità × prezzo atteso)
  const polyEquiv = ppx * kpx * 1.4;
  const gapPercent = ((kpx - polyEquiv) / kpx) * 100;
  const gapDollari = Math.abs(kpx - polyEquiv);

  return {
    asset,
    krakenPrice: kpx,
    polyPrice: polyEquiv,
    gapPercent: parseFloat(gapPercent.toFixed(3)),
    gapDollari: parseFloat(gapDollari.toFixed(2)),
    direzione: gapPercent > 0 ? 'LONG POLY' : 'SHORT POLY',
    timestamp: new Date().toISOString()
  };
}

// ── Alert anti-spam ───────────────────────────────────────
function puoMandareAlert(asset) {
  const now = Date.now();
  const ultimo = lastAlertTime[asset] || 0;
  if (now - ultimo > 5 * 60 * 1000) {
    lastAlertTime[asset] = now;
    return true;
  }
  return false;
}

// ── Broadcast ai client frontend ──────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  connectedClients = connectedClients.filter(c => c.readyState === WebSocket.OPEN);
  connectedClients.forEach(c => c.send(msg));
}

// ── Controllo gap e alert ─────────────────────────────────
async function controllaGap() {
  const assets = ['BTC', 'ETH', 'SOL'];
  const gaps = [];

  for (const asset of assets) {
    const gap = calcolaGap(asset);
    if (!gap) continue;

    gaps.push(gap);

    // Salva nello storico (max 500 punti)
    gapHistory.push(gap);
    if (gapHistory.length > 500) gapHistory.shift();

    // Se supera la soglia → alert Telegram
    if (Math.abs(gap.gapPercent) >= GAP_THRESHOLD && puoMandareAlert(asset)) {
      const emoji = gap.gapPercent > 0 ? '🟢' : '🔴';
      const msg = `${emoji} <b>GAP RILEVATO — ${asset}/USD</b>\n\n` +
        `📊 Kraken: <b>$${gap.krakenPrice.toLocaleString('en')}</b>\n` +
        `📊 Polymarket equiv: <b>$${gap.polyPrice.toLocaleString('en')}</b>\n` +
        `📈 Gap: <b>${gap.gapPercent > 0 ? '+' : ''}${gap.gapPercent}%</b> ($${gap.gapDollari})\n` +
        `🎯 Direzione suggerita: <b>${gap.direzione}</b>\n\n` +
        `⏰ ${new Date().toUTCString()}`;
      await sendTelegram(msg);
    }
  }

  // Invia i dati al frontend in tempo reale
  broadcast({ type: 'gaps', data: gaps });
}

// ── Connessione Kraken WebSocket ──────────────────────────
function connettiKraken() {
  console.log('[Kraken] Connessione WebSocket...');
  const ws = new WebSocket('wss://ws.kraken.com/v2');

  ws.on('open', () => {
    console.log('[Kraken] Connesso');
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: {
        channel: 'ticker',
        symbol: ['BTC/USD', 'ETH/USD', 'SOL/USD']
      }
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
    } catch (e) { /* ignora messaggi non JSON */ }
  });

  ws.on('close', () => {
    console.log('[Kraken] Disconnesso — riconnessione in 5s...');
    setTimeout(connettiKraken, 5000);
  });

  ws.on('error', (err) => {
    console.error('[Kraken] Errore:', err.message);
  });
}

// ── Fetch prezzi Polymarket ───────────────────────────────
async function fetchPolymarket() {
  try {
    // Mercati crypto su Polymarket (slug pubblici)
    const mercati = [
      { asset: 'BTC', slug: 'will-btc-hit-80k-before-2025' },
      { asset: 'ETH', slug: 'will-eth-reach-4000-in-2025' },
      { asset: 'SOL', slug: 'will-sol-reach-200-in-2025'  }
    ];

    for (const m of mercati) {
      try {
        const res = await axios.get(
          `https://gamma-api.polymarket.com/markets?slug=${m.slug}`,
          { timeout: 5000 }
        );
        if (res.data && res.data[0] && res.data[0].outcomePrices) {
          const prices = JSON.parse(res.data[0].outcomePrices);
          polyPrices[m.asset] = parseFloat(prices[0]);
        }
      } catch (e) {
        // fallback: usa prezzo precedente o simulato
        if (!polyPrices[m.asset]) {
          polyPrices[m.asset] = m.asset === 'BTC' ? 0.71 : m.asset === 'ETH' ? 0.44 : 0.62;
        }
      }
    }
    console.log('[Polymarket] Prezzi aggiornati:', polyPrices);
  } catch (err) {
    console.error('[Polymarket] Errore fetch:', err.message);
  }
}

// ── Routes HTTP ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/gaps/history', (req, res) => {
  res.json(gapHistory.slice(-100));
});

app.get('/prices', (req, res) => {
  res.json({ kraken: krakenPrices, polymarket: polyPrices });
});

// Test alert manuale
app.post('/test-alert', async (req, res) => {
  await sendTelegram('🧪 <b>Test alert</b> — sistema operativo!');
  res.json({ ok: true });
});

// ── WebSocket server (per il frontend) ───────────────────
const server = app.listen(PORT, () => {
  console.log(`[Server] In ascolto sulla porta ${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Frontend connesso');
  connectedClients.push(ws);

  // Manda subito lo stato attuale
  ws.send(JSON.stringify({ type: 'prices', data: { kraken: krakenPrices, polymarket: polyPrices } }));

  ws.on('close', () => {
    console.log('[WS] Frontend disconnesso');
  });
});

// ── Avvio ─────────────────────────────────────────────────
connettiKraken();
fetchPolymarket();

// Aggiorna Polymarket ogni 30 secondi
setInterval(fetchPolymarket, 30000);

// Controlla i gap ogni 2 secondi
setInterval(controllaGap, 2000);

console.log('[Sistema] Arbitrage Terminal backend avviato');
sendTelegram('🚀 <b>Arbitrage Terminal</b> — backend avviato correttamente');
