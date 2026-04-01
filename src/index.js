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
let krakenPrices = {};
let polyPrices = {};
let gapHistory = [];
let lastAlertTime = {};
let connectedClients = [];

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
    gapHistory.push(gap);
    if (gapHistory.length > 500) gapHistory.shift();

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
      params: { channel: 'ticker', symbol: ['BTC/USD', 'ETH/USD', 'SOL/USD'] }
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'ticker' && msg.data) {
        msg.data.forEach(tick => { krakenPrices[tick.symbol] = tick.last; });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('[Kraken] Disconnesso — riconnessione in 5s...');
    setTimeout(connettiKraken, 5000);
  });

  ws.on('error', (err) => console.error('[Kraken] Errore:', err.message));
}

// ── Fetch prezzi Polymarket (ricerca dinamica mercati attivi) ──
async function fetchPolymarket() {
  try {
    const keywords = {
      BTC: ['bitcoin', 'btc'],
      ETH: ['ethereum', 'eth'],
      SOL: ['solana', 'sol']
    };

    for (const [asset, kws] of Object.entries(keywords)) {
      try {
        const res = await axios.get('https://gamma-api.polymarket.com/markets', {
          params: { active: true, limit: 20, order: 'volume', ascending: false },
          timeout: 8000
        });

        if (!res.data || !res.data.length) continue;

        const mercati = res.data.filter(m => {
          const testo = (m.question || m.title || m.slug || '').toLowerCase();
          return kws.some(k => testo.includes(k)) && m.outcomePrices;
        });

        if (mercati.length > 0) {
          const mercato = mercati[0];
          const prices = typeof mercato.outcomePrices === 'string'
            ? JSON.parse(mercato.outcomePrices)
            : mercato.outcomePrices;

          const prezzo = parseFloat(prices[0]);
          if (!isNaN(prezzo) && prezzo > 0 && prezzo < 1) {
            polyPrices[asset] = prezzo;
            console.log(`[Polymarket] ${asset}: ${prezzo} — "${mercato.question || mercato.slug}"`);
          }
        }
      } catch (e) {
        console.error(`[Polymarket] Errore per ${asset}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[Polymarket] Errore generale:', err.message);
  }
}

// ── Routes HTTP ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    krakenAssets: Object.keys(krakenPrices).length,
    polyAssets: Object.keys(polyPrices).length
  });
});

app.get('/gaps/history', (req, res) => res.json(gapHistory.slice(-100)));

app.get('/prices', (req, res) => {
  res.json({ kraken: krakenPrices, polymarket: polyPrices });
});

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
  ws.send(JSON.stringify({ type: 'prices', data: { kraken: krakenPrices, polymarket: polyPrices } }));
  ws.on('close', () => console.log('[WS] Frontend disconnesso'));
});

// ── Avvio ─────────────────────────────────────────────────
connettiKraken();
fetchPolymarket();
setInterval(fetchPolymarket, 30000);
setInterval(controllaGap, 2000);

console.log('[Sistema] Arbitrage Terminal backend avviato');
sendTelegram('🚀 <b>Arbitrage Terminal</b> — backend avviato correttamente');
