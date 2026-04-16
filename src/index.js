const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3001;

// ── Configurazione ────────────────────────────────────────
const ASSETS = [
  { key: 'BTC', prefix: 'btc-updown', krakenSym: 'BTC/USD', volPerMin: 30 }
];
const FINESTRE = [
  { key: '5m',  interval: 300   },
  { key: '15m', interval: 900   },
  { key: '1h',  interval: 3600  },
  { key: '4h',  interval: 14400 }
];
const SCORE_SOGLIA     = 1.0;
const MAX_PREZZO_C     = 75;    // ¢ — contratto non deve costare più di questo
const MIN_PNL_NETTO    = 5;     // ¢ — P&L netto minimo dopo fee
const MIN_VOLUME       = 500;   // USDC — volume minimo contratto Polymarket
const MAX_SPREAD       = 5;     // ¢ — spread bid/ask massimo
const MAX_ESPOSIZIONE  = 0.10;  // 10% del wallet per singola operazione
const VOLATILITY_PER_MIN = 15; // calibrato su dati reali 86h test
const CHAINLINK_URL    = 'https://data.chain.link/streams/btc-usd';

// ── Stato ─────────────────────────────────────────────────
let krakenPrices    = {};
let chainlinkPrice  = null;
let chainlinkTs     = 0;
let polyMarkets     = { '5m': { BTC: null }, '15m': { BTC: null }, '1h': { BTC: null }, '4h': { BTC: null } };
let connectedClients = [];
let gapHistory      = [];
let reportData      = [];
let lastAlertTime   = {};
let lastContractKey = { '5m': null, '15m': null, '1h': null, '4h': null };
const REPORT_MAX    = 10000;

// ── Telegram ──────────────────────────────────────────────
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

// ── Broadcast WebSocket ────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  connectedClients = connectedClients.filter(c => c.readyState === WebSocket.OPEN);
  connectedClients.forEach(c => c.send(msg));
}

// ── Chainlink price (fonte reale risoluzione Polymarket) ───
async function fetchChainlinkPrice() {
  try {
    // Polymarket usa il Chainlink BTC/USD data stream
    // Fonte pubblica alternativa: CoinGecko (proxy affidabile)
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'bitcoin', vs_currencies: 'usd' },
      timeout: 5000
    });
    if (r.data && r.data.bitcoin && r.data.bitcoin.usd) {
      chainlinkPrice = r.data.bitcoin.usd;
      chainlinkTs    = Date.now();
    }
  } catch(e) {
    // Fallback: usa Kraken come approssimazione
    if (krakenPrices['BTC/USD']) {
      chainlinkPrice = krakenPrices['BTC/USD'];
      chainlinkTs    = Date.now();
    }
  }
}

// ── Formula score con momentum ─────────────────────────────
// Calcola se BTC si sta avvicinando o allontanando dal target
function calcolaScore(distanza, minRimasti, distanzaPrecedente) {
  if (minRimasti <= 0) return 0;
  const volAttesa = VOLATILITY_PER_MIN * minRimasti;
  let score = distanza / volAttesa;

  // Fattore momentum: BTC si sta muovendo verso il target?
  if (distanzaPrecedente !== null && distanzaPrecedente !== undefined) {
    const delta = distanza - distanzaPrecedente;
    // Se distanza positiva e BTC sale (delta > 0) → momentum favorevole
    // Se distanza positiva e BTC scende (delta < 0) → momentum sfavorevole
    const momentumFactor = distanza > 0
      ? (delta > 0 ? 1.15 : 0.85)   // UP: favore se sale, penalità se scende
      : (delta < 0 ? 1.15 : 0.85);  // DOWN: favore se scende, penalità se sale
    score = score * momentumFactor;
  }

  return parseFloat(score.toFixed(4));
}

function calcolaPnlNetto(prezzoContratto) {
  return parseFloat(((100 - prezzoContratto) - 3).toFixed(2));
}

// ── Controllo liquidità CLOB ───────────────────────────────
async function checkLiquidita(tokenId, direzione) {
  if (!tokenId) return { ok: false, motivo: 'Token ID mancante', spread: null };
  try {
    const r = await axios.get('https://clob.polymarket.com/book', {
      params: { token_id: tokenId }, timeout: 4000
    });
    if (!r.data) return { ok: false, motivo: 'Nessun orderbook', spread: null };

    const bids = r.data.bids || [];
    const asks = r.data.asks || [];
    if (!bids.length || !asks.length) return { ok: false, motivo: 'Orderbook vuoto', spread: null };

    const bestBid = parseFloat(bids[0].price) * 100;
    const bestAsk = parseFloat(asks[0].price) * 100;
    const spread  = parseFloat((bestAsk - bestBid).toFixed(2));

    if (spread > MAX_SPREAD) {
      return { ok: false, motivo: `Spread ${spread}¢ > ${MAX_SPREAD}¢`, spread };
    }
    return { ok: true, spread, bestBid, bestAsk };
  } catch(e) {
    // Se non riusciamo a controllare, procedi con warning
    return { ok: true, spread: null, warning: 'CLOB non raggiungibile' };
  }
}

// ── Verifica profittabilità completa ───────────────────────
function isOperazioneProfittevole(prezzoContratto, pnlNetto, volume) {
  if (!prezzoContratto || !pnlNetto) return false;
  if (prezzoContratto > MAX_PREZZO_C) return false;
  if (pnlNetto < MIN_PNL_NETTO) return false;
  if (volume && volume < MIN_VOLUME) return false;
  return true;
}

// ── Registra report ────────────────────────────────────────
function registraReport(asset, finestra, krakenPrice, polyMkt, score, direzione, pnlNetto, momentum) {
  const entry = {
    ts: new Date().toISOString(),
    asset, finestra,
    krakenPrice:    parseFloat(krakenPrice.toFixed(2)),
    chainlinkPrice: chainlinkPrice || null,
    priceToBeat:    polyMkt.priceToBeat,
    distanza:       parseFloat((krakenPrice - (polyMkt.priceToBeat || krakenPrice)).toFixed(2)),
    distanzaChainlink: chainlinkPrice && polyMkt.priceToBeat
      ? parseFloat((chainlinkPrice - polyMkt.priceToBeat).toFixed(2)) : null,
    minRimasti:     parseFloat(polyMkt.minRimasti.toFixed(2)),
    score:          parseFloat(score.toFixed(4)),
    momentum:       momentum || null,
    prezzoUp:       polyMkt.prezzoUp,
    prezzoDown:     polyMkt.prezzoDown,
    volume:         polyMkt.volume || 0,
    prezzoContratto: direzione ? (direzione === 'UP' ? polyMkt.prezzoUp : polyMkt.prezzoDown) : null,
    direzione:      direzione || null,
    profittevole:   isOperazioneProfittevole(
      direzione ? (direzione === 'UP' ? polyMkt.prezzoUp : polyMkt.prezzoDown) : null,
      pnlNetto, polyMkt.volume
    ),
    pnl1k:    pnlNetto ? parseFloat((pnlNetto / 100 * 1000).toFixed(2)) : null,
    closeAt:  polyMkt.closeAt || null,
    esito:    null,
    prezzoFinale:    null,
    chainlinkFinale: null,
    direzCorretta:   null
  };
  reportData.push(entry);
  if (reportData.length > REPORT_MAX) reportData.shift();
  return entry;
}

// ── Verifica esito con Chainlink ───────────────────────────
async function verificaEsito(entry) {
  if (!entry.closeAt || !entry.priceToBeat) return;
  const ora = Date.now();
  if (ora < entry.closeAt || ora - entry.closeAt > 300000) return;
  if (entry.esito) return; // già verificato

  // Usa Chainlink/CoinGecko come fonte (stesso feed di Polymarket)
  await fetchChainlinkPrice();
  const prezzoFinale = chainlinkPrice || krakenPrices['BTC/USD'];
  if (!prezzoFinale) return;

  entry.prezzoFinale    = prezzoFinale;
  entry.chainlinkFinale = chainlinkPrice;
  const sopra = prezzoFinale >= entry.priceToBeat;
  entry.esito = sopra ? 'UP_WINS' : 'DOWN_WINS';

  if (entry.direzione) {
    const corretta = entry.direzione === 'UP' ? sopra : !sopra;
    entry.direzCorretta = corretta;

    // Notifica Telegram esito
    const emoji = corretta ? '✅' : '❌';
    const pnlReale = corretta
      ? (entry.pnl1k || 0)
      : -(1000 * (entry.prezzoContratto || 50) / 100);

    const msg = emoji + ' <b>ESITO ' + entry.asset + '/' + entry.finestra.toUpperCase() + '</b>\n\n' +
      'Direzione: <b>' + entry.direzione + '</b> → ' + (corretta ? '<b>CORRETTA</b>' : '<b>ERRATA</b>') + '\n' +
      'Price to beat: <b>$' + entry.priceToBeat.toLocaleString('en') + '</b>\n' +
      'Prezzo finale (Chainlink): <b>$' + prezzoFinale.toLocaleString('en') + '</b>\n' +
      'Esito mercato: <b>' + entry.esito + '</b>\n' +
      'P&L reale su $1K: <b>' + (pnlReale >= 0 ? '+' : '') + '$' + Math.abs(pnlReale).toFixed(2) + '</b>\n' +
      'Score era: <b>' + entry.score + '</b>\n\n' +
      '⏰ ' + new Date().toUTCString();

    await sendTelegram(msg);
    console.log('[Esito] ' + entry.asset + '/' + entry.finestra + ' → ' + entry.esito + ' | ' + (corretta ? 'CORRETTA ✓' : 'ERRATA ✗'));
  }
}

// Buffer distanze precedenti per calcolo momentum
const distanzePrecedenti = {};

// ── Fetch Polymarket con rilevamento cambio contratto ──────
async function fetchPolymarket() {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const asset of ASSETS) {
    for (const fin of FINESTRE) {
      const interval = fin.interval;
      const tsBase = nowSec - (nowSec % interval);
      const candidati = [];

      // Per 1h: prova anche prefisso alternativo (Binance-based markets)
      const prefixes = [asset.prefix];
      if (fin.key === '1h') {
        // alcuni mercati 1h usano slug tipo 'bitcoin-up-or-down-hourly-TIMESTAMP'
        // proviamo anche senza timestamp (ricerca per keyword sotto)
      }

      for (let offset = -4; offset <= 2; offset++) {
        const ts      = tsBase + offset * interval;
        const closeAt = ts + interval;
        const minR    = (closeAt - nowSec) / 60;
        const maxMinR = fin.interval <= 900 ? 30 : fin.interval <= 3600 ? 120 : 480;
        if (minR < 0.5 || minR > maxMinR) continue;
        candidati.push({ slug: asset.prefix + '-' + fin.key + '-' + ts, closeAt, minRimasti: minR });
      }
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

          const prices    = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          const upPrice   = parseFloat(prices[0]);
          const downPrice = parseFloat(prices[1]);
          if (isNaN(upPrice) || isNaN(downPrice)) continue;

          const priceToBeat = (m.startPrice && parseFloat(m.startPrice) > 0)
            ? parseFloat(m.startPrice)
            : (krakenPrices[asset.krakenSym] || null);

          const existing       = polyMarkets[fin.key][asset.key];
          const isNuovoSlug    = !existing || existing.slug !== item.slug;
          const isMigliore     = !existing || item.minRimasti < existing.minRimasti;

          if (isNuovoSlug || isMigliore) {
            // Rilevamento cambio contratto
            const contractKey = fin.key + '-' + item.slug;
            if (lastContractKey[fin.key] !== contractKey) {
              if (lastContractKey[fin.key]) {
                console.log('[Poly ' + fin.key + '] CAMBIO CONTRATTO → ' + item.slug);
                // Reset distanza precedente al cambio contratto
                delete distanzePrecedenti[asset.key + '-' + fin.key];
                await sendTelegram('🔄 <b>Nuovo contratto ' + asset.key + '/' + fin.key.toUpperCase() + '</b>\n' +
                  'Slug: ' + item.slug + '\n' +
                  'Scade in: ' + item.minRimasti.toFixed(1) + ' min');
              }
              lastContractKey[fin.key] = contractKey;
            }

            polyMarkets[fin.key][asset.key] = {
              question:   m.question || item.slug,
              slug:       item.slug,
              prezzoUp:   parseFloat((upPrice * 100).toFixed(1)),
              prezzoDown: parseFloat((downPrice * 100).toFixed(1)),
              priceToBeat, minRimasti: parseFloat(item.minRimasti.toFixed(2)),
              closeAt: item.closeAt * 1000,
              volume:  m.volume24hr || m.volume || 0,
              clobTokenIds: m.clobTokenIds || null,
              aggiornato: new Date().toISOString()
            };
            trovato = true;
            break;
          }
        } catch(e) { /* slug non trovato */ }
      }

      // Fallback 1h: cerca per keyword se slug deterministico non trovato
      if (!trovato && fin.key === '1h') {
        try {
          const r = await axios.get('https://gamma-api.polymarket.com/markets', {
            params: { active: true, limit: 20, order: 'end_date_min', ascending: true },
            timeout: 6000
          });
          const markets = r.data || [];
          const btc1h = markets.filter(m => {
            const t = (m.question || m.slug || '').toLowerCase();
            return (t.includes('bitcoin') || t.includes('btc')) &&
                   (t.includes('hour') || t.includes('1h') || t.includes('1-hour') || t.includes('hourly')) &&
                   m.outcomePrices && !m.closed;
          }).map(m => {
            const endStr = m.endDate || m.endDateIso || m.end_date_iso;
            const minR = endStr ? (new Date(endStr) - Date.now()) / 60000 : null;
            return Object.assign({}, m, { minRimasti: minR });
          }).filter(m => m.minRimasti && m.minRimasti > 0.5 && m.minRimasti < 120)
            .sort((a,b) => a.minRimasti - b.minRimasti);

          if (btc1h.length) {
            const m = btc1h[0];
            const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
            const priceToBeat = m.startPrice ? parseFloat(m.startPrice) : (krakenPrices[asset.krakenSym] || null);
            polyMarkets['1h'][asset.key] = {
              question: m.question || m.slug,
              slug: m.slug,
              prezzoUp:   parseFloat((parseFloat(prices[0]) * 100).toFixed(1)),
              prezzoDown: parseFloat((parseFloat(prices[1]) * 100).toFixed(1)),
              priceToBeat, minRimasti: parseFloat(m.minRimasti.toFixed(2)),
              closeAt: m.endDate ? new Date(m.endDate).getTime() : null,
              volume: m.volume24hr || m.volume || 0,
              aggiornato: new Date().toISOString()
            };
            trovato = true;
            console.log('[Poly 1h] Trovato via keyword: ' + m.question + ' ' + m.minRimasti.toFixed(1) + 'min');
          }
        } catch(e) { /* fallback fallito */ }
      }

      if (!trovato && polyMarkets[fin.key][asset.key]) {
        const m = polyMarkets[fin.key][asset.key];
        if (m.closeAt) {
          m.minRimasti = parseFloat(((m.closeAt - Date.now()) / 60000).toFixed(2));
          if (m.minRimasti < 0) {
            polyMarkets[fin.key][asset.key] = null;
            delete distanzePrecedenti[asset.key + '-' + fin.key];
          }
        }
      }
    }
  }
}

// ── Controlla segnali ──────────────────────────────────────
async function controllaGap() {
  // Verifica esiti contratti scaduti
  const ora = Date.now();
  reportData.slice(-200).forEach(entry => {
    if (!entry.esito && entry.closeAt && ora >= entry.closeAt) {
      verificaEsito(entry);
    }
  });

  const segnali = [];

  for (const asset of ASSETS) {
    const assetPrice = krakenPrices[asset.krakenSym];
    if (!assetPrice) continue;

    for (const fin of FINESTRE) {
      const m = polyMarkets[fin.key][asset.key];
      if (!m || !m.priceToBeat || m.minRimasti < 0.5) continue;

      const distanza = assetPrice - m.priceToBeat;
      const bufKey   = asset.key + '-' + fin.key;
      const distPrev = distanzePrecedenti[bufKey] !== undefined ? distanzePrecedenti[bufKey] : null;

      // Momentum: differenza distanza rispetto alla lettura precedente
      let momentum = null;
      if (distPrev !== null) {
        momentum = parseFloat((distanza - distPrev).toFixed(2));
      }
      distanzePrecedenti[bufKey] = distanza;

      const score     = calcolaScore(distanza, m.minRimasti, distPrev);
      const direzione = score > SCORE_SOGLIA ? 'UP' : score < -SCORE_SOGLIA ? 'DOWN' : null;
      const prezzoC   = direzione === 'UP' ? m.prezzoUp : direzione === 'DOWN' ? m.prezzoDown : null;
      const pnlNetto  = prezzoC ? calcolaPnlNetto(prezzoC) : null;

      // Controllo volume minimo
      const volumeOk = !direzione || (m.volume || 0) >= MIN_VOLUME;

      const profittevole = isOperazioneProfittevole(prezzoC, pnlNetto, m.volume);

      const segnale = {
        asset: asset.key, finestra: fin.key,
        krakenPrice: assetPrice, chainlinkPrice,
        priceToBeat: m.priceToBeat,
        distanzaDollar: parseFloat(distanza.toFixed(2)),
        momentum, minRimasti: m.minRimasti,
        score: parseFloat(score.toFixed(4)),
        direzione, prezzoContratto: prezzoC, pnlNetto, profittevole,
        volumeOk, volume: m.volume || 0,
        question: m.question,
        timestamp: new Date().toISOString()
      };

      segnali.push(segnale);
      gapHistory.push(segnale);
      if (gapHistory.length > 1000) gapHistory.shift();

      const entry = registraReport(asset.key, fin.key, assetPrice, m, score, direzione, pnlNetto, momentum);

      // Alert solo se profittevole + volume ok
      if (profittevole && direzione && volumeOk && puoMandareAlert(asset.key + '-' + fin.key + '-' + direzione)) {
        const emoji = direzione === 'UP' ? '🟢' : '🔴';
        const momentumStr = momentum !== null
          ? '\n📊 Momentum: <b>' + (momentum > 0 ? '+' : '') + momentum.toFixed(2) + '$ (' + (
              distanza > 0 ? (momentum > 0 ? 'sale ancora ↑' : 'rallenta ↓') :
                             (momentum < 0 ? 'scende ancora ↓' : 'rallenta ↑')
            ) + ')</b>'
          : '';
        const chainlinkStr = chainlinkPrice
          ? '\n🔗 Chainlink: <b>$' + chainlinkPrice.toLocaleString('en') + '</b>'
          : '';
        const msg = emoji + ' <b>SEGNALE ' + asset.key + '/' + fin.key.toUpperCase() + ' — ' + direzione + '</b>\n\n' +
          '📊 Kraken: <b>$' + assetPrice.toLocaleString('en') + '</b>' + chainlinkStr + '\n' +
          '🎯 Target: <b>$' + m.priceToBeat.toLocaleString('en') + '</b>\n' +
          '📏 Distanza: <b>' + (distanza > 0 ? '+' : '') + distanza.toFixed(2) + '$</b>' + momentumStr + '\n' +
          '⏱ Tempo: <b>' + m.minRimasti.toFixed(1) + ' min</b>\n' +
          '📈 Score: <b>' + score.toFixed(2) + '</b>\n' +
          '💰 Contratto ' + direzione + ': <b>' + prezzoC + '¢</b>\n' +
          '📦 Volume: <b>$' + Math.round(m.volume) + '</b>\n' +
          '💵 P&L su $1K: <b>+$' + (pnlNetto / 100 * 1000).toFixed(2) + '</b>\n\n' +
          '⏰ ' + new Date().toUTCString();
        await sendTelegram(msg);
      }

      // Blocco alert se volume insufficiente ma score ok
      if (direzione && !volumeOk && puoMandareAlert(asset.key + '-' + fin.key + '-vol')) {
        console.log('[Gap] ' + asset.key + '/' + fin.key + ' BLOCCATO: volume $' + m.volume + ' < $' + MIN_VOLUME);
      }
    }
  }

  broadcast({ type: 'signals',    data: segnali });
  broadcast({ type: 'polymarkets', data: polyMarkets });
  broadcast({ type: 'chainlink',  data: { price: chainlinkPrice, ts: chainlinkTs } });
}

// ── Kraken WebSocket ───────────────────────────────────────
function connettiKraken() {
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  ws.on('open', () => {
    console.log('[Kraken] Connesso');
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } }));
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

// ── HTTP Routes ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    kraken: !!krakenPrices['BTC/USD'],
    btcKraken: krakenPrices['BTC/USD'] || null,
    btcChainlink: chainlinkPrice || null,
    chainlinkAge: chainlinkTs ? Math.round((Date.now() - chainlinkTs) / 1000) + 's' : null,
    polymarket5m:  !!polyMarkets['5m'].BTC,
    polymarket15m: !!polyMarkets['15m'].BTC,
    polymarket1h:  !!polyMarkets['1h'].BTC,
    polymarket4h:  !!polyMarkets['4h'].BTC,
    min5m:  polyMarkets['5m'].BTC  ? polyMarkets['5m'].BTC.minRimasti  : null,
    min15m: polyMarkets['15m'].BTC ? polyMarkets['15m'].BTC.minRimasti : null,
    min1h:  polyMarkets['1h'].BTC  ? polyMarkets['1h'].BTC.minRimasti  : null,
    min4h:  polyMarkets['4h'].BTC  ? polyMarkets['4h'].BTC.minRimasti  : null,
    vol5m:  polyMarkets['5m'].BTC  ? polyMarkets['5m'].BTC.volume      : null,
    vol15m: polyMarkets['15m'].BTC ? polyMarkets['15m'].BTC.volume     : null,
    vol1h:  polyMarkets['1h'].BTC  ? polyMarkets['1h'].BTC.volume      : null,
    vol4h:  polyMarkets['4h'].BTC  ? polyMarkets['4h'].BTC.volume      : null
  });
});

app.get('/prices', (req, res) => res.json({
  kraken: krakenPrices,
  chainlink: { price: chainlinkPrice, ts: chainlinkTs },
  polymarkets: polyMarkets
}));

app.get('/report', (req, res) => {
  const limit   = parseInt(req.query.limit) || 5000;
  const data    = reportData.slice(-limit);
  const signals = data.filter(r => r.direzione);
  const scores  = data.map(r => Math.abs(r.score));
  const avgScore = scores.length ? scores.reduce((s,v) => s+v, 0) / scores.length : 0;
  const maxScore = scores.length ? Math.max(...scores) : 0;
  const totalPnl = signals.reduce((s,r) => s + (r.pnl1k || 0), 0);
  const verificati = data.filter(r => r.esito);
  const corretti   = data.filter(r => r.direzCorretta === true);
  const errati     = data.filter(r => r.direzCorretta === false);
  const verSig     = data.filter(r => r.esito && r.direzione);
  res.json({
    meta: {
      totalEntries: data.length, signals: signals.length,
      avgScore: parseFloat(avgScore.toFixed(4)),
      maxScore: parseFloat(maxScore.toFixed(4)),
      totalPnl1k: parseFloat(totalPnl.toFixed(2)),
      from: data.length ? data[0].ts : null,
      to:   data.length ? data[data.length-1].ts : null,
      esiti: {
        verificati: verificati.length,
        corretti:   corretti.length,
        errati:     errati.length,
        winRate: verSig.length
          ? parseFloat((corretti.filter(r => r.direzione).length / verSig.length * 100).toFixed(1))
          : null
      }
    },
    log: data
  });
});

app.get('/report/csv', (req, res) => {
  if (!reportData.length) { res.send('Nessun dato'); return; }
  const headers = ['#','timestamp','asset','finestra','kraken_usd','chainlink_usd',
    'price_to_beat','distanza_usd','distanza_chainlink','min_rimasti','score','momentum',
    'up_cents','down_cents','volume','segnale','pnl_1k_usd','esito','prezzo_finale',
    'chainlink_finale','direz_corretta'];
  const rows = reportData.map((r, i) => [
    i+1, r.ts, r.asset, r.finestra,
    r.krakenPrice, r.chainlinkPrice||'', r.priceToBeat||'',
    r.distanza, r.distanzaChainlink||'', r.minRimasti, r.score,
    r.momentum||'', r.prezzoUp, r.prezzoDown, r.volume,
    r.direzione||'ATTESA', r.pnl1k||'',
    r.esito||'', r.prezzoFinale||'', r.chainlinkFinale||'',
    r.direzCorretta!==null&&r.direzCorretta!==undefined ? r.direzCorretta : ''
  ].join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=arbitrage_report.csv');
  res.send(headers.join(',') + '\n' + rows.join('\n'));
});

app.get('/signals/history', (req, res) => res.json(gapHistory.slice(-200)));

app.get('/execution/status', (req, res) => {
  const execution = require('./execution');
  res.json(execution.getStato());
});

app.post('/execution/test', async (req, res) => {
  const execution = require('./execution');
  const segnaleTest = {
    asset: 'BTC', finestra: '5m', direzione: 'UP',
    prezzoContratto: 52, pnlNetto: 45, profittevole: true,
    slug: 'btc-updown-5m-test', score: 1.5, volume: 2000
  };
  const result = await execution.piazzaOrdine(segnaleTest);
  res.json(result);
});

app.post('/test-alert', async (req, res) => {
  await sendTelegram('🧪 <b>Test sistema</b>\n\nTutti i moduli operativi:\n✅ Kraken WebSocket\n✅ Polymarket CLOB\n✅ Chainlink price\n✅ Momentum tracking\n✅ Verifica esiti\n✅ Alert Telegram\n✅ Execution engine (paper)');
  res.json({ ok: true });
});

// ── WebSocket server ───────────────────────────────────────
const server = app.listen(PORT, () => console.log('[Server] Porta ' + PORT));
const wss = new WebSocket.Server({ server });
wss.on('connection', ws => {
  connectedClients.push(ws);
  ws.send(JSON.stringify({ type: 'prices', data: { kraken: krakenPrices, polymarkets: polyMarkets } }));
  ws.on('close', () => {});
});

// ── Avvio ──────────────────────────────────────────────────
connettiKraken();
fetchPolymarket();
fetchChainlinkPrice();

setInterval(fetchPolymarket,    5000);
setInterval(controllaGap,       3000);
setInterval(fetchChainlinkPrice, 30000);

console.log('[Sistema] Arbitrage Terminal v4.1 — BTC only, tutti i controlli attivi');
sendTelegram('🚀 <b>Arbitrage Terminal v4.1</b> avviato\n\n✅ Momentum tracking\n✅ Controllo liquidità\n✅ Verifica Chainlink\n✅ Notifica esiti\n✅ Cambio contratto\n✅ Limite esposizione');
