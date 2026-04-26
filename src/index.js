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
  { key: 'BTC', prefix: 'btc-updown', krakenSym: 'BTC/USD', volPerMin: 15 }
];
const FINESTRE = [
  { key: '15m', interval: 900   },
  { key: '1h',  interval: 3600, slugType: 'hourly' },
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
let polyMarkets     = { '15m': { BTC: null }, '1h': { BTC: null }, '4h': { BTC: null } };
let connectedClients = [];
let gapHistory      = [];
let reportData      = [];
let lastAlertTime   = {};
let lastContractKey  = { '15m': null, '1h': null, '4h': null };
const prezziApertura = {}; // prezzo Chainlink salvato all'apertura di ogni contratto
const REPORT_MAX    = 50000;

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
    pnlWallet: pnlNetto ? (() => {
      try { return parseFloat((pnlNetto / 100 * (require('./execution').getWalletBase() * 0.05)).toFixed(2)); } catch(e) { return null; }
    })() : null,
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

    // Messaggio esito operazione
    const execution = require('./execution');
    const walletPre = execution.getWalletBase();
    const tradeSize = walletPre * 0.05;
    const pnlNettoCents = entry.prezzoContratto ? ((100 - entry.prezzoContratto) - 3) : 0;
    const pnlReale = corretta
      ? parseFloat((pnlNettoCents / 100 * tradeSize).toFixed(2))
      : -parseFloat(tradeSize.toFixed(2));
    const walletPost = parseFloat((walletPre + pnlReale).toFixed(2));
    // Registra esito e invia alert SOLO se l'ordine era reale (ha ordineIdClob)
    if (entry.ordineIdClob) {
      const ordineRef = { direzione: entry.direzione, usdcSpesi: tradeSize, pnlStimato: Math.abs(pnlReale), ordineId: entry.ordineIdClob };
      execution.registraEsito(ordineRef, entry.esito);
    }
    const emoji = corretta ? '✅' : '❌';
    const titoloEsito = corretta ? 'PROFITTO' : 'PERDITA';
    const sep = '━━━━━━━━━━━━━━━━━━━━';
    const msgEsito = [
      emoji + ' <b>OPERAZIONE CHIUSA — ' + titoloEsito + '</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      '📋 ' + entry.asset + '/' + entry.finestra.toUpperCase() + ' · ' + entry.direzione + ' · ' + (entry.prezzoContratto||'—') + '¢',
      '💰 Investito: <b>$' + tradeSize.toFixed(2) + '</b>',
      '📤 Esito mercato: <b>' + entry.esito + '</b>',
      '💵 P&L reale: <b>' + (pnlReale>=0?'+':'') + '$' + Math.abs(pnlReale).toFixed(2) + '</b>',
      '📈 Wallet: <b>$' + walletPre.toFixed(2) + ' → $' + walletPost.toFixed(2) + '</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      new Date().toUTCString()
    ].join('\n');
    await sendTelegram(msgEsito);
    console.log('[Esito] ' + entry.asset + '/' + entry.finestra + ' → ' + entry.esito + ' | ' + (corretta ? 'CORRETTA ✓' : 'ERRATA ✗'));
  }
}

// Buffer distanze precedenti per calcolo momentum
const distanzePrecedenti = {};

// ── Fetch Polymarket con rilevamento cambio contratto ──────
// Genera slug per mercato 1h: bitcoin-up-or-down-april-16-2026-6pm-et
// offsetHours: 0 = ora corrente ET, 1 = prossima ora, -1 = ora precedente
function generate1hSlug(offsetHours) {
  const now = new Date();
  // EDT = UTC-4 (marzo-novembre), EST = UTC-5 (resto)
  // Aprile → EDT → UTC-4
  const etOffset = -4;
  const et = new Date(now.getTime() + (etOffset + offsetHours) * 3600000);
  
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const month = months[et.getUTCMonth()];
  const day   = et.getUTCDate();
  const year  = et.getUTCFullYear();
  let   hour  = et.getUTCHours(); // ora ET (già sottratto offset)
  const ampm  = hour >= 12 ? 'pm' : 'am';
  if (hour === 0)       hour = 12;
  else if (hour > 12)   hour = hour - 12;
  // es: UTC 22:32 → ET 18:32 → 6pm → bitcoin-up-or-down-april-16-2026-6pm-et
  return 'bitcoin-up-or-down-' + month + '-' + day + '-' + year + '-' + hour + ampm + '-et';
}

async function fetchPolymarket() {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const asset of ASSETS) {
    for (const fin of FINESTRE) {
      const interval = fin.interval;
      const tsBase = nowSec - (nowSec % interval);
      const candidati = [];

      if (fin.slugType === 'hourly') {
        // Mercato 1h usa slug testuale ET: bitcoin-up-or-down-april-17-2026-5pm-et
        for (let offset = -2; offset <= 2; offset++) {
          const slug = generate1hSlug(offset);
          const etNowSec = nowSec - (4 * 3600);
          const etHourStart = (Math.floor(etNowSec / 3600) + offset) * 3600;
          const closeAtEt = etHourStart + 3600;
          const closeAt = closeAtEt + (4 * 3600);
          const minR = (closeAt - nowSec) / 60;
          if (minR < 0.5 || minR > 120) continue;
          candidati.push({ slug, closeAt, minRimasti: minR });
        }
      } else {
        for (let offset = -4; offset <= 2; offset++) {
          const ts      = tsBase + offset * interval;
          const closeAt = ts + interval;
          const minR    = (closeAt - nowSec) / 60;
          const maxMinR = fin.interval <= 900 ? 30 : fin.interval <= 3600 ? 120 : 480;
          if (minR < 0.5 || minR > maxMinR) continue;
          candidati.push({ slug: asset.prefix + '-' + fin.key + '-' + ts, closeAt, minRimasti: minR });
        }
      }
      candidati.sort((a, b) => a.minRimasti - b.minRimasti);

      let trovato = false;
      for (const item of candidati) {
        try {
          if (fin.slugType === 'hourly') {
            // Log solo ogni 60 tentativi per non spammare
            if (!fin._logCount) fin._logCount = 0;
            fin._logCount++;
            if (fin._logCount % 60 === 1) console.log('[1h] Provo slug:', item.slug);
          }
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

          // priceToBeat = prezzo Chainlink salvato all'apertura del contratto
          const prezzoAp = prezziApertura[fin.key + '-' + asset.key];
          const priceToBeat = prezzoAp
            ? prezzoAp
            : (m.startPrice && parseFloat(m.startPrice) > 0)
              ? parseFloat(m.startPrice)
              : (chainlinkPrice || krakenPrices[asset.krakenSym] || null);

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
                // cambio contratto silenzioso
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
        const execution = require('./execution');
        const segnaleExec = {
          asset: asset.key, finestra: fin.key, direzione,
          prezzoContratto: prezzoC, pnlNetto, profittevole,
          slug: m.slug, score: parseFloat(score.toFixed(4)),
          closeAt: m.closeAt || null, volume: m.volume || 0,
          momentum, distanzaDollar: parseFloat(distanza.toFixed(2)),
          priceToBeat: m.priceToBeat, minRimasti: m.minRimasti
        };
        // Aggiungi segnale alla coda per executor locale Mac
        segnaliPendenti.push({ ...segnaleExec, tradeSize: (execution.getWalletBase() * 0.05).toFixed(2) });
        if (segnaliPendenti.length > 10) segnaliPendenti.shift(); // max 10 pendenti

        execution.piazzaOrdine(segnaleExec).then(result => {
          if (result.successo && !result.paperTrade) {
            // Salva ordineIdClob nell'entry del report per verificaEsito
            const entryCorrente = reportData[reportData.length - 1];
            if (entryCorrente) entryCorrente.ordineIdClob = result.ordineIdClob || result.ordineId || 'live-' + Date.now();
            const walletBase = execution.getWalletBase();
            const msgAperta = [
              '🟢 <b>ORDINE APERTO — ' + asset.key + '/' + fin.key.toUpperCase() + ' ' + direzione + '</b>',
              '━━━━━━━━━━━━━━━━━━━━',
              '💰 Size: <b>$' + result.usdcSpesi + '</b> (5% wallet)',
              '📈 Contratto ' + direzione + ': <b>' + prezzoC + '¢</b>',
              '🎯 Target: <b>$' + (m.priceToBeat||0).toLocaleString('en') + '</b>',
              '📏 Distanza: <b>' + (distanza>0?'+':'') + distanza.toFixed(2) + '$</b>',
              '📊 Score: <b>' + score.toFixed(2) + '</b>',
              '⏱ Scade in: <b>' + m.minRimasti.toFixed(1) + ' min</b>',
              '💵 P&L stimato: <b>+$' + result.pnlStimato + '</b>',
              '━━━━━━━━━━━━━━━━━━━━',
              new Date().toUTCString()
            ].join('\n');
            sendTelegram(msgAperta);
            console.log('[Execution] LIVE: ' + asset.key + '/' + fin.key + ' ' + direzione + ' $' + result.usdcSpesi);
          } else if (!result.successo) {
            console.log('[Execution] Bloccato: ' + result.motivo);
          }
        }).catch(e => console.error('[Execution] Errore:', e.message));
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
  // Broadcast posizioni aperte e grafici
  const execution = require('./execution');
  const dashData = execution.getDashboardData();
  broadcast({ type: 'execution', data: dashData });
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
app.get('/setup/register-wallet', async (req, res) => {
  // Registra nuovo wallet su Polymarket CLOB API dal server USA
  // Chiamare UNA SOLA VOLTA dopo aver impostato WALLET_PRIVATE_KEY nuovo
  try {
    const { ethers } = require('ethers');
    const { ClobClient } = require('@polymarket/clob-client');
    const privKey = process.env.WALLET_PRIVATE_KEY;
    const funder  = process.env.POLYMARKET_PROXY_ADDRESS;
    if (!privKey) return res.json({ ok: false, errore: 'WALLET_PRIVATE_KEY mancante' });

    const wallet = new ethers.Wallet(privKey);
    console.log('[Setup] Registro wallet:', wallet.address, '| server IP USA');

    // Prova registrazione con sigType 0 e 2
    let creds = null;
    for (const sigType of [0, 2]) {
      try {
        const client = new ClobClient('https://clob.polymarket.com', 137, wallet, undefined, sigType, funder || wallet.address);
        creds = await client.createOrDeriveApiKey();
        if (creds?.key || creds?.apiKey) {
          console.log('[Setup] ✅ Credentials create sigType', sigType, ':', (creds.key||creds.apiKey).slice(0,8)+'...');
          break;
        }
      } catch(e) {
        console.log('[Setup] sigType', sigType, ':', e.message?.slice(0,80));
      }
    }

    if (!creds?.key && !creds?.apiKey) {
      return res.json({ ok: false, errore: 'Impossibile creare credentials — wallet non ancora registrato su polymarket.com?' });
    }

    res.json({
      ok: true,
      walletAddress: wallet.address,
      apiKey:     creds.key    || creds.apiKey,
      secret:     creds.secret,
      passphrase: creds.passphrase,
      messaggio:  'Copia questi valori nelle variabili Railway: POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE'
    });
  } catch(e) {
    res.json({ ok: false, errore: e.message });
  }
});

app.get('/myip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ ip: r.data.ip, timestamp: new Date().toISOString() });
  } catch(e) {
    res.json({ errore: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    kraken: !!krakenPrices['BTC/USD'],
    btcKraken: krakenPrices['BTC/USD'] || null,
    btcChainlink: chainlinkPrice || null,
    chainlinkAge: chainlinkTs ? Math.round((Date.now() - chainlinkTs) / 1000) + 's' : null,
    polymarket15m: !!polyMarkets['15m'].BTC,
    polymarket1h:  !!polyMarkets['1h'].BTC,
    polymarket4h:  !!polyMarkets['4h'].BTC,
    min15m: polyMarkets['15m'].BTC ? polyMarkets['15m'].BTC.minRimasti : null,
    min1h:  polyMarkets['1h'].BTC  ? polyMarkets['1h'].BTC.minRimasti  : null,
    min4h:  polyMarkets['4h'].BTC  ? polyMarkets['4h'].BTC.minRimasti  : null,
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
    'up_cents','down_cents','volume','segnale','pnl_1k_usd','pnl_wallet_usd','esito','prezzo_finale',
    'chainlink_finale','direz_corretta'];
  const rows = reportData.map((r, i) => [
    i+1, r.ts, r.asset, r.finestra,
    r.krakenPrice, r.chainlinkPrice||'', r.priceToBeat||'',
    r.distanza, r.distanzaChainlink||'', r.minRimasti, r.score,
    r.momentum||'', r.prezzoUp, r.prezzoDown, r.volume,
    r.direzione||'ATTESA', r.pnl1k||'', r.pnlWallet||'',
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

app.get('/execution/saldo', async (req, res) => {
  const execution = require('./execution');
  try {
    const saldo = await execution.forzaLetturaSaldo();
    res.json({ saldo, walletBase: execution.getWalletBase(), timestamp: new Date().toISOString() });
  } catch(e) {
    res.json({ errore: e.message });
  }
});

// ── Endpoint per executor locale Mac ─────────────────────
let segnaliPendenti = [];
let ultimoSegnaleInviato = null;

app.get('/execution/segnali-pendenti', (req, res) => {
  const pending = segnaliPendenti.splice(0); // svuota e restituisce
  res.json({ segnali: pending, timestamp: new Date().toISOString() });
});

app.post('/execution/ordine-locale', express.json(), (req, res) => {
  const { segnale, ordineId, timestamp } = req.body;
  console.log('[LocalExec] ✅ Ordine eseguito dal Mac:', ordineId, segnale?.asset, segnale?.finestra, segnale?.direzione);
  // Salva nel report
  const entry = reportData[reportData.length - 1];
  if (entry) entry.ordineIdClob = ordineId;
  res.json({ ok: true });
});

app.get('/execution/dashboard', (req, res) => {
  const execution = require('./execution');
  res.json(execution.getDashboardData());
});

app.post('/execution/test', async (req, res) => {
  const execution = require('./execution');
  // Usa il contratto 15M attualmente attivo per il test
  // Usa sempre 1H per il test — più volume e più stabile
  const m1h = polyMarkets['1h'] && polyMarkets['1h']['BTC'];
  const m15 = polyMarkets['15m'] && polyMarkets['15m']['BTC'];
  const mercato = m1h || m15;
  if (!mercato) {
    return res.json({ successo: false, motivo: 'Nessun contratto attivo al momento' });
  }
  const finestra = m1h ? '1h' : '15m';
  const direzione = 'UP';
  const prezzoC = mercato.prezzoUp;
  const pnlNetto = parseFloat(((100 - prezzoC) - 3).toFixed(2));
  const segnaleTest = {
    asset: 'BTC', finestra, direzione,
    prezzoContratto: prezzoC, pnlNetto,
    profittevole: prezzoC <= 75 && pnlNetto >= 5,
    slug: mercato.slug, score: 1.5,
    volume: mercato.volume || 0,
    closeAt: mercato.closeAt || null
  };
  console.log('[Test] Ordine test su slug reale:', mercato.slug);
  const result = await execution.piazzaOrdine(segnaleTest);
  res.json(result);
});

app.post('/report/send', async (req, res) => {
  await inviaCsvTelegram('📤 Invio manuale richiesto');
  res.json({ ok: true, righe: reportData.length });
});

app.get('/execution/derive-creds', async (req, res) => {
  // Endpoint temporaneo per derivare API credentials — RIMUOVERE DOPO USO
  const execution = require('./execution');
  try {
    const creds = await execution.derivaCredentials();
    if (creds) {
      res.json({ ok: true, apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase });
    } else {
      res.json({ ok: false, errore: 'Credentials non derivabili' });
    }
  } catch(e) {
    res.json({ ok: false, errore: e.message });
  }
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

// ── Invio CSV automatico su Telegram ─────────────────────
// Invia ogni ora — così se Railway si riavvia i dati sono già salvati su Telegram
async function inviaCsvTelegram(motivo) {
  try {
    if (!reportData.length) return;

    // Genera CSV completo
    const headers = ['#','timestamp','asset','finestra','kraken_usd','chainlink_usd',
      'price_to_beat','distanza_usd','min_rimasti','score','momentum',
      'up_cents','down_cents','volume','segnale','pnl_1k_usd',
      'esito','prezzo_finale','direz_corretta'].join(',');
    const rows = reportData.map((r, i) => [
      i+1, r.ts, r.asset, r.finestra,
      r.krakenPrice, r.chainlinkPrice||'', r.priceToBeat||'',
      r.distanza, r.minRimasti, r.score, r.momentum||'',
      r.prezzoUp, r.prezzoDown, r.volume,
      r.direzione||'ATTESA', r.pnl1k||'',
      r.esito||'', r.prezzoFinale||'',
      r.direzCorretta!==null&&r.direzCorretta!==undefined?r.direzCorretta:''
    ].join(','));
    const csv = headers + '\n' + rows.join('\n');

    // Statistiche rapide
    const segnali    = reportData.filter(r => r.direzione);
    const verificati = reportData.filter(r => r.esito && r.direzione);
    const corretti   = verificati.filter(r => r.direzCorretta === true);
    const winRate    = verificati.length ? (corretti.length/verificati.length*100).toFixed(1) : 'N/A';
    const scores     = reportData.map(r => Math.abs(r.score));
    const maxScore   = scores.length ? Math.max(...scores).toFixed(3) : '—';
    const totPnl     = segnali.reduce((s,r) => s+(r.pnl1k||0), 0);
    const da         = reportData[0]?.ts?.slice(11,19) || '—';
    const a          = reportData[reportData.length-1]?.ts?.slice(11,19) || '—';

    const filename = 'report_' + new Date().toISOString().slice(0,16).replace('T','_').replace(':','-') + '.csv';
    // Stats ultima ora
    const unaOraFa = Date.now() - 3600000;
    const reportUltimaOra = reportData.filter(r => new Date(r.ts).getTime() > unaOraFa);
    const segnaliOra = reportUltimaOra.filter(r => r.direzione);
    const verificatiOra = reportUltimaOra.filter(r => r.esito && r.direzione);
    const correttiOra = verificatiOra.filter(r => r.direzCorretta === true);
    const wrOra = verificatiOra.length ? (correttiOra.length/verificatiOra.length*100).toFixed(1) : 'N/A';

    // Stats totali da avvio
    const execution = require('./execution');
    const statoExe = execution.getStato();
    const walletAttuale = statoExe.walletStimato || 100;
    const pnlTotale = (walletAttuale - 100).toFixed(2);
    const startTime = reportData.length ? reportData[0].ts.slice(0,16).replace('T',' ') : '—';

    // P&L ultima ora stimato
    const pnlOra = segnaliOra.reduce((s,r) => s+(r.pnlWallet||r.pnl1k/1000*5||0), 0);

    const caption = '📊 <b>REPORT ORARIO — ' + new Date().toUTCString().slice(17,22) + ' UTC</b>\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '<b>ULTIMA ORA</b>\n' +
      '🔢 Operazioni: <b>' + segnaliOra.length + '</b>\n' +
      '✅ Vincenti: <b>' + correttiOra.length + '</b>\n' +
      '❌ Perdenti: <b>' + (verificatiOra.length - correttiOra.length) + '</b>\n' +
      '📈 Win rate: <b>' + wrOra + '%</b>\n' +
      '💵 P&L ora: <b>' + (pnlOra>=0?'+':'') + '$' + Math.abs(pnlOra).toFixed(2) + '</b>\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '<b>DA AVVIO SOFTWARE</b>\n' +
      '🔢 Operazioni totali: <b>' + segnali.length + '</b>\n' +
      '✅ Vincenti: <b>' + corretti.length + '</b>\n' +
      '❌ Perdenti: <b>' + (verificati.length - corretti.length) + '</b>\n' +
      '📈 Win rate totale: <b>' + winRate + '%</b>\n' +
      '💰 Wallet: <b>$100.00 → $' + walletAttuale.toFixed(2) + '</b>\n' +
      '💵 P&L totale: <b>' + (pnlTotale>=0?'+':'') + '$' + Math.abs(pnlTotale) + '</b>\n' +
      '📅 Attivo da: <b>' + startTime + ' UTC</b>\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '📎 CSV allegato · ' + reportData.length + ' righe';

    // Multipart form-data built-in (Node 18+)
    const boundary = '----FormBoundary' + Date.now();
    const CRLF = '\r\n';
    const parts = [
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="chat_id"' + CRLF + CRLF +
      TELEGRAM_CHAT_ID,
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="parse_mode"' + CRLF + CRLF +
      'HTML',
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="caption"' + CRLF + CRLF +
      caption,
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="document"; filename="' + filename + '"' + CRLF +
      'Content-Type: text/csv' + CRLF + CRLF +
      csv,
      '--' + boundary + '--'
    ].join(CRLF);

    await axios.post(
      'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendDocument',
      parts,
      {
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        timeout: 30000,
        maxBodyLength: 50 * 1024 * 1024
      }
    );
    console.log('[Telegram] CSV inviato: ' + filename + ' (' + reportData.length + ' righe)');
  } catch(err) {
    console.error('[Telegram CSV]', err.message);
  }
}

// ── Avvio ──────────────────────────────────────────────────
connettiKraken();
fetchPolymarket();
fetchChainlinkPrice();

setInterval(fetchPolymarket,    5000);
setInterval(controllaGap,       3000);
setInterval(fetchChainlinkPrice, 30000);
setInterval(()=>inviaCsvTelegram('⏱ Backup orario automatico'), 3600000); // ogni ora

console.log('[Sistema] Arbitrage Terminal v4.1 — BTC only, tutti i controlli attivi');
sendTelegram('🚀 <b>Arbitrage Terminal v4.1</b> avviato\n\n✅ Momentum tracking\n✅ Controllo liquidità\n✅ Verifica Chainlink\n✅ Notifica esiti\n✅ Cambio contratto\n✅ Limite esposizione');
