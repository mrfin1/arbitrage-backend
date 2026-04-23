/**
 * EXECUTION ENGINE v4 — Arbitrage Terminal
 *
 * STATO: LIVE TRADING quando TRADING_ENABLED=true + WALLET_PRIVATE_KEY configurata
 *
 * VARIABILI D'AMBIENTE:
 *   TRADING_ENABLED=true        — attiva ordini reali
 *   WALLET_PRIVATE_KEY=0x...    — chiave privata Phantom/Polygon
 *   MAX_DAILY_LOSS_PCT=0.15     — stop loss 15% del wallet (giornaliero)
 *   MAX_WALLET_EXPOSURE=0.05    — 5% wallet per operazione (compounding)
 *   TRADE_SIZE_USDC_MIN=5       — minimo $5 per operazione
 *   TRADE_SIZE_USDC_MAX=50      — massimo $50 per operazione
 *
 * COMPOUNDING:
 *   Ogni operazione usa sempre il 5% del wallet attuale.
 *   Il wallet cresce ad ogni win → le operazioni diventano sempre più grandi.
 *
 * FIRMA EIP-712:
 *   Polymarket CLOB API richiede ordini firmati con EIP-712 su Polygon (chain 137).
 *   La firma avviene localmente con ethers.js — la chiave privata non lascia mai il server.
 */

const axios  = require('axios');
const { ethers } = require('ethers'); // v5
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');

const TRADING_ENABLED    = process.env.TRADING_ENABLED === 'true';
const MAX_DAILY_LOSS_PCT = parseFloat(process.env.MAX_DAILY_LOSS_PCT    || '0.15');
const MAX_EXPOSURE_PCT   = parseFloat(process.env.MAX_WALLET_EXPOSURE   || '0.05');
const TRADE_SIZE_MIN     = parseFloat(process.env.TRADE_SIZE_USDC_MIN   || '5');
const TRADE_SIZE_MAX     = parseFloat(process.env.TRADE_SIZE_USDC_MAX   || '50');
const MAX_DAILY_TRADES   = Infinity;
const CLOB_HOST          = 'https://clob.polymarket.com';
const CHAIN_ID           = 137; // Polygon

// ── Stato giornaliero ─────────────────────────────────────
let dailyStats = { date: new Date().toDateString(), trades: 0, pnl: 0, wins: 0, losses: 0 };
let walletBase = 1000; // aggiornato dal saldo reale

// ── Posizioni aperte + storici ────────────────────────────
let posizioniAperte  = [];
let pnlHistory       = [];
let walletHistory    = [];

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats = { date: today, trades: 0, pnl: 0, wins: 0, losses: 0 };
    console.log('[Execution] Reset stats giornaliere');
  }
}

// Leggi saldo subito all'avvio e ogni 5 minuti
async function avviaLetturaSaldo() {
  const saldo = await getSaldoWallet();
  if (saldo !== null) {
    console.log(`[Execution] Saldo iniziale: $${saldo.toFixed(2)} USDC`);
  } else {
    console.log('[Execution] Saldo non disponibile — uso default $' + walletBase);
  }
}
setTimeout(avviaLetturaSaldo, 3000); // dopo 3 secondi dall'avvio
setInterval(avviaLetturaSaldo, 5 * 60 * 1000); // ogni 5 minuti

// ── Wallet ethers v5 ─────────────────────────────────────
function getWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  try {
    return new ethers.Wallet(process.env.WALLET_PRIVATE_KEY);
  } catch(e) {
    console.error('[Execution] Chiave privata non valida:', e.message);
    return null;
  }
}

// ── ClobClient ufficiale Polymarket ──────────────────────
let _clobClient = null;
let _clobCreds  = null;

async function getClobClient() {
  const wallet = getWallet();
  if (!wallet) return null;
  if (_clobClient && _clobCreds) return _clobClient;
  try {
    // Inizializza client L1
    const l1Client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
    // Deriva o crea API credentials (L2)
    _clobCreds = await l1Client.createOrDeriveApiKey();
    console.log('[Execution] CLOB API credentials:', _clobCreds.apiKey?.slice(0,8)+'...');
    // Inizializza client L2 con funder = proxy address Polymarket
    const funder = process.env.POLYMARKET_PROXY_ADDRESS || wallet.address;
    _clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, _clobCreds, 0, funder);
    console.log('[Execution] ClobClient pronto | funder:', funder.slice(0,10)+'...');
    return _clobClient;
  } catch(e) {
    console.error('[Execution] ClobClient init errore:', e.message);
    _clobClient = null;
    _clobCreds  = null;
    return null;
  }
}



// ── Saldo USDC reale da Polygon RPC (no auth richiesta) ──
// Saldo USDC reale — legge direttamente dal proxy wallet Polymarket su Polygon
// POLYMARKET_PROXY_ADDRESS = indirizzo da Settings > Wallet Address su polymarket.com
async function getSaldoWallet() {
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
  if (!proxyAddress) {
    console.log('[Execution] POLYMARKET_PROXY_ADDRESS non configurata');
    return null;
  }
  try {
    const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const rpc          = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
    // Costruisci data field: selector(4 bytes) + 12 bytes zeri + indirizzo(20 bytes)
    const addrClean    = proxyAddress.toLowerCase().replace(/^0x/i, '').slice(-40).padStart(40,'0');
    const data         = '0x70a08231' + '000000000000000000000000' + addrClean;

    console.log('[Execution] Chiamo RPC:', rpc.slice(0,50));
    console.log('[Execution] Proxy addr:', proxyAddress);
    console.log('[Execution] Data:', data);
    const r = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: USDC_POLYGON, data }, 'latest']
    }, { timeout: 8000 });

    const hex = r.data?.result;
    console.log('[Execution] RPC result:', hex);

    if (!hex || hex === '0x') { console.log('[Execution] Hex vuoto'); return 0; }

    const saldo = parseInt(hex, 16) / 1e6;
    console.log(`[Execution] Saldo USDC proxy: $${saldo.toFixed(6)}`);

    if (saldo > 0) {
      walletBase = saldo;
      walletHistory.push({ ts: new Date().toISOString(), valore: parseFloat(saldo.toFixed(2)) });
      if (walletHistory.length > 1000) walletHistory.shift();
    }
    return saldo;
  } catch(e) {
    console.log('[Execution] getSaldoWallet errore:', e.message);
    return null;
  }
}

// ── Calcolo trade size compounding ───────────────────────
async function calcolaTradeSize() {
  const saldo   = await getSaldoWallet();
  const base    = saldo || (walletBase + dailyStats.pnl);
  const size    = base * MAX_EXPOSURE_PCT;
  const final   = Math.min(Math.max(size, TRADE_SIZE_MIN), TRADE_SIZE_MAX);
  console.log(`[Execution] Trade size: $${final.toFixed(2)} (5% di $${base.toFixed(2)})`);
  return parseFloat(final.toFixed(2));
}

// ── Aggiorna saldo post-operazione ────────────────────────
async function aggiornaSaldoDopoOperazione(pnlRealizzato) {
  const saldo     = await getSaldoWallet();
  const nuovoVal  = saldo || (walletBase + dailyStats.pnl);
  walletHistory.push({ ts: new Date().toISOString(), valore: parseFloat(nuovoVal.toFixed(2)) });
  if (walletHistory.length > 1000) walletHistory.shift();
  console.log(`[Execution] Saldo aggiornato: $${nuovoVal.toFixed(2)} (P&L: ${pnlRealizzato >= 0 ? '+' : ''}$${pnlRealizzato.toFixed(2)})`);
  return nuovoVal;
}

// ── Controlli sicurezza ───────────────────────────────────
async function verificaSicurezza(segnale) {
  resetIfNewDay();

  if (!TRADING_ENABLED)
    return { ok: false, motivo: 'TRADING_ENABLED=false — paper trading attivo' };
  if (!process.env.WALLET_PRIVATE_KEY)
    return { ok: false, motivo: 'WALLET_PRIVATE_KEY non configurata' };
  if (!getWallet())
    return { ok: false, motivo: 'Chiave privata non valida' };

  const errori = [];
  const saldo  = await getSaldoWallet();
  const base   = saldo || (walletBase + dailyStats.pnl);

  // Stop loss 15% del wallet
  const maxLoss = base * MAX_DAILY_LOSS_PCT;
  if (dailyStats.pnl <= -maxLoss)
    errori.push(`Stop loss 15% raggiunto: -$${Math.abs(dailyStats.pnl).toFixed(2)} su $${base.toFixed(2)}`);

  if (!segnale.profittevole)
    errori.push('Segnale non profittevole');
  if (!segnale.prezzoContratto || segnale.prezzoContratto > 75)
    errori.push(`Contratto troppo caro: ${segnale.prezzoContratto}¢`);
  if (!segnale.pnlNetto || segnale.pnlNetto < 5)
    errori.push(`P&L netto insufficiente: ${segnale.pnlNetto}¢`);
  if (segnale.volume && segnale.volume < 500)
    errori.push(`Volume insufficiente: $${segnale.volume}`);
  if (base < TRADE_SIZE_MIN * 2)
    errori.push(`Wallet insufficiente: $${base.toFixed(2)}`);

  return errori.length ? { ok: false, motivo: errori.join(' | ') } : { ok: true };
}

// ── Token IDs dal mercato ─────────────────────────────────
async function getTokenIds(slug, direzione) {
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { slug }, timeout: 5000
    });
    if (!r.data?.length) return null;
    const ids = typeof r.data[0].clobTokenIds === 'string'
      ? JSON.parse(r.data[0].clobTokenIds)
      : r.data[0].clobTokenIds;
    if (!ids || ids.length < 2) return null;
    return direzione === 'UP' ? ids[0] : ids[1];
  } catch(e) {
    console.error('[Execution] Token IDs:', e.message);
    return null;
  }
}


// ── Retry con backoff ─────────────────────────────────────
async function chiamataConRetry(fn, maxTentativi, ordineId) {
  const attese = [1000, 3000, 5000];
  let ultimoErrore = null;
  for (let i = 0; i < maxTentativi; i++) {
    try {
      if (i > 0 && ordineId) {
        const esistente = await verificaOrdineEsistente(ordineId);
        if (esistente) return { giàEsiste: true, dati: esistente };
      }
      if (i > 0) {
        const attesa = attese[i-1] || 5000;
        console.log(`[Execution] Retry ${i}/${maxTentativi-1} tra ${attesa/1000}s...`);
        await new Promise(r => setTimeout(r, attesa));
      }
      return { giàEsiste: false, dati: await fn() };
    } catch(e) {
      ultimoErrore = e;
      if (e.response?.status === 429) {
        console.log('[Execution] Rate limit — attendo 10s');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      if (e.response?.status >= 500) { console.log('[Execution] Server error — riprovo'); continue; }
      if (e.response?.status < 500 && e.response?.status !== 429) throw e;
      console.log(`[Execution] Errore tentativo ${i+1}: ${e.message}`);
    }
  }
  throw ultimoErrore || new Error('Tutti i tentativi falliti');
}

async function verificaOrdineEsistente(ordineId) {
  try {
    const r = await axios.get(`${CLOB_HOST}/order/${ordineId}`, { timeout: 5000 });
    return r.data || null;
  } catch(e) { return null; }
}

// ── Conferma esecuzione ordine (ogni 5s per max 60s) ─────
async function confermaEsecuzione(ordineId) {
  console.log(`[Execution] Attendo conferma ordine ${ordineId}...`);
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const r     = await axios.get(`${CLOB_HOST}/order/${ordineId}`, { timeout: 5000 });
      const stato = r.data?.status;
      console.log(`[Execution] Ordine ${ordineId}: ${stato} (${(i+1)*5}s)`);
      if (stato === 'MATCHED' || stato === 'FILLED')
        return { confermato: true, stato, dati: r.data };
      if (stato === 'CANCELLED' || stato === 'REJECTED')
        return { confermato: false, stato, motivo: `Ordine ${stato}` };
    } catch(e) { console.log('[Execution] Errore check:', e.message); }
  }
  console.log('[Execution] Timeout 60s — abbandono ordine');
  return { confermato: false, stato: 'TIMEOUT', motivo: 'Nessuna conferma in 60s' };
}

// ── Piazza ordine ─────────────────────────────────────────
async function piazzaOrdine(segnale) {
  const check = await verificaSicurezza(segnale);
  if (!check.ok) {
    console.log('[Execution] Bloccato:', check.motivo);
    return { successo: false, motivo: check.motivo, paperTrade: !TRADING_ENABLED };
  }

  try {
    const wallet    = getWallet();
    const tradeSize = await calcolaTradeSize();
    const tokenId   = await getTokenIds(segnale.slug, segnale.direzione);
    if (!tokenId) return { successo: false, motivo: 'Token ID non trovato per ' + segnale.slug };

    const price    = segnale.prezzoContratto / 100;
    const size     = parseFloat((tradeSize / price).toFixed(2));
    const pnlStim  = parseFloat((segnale.pnlNetto / 100 * tradeSize).toFixed(2));
    const ordineId = 'ord-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    const risultato = {
      successo: true, paperTrade: !TRADING_ENABLED, ordineId,
      asset: segnale.asset, finestra: segnale.finestra,
      direzione: segnale.direzione, score: segnale.score,
      prezzoEntrata: segnale.prezzoContratto, sizeShares: size,
      usdcSpesi: tradeSize, pnlStimato: pnlStim,
      distanza: segnale.distanzaDollar || 0,
      slug: segnale.slug, timestamp: new Date().toISOString(),
      stato: 'APERTA', closeAt: segnale.closeAt || null
    };

    if (TRADING_ENABLED && wallet) {
      console.log(`[Execution] 🔴 LIVE ORDER — ${segnale.finestra} ${segnale.direzione} @${segnale.prezzoContratto}¢ size:$${tradeSize}`);

      // Usa ClobClient ufficiale Polymarket
      const client = await getClobClient();
      if (!client) return { successo: false, motivo: 'ClobClient non inizializzato' };

      const lato = segnale.direzione === 'UP' ? Side.BUY : Side.BUY; // compra sempre il lato corretto
      const prezzoDecimale = parseFloat((segnale.prezzoContratto / 100).toFixed(4));

      // Crea e invia ordine GTC tramite SDK ufficiale
      const resp = await chiamataConRetry(
        () => client.createAndPostOrder(
          {
            tokenID: tokenId,
            price:   prezzoDecimale,
            size:    size,
            side:    lato,
          },
          { tickSize: '0.01', negRisk: false },
          OrderType.GTC
        ),
        3, ordineId
      );

      risultato.ordineIdClob = resp.dati?.orderID || resp.dati?.id || resp.dati?.orderId;
      console.log('[Execution] ✅ Ordine inviato via SDK:', JSON.stringify(resp.dati).slice(0,100));

      // Conferma esecuzione
      if (risultato.ordineIdClob) {
        const conferma = await confermaEsecuzione(risultato.ordineIdClob);
        risultato.stato = conferma.stato;
        if (!conferma.confermato) {
          console.log('[Execution] Ordine non confermato:', conferma.motivo);
        } else {
          console.log('[Execution] ✅ Ordine CONFERMATO:', conferma.stato);
        }
      }
    } else {
      console.log(`[Execution] 📋 Paper trade: ${segnale.asset}/${segnale.finestra} ${segnale.direzione} @${segnale.prezzoContratto}¢ size:$${tradeSize}`);
    }

    dailyStats.trades++;
    posizioniAperte.push(risultato);
    pnlHistory.push({ ts: risultato.timestamp, pnl: parseFloat(dailyStats.pnl.toFixed(2)) });
    if (pnlHistory.length > 500) pnlHistory.shift();

    return risultato;

  } catch(err) {
    console.error('[Execution] Errore ordine:', err.message);
    return { successo: false, motivo: err.message };
  }
}

// ── Registra esito e chiudi posizione ─────────────────────
async function registraEsito(ordine, esito) {
  if (!ordine || !esito) return;
  resetIfNewDay();

  const vinta    = (ordine.direzione === 'UP'   && esito === 'UP_WINS') ||
                   (ordine.direzione === 'DOWN'  && esito === 'DOWN_WINS');
  const pnlReale = vinta ? ordine.pnlStimato : -ordine.usdcSpesi;

  dailyStats.pnl += pnlReale;
  if (vinta) dailyStats.wins++; else dailyStats.losses++;

  // Chiudi posizione
  posizioniAperte = posizioniAperte.filter(p => p.ordineId !== ordine.ordineId);

  pnlHistory.push({ ts: new Date().toISOString(), pnl: parseFloat(dailyStats.pnl.toFixed(2)) });
  if (pnlHistory.length > 500) pnlHistory.shift();

  const nuovoSaldo = await aggiornaSaldoDopoOperazione(pnlReale);
  console.log(`[Execution] Esito: ${esito} | P&L: ${pnlReale >= 0 ? '+' : ''}$${pnlReale.toFixed(2)} | Wallet: $${nuovoSaldo.toFixed(2)}`);
  return { vinta, pnlReale, nuovoSaldo, dailyStats };
}

// ── Stato sistema ─────────────────────────────────────────
function getStato() {
  resetIfNewDay();
  const wallet = getWallet();
  return {
    attivo:            TRADING_ENABLED,
    walletAddress:     wallet ? wallet.address : null,
    walletConfigurato: !!process.env.WALLET_PRIVATE_KEY,
    tradeSizeMode:     'compounding 5% wallet',
    tradeSizeMin:      TRADE_SIZE_MIN,
    tradeSizeMax:      TRADE_SIZE_MAX,
    stopLossPct:       MAX_DAILY_LOSS_PCT * 100 + '%',
    maxEsposizionePct: MAX_EXPOSURE_PCT * 100 + '%',
    walletStimato:     parseFloat((walletBase > 0 ? walletBase : 1000).toFixed(2)),
    prossimaTrade:     parseFloat(((walletBase > 0 ? walletBase : 1000) * MAX_EXPOSURE_PCT).toFixed(2)),
    oggi:              dailyStats,
    posizioniAperte:   posizioniAperte.length,
    pnlHistory:        pnlHistory.slice(-100),
    walletHistory:     walletHistory.slice(-100),
    avvertenze: [
      !TRADING_ENABLED          ? '⚠ Paper trading attivo'          : null,
      !process.env.WALLET_PRIVATE_KEY ? '⚠ WALLET_PRIVATE_KEY mancante' : null,
      wallet && TRADING_ENABLED ? '🔴 LIVE TRADING ATTIVO'           : null,
    ].filter(Boolean)
  };
}

function getDashboardData() {
  return { posizioniAperte, pnlHistory: pnlHistory.slice(-200), walletHistory: walletHistory.slice(-200), dailyStats };
}

async function forzaLetturaSaldo() {
  const saldo = await getSaldoWallet();
  console.log('[Execution] Lettura forzata saldo:', saldo);
  return saldo;
}

function getWalletBase() { return walletBase; }

module.exports = { piazzaOrdine, registraEsito, getStato, getDashboardData, verificaSicurezza, forzaLetturaSaldo, getWalletBase };
