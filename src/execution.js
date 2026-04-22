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
const { ethers } = require('ethers');

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

// ── Wallet ethers ─────────────────────────────────────────
function getWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  try {
    return new ethers.Wallet(process.env.WALLET_PRIVATE_KEY);
  } catch(e) {
    console.error('[Execution] Chiave privata non valida:', e.message);
    return null;
  }
}

// ── L1 Headers per CLOB API ──────────────────────────────
// Polymarket usa EIP-712 per L1 auth, poi HMAC per L2
async function getL1Headers(wallet, method, path, body) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = '0';
  // L1: firma EIP-712 del messaggio di autenticazione
  const domain = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
  const types  = { ClobAuth: [
    { name: 'address',   type: 'address' },
    { name: 'timestamp', type: 'string'  },
    { name: 'nonce',     type: 'uint256' },
    { name: 'message',   type: 'string'  }
  ]};
  const value  = {
    address:   wallet.address,
    timestamp: ts,
    nonce:     0,
    message:   'This message attests that I am the owner/operator of this wallet'
  };
  const sig = await wallet.signTypedData(domain, types, value);
  return {
    'POLY_ADDRESS':   wallet.address,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': ts,
    'POLY_NONCE':     nonce,
    'Content-Type':   'application/json'
  };
}

// ── Crea o ottieni API credentials (L2) ──────────────────
let apiCreds = null; // { apiKey, secret, passphrase }

async function getApiCreds(wallet) {
  if (apiCreds) return apiCreds;
  try {
    const headers = await getL1Headers(wallet, 'GET', '/auth/api-key');
    const r = await axios.get(CLOB_HOST + '/auth/api-key', { headers, timeout: 8000 });
    apiCreds = r.data;
    console.log('[Execution] API credentials ottenute:', apiCreds?.apiKey?.slice(0,8)+'...');
    return apiCreds;
  } catch(e) {
    // Se non esistono, creale
    try {
      const headers = await getL1Headers(wallet, 'POST', '/auth/api-key');
      const r = await axios.post(CLOB_HOST + '/auth/api-key', {}, { headers, timeout: 8000 });
      apiCreds = r.data;
      console.log('[Execution] API credentials create:', apiCreds?.apiKey?.slice(0,8)+'...');
      return apiCreds;
    } catch(e2) {
      console.log('[Execution] API credentials non disponibili:', e2.message);
      return null;
    }
  }
}

// ── Saldo USDC reale da Polygon RPC (no auth richiesta) ──
// Saldo wallet — usa CLOB API Polymarket o variabile d'ambiente come fallback
async function getSaldoWallet() {
  // 1. Prova a leggere dalla CLOB API di Polymarket (richiede auth)
  const wallet = getWallet();
  if (wallet && TRADING_ENABLED) {
    try {
      const creds = await getApiCreds(wallet);
      if (creds?.apiKey) {
        const ts      = Math.floor(Date.now() / 1000).toString();
        const method  = 'GET';
        const path    = '/balance';
        const crypto  = require('crypto');
        const sig     = crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64'))
                              .update(ts + method + path).digest('base64');
        const r = await axios.get(CLOB_HOST + path, {
          headers: {
            'POLY_ADDRESS':    wallet.address,
            'POLY_API_KEY':    creds.apiKey,
            'POLY_SIGNATURE':  sig,
            'POLY_TIMESTAMP':  ts,
            'POLY_PASSPHRASE': creds.passphrase
          },
          timeout: 8000
        });
        const saldo = parseFloat(r.data?.balance || r.data?.USDC || r.data?.collateral || 0);
        if (saldo > 0) {
          walletBase = saldo;
          walletHistory.push({ ts: new Date().toISOString(), valore: parseFloat(saldo.toFixed(2)) });
          if (walletHistory.length > 1000) walletHistory.shift();
          console.log(`[Execution] Saldo CLOB API: $${saldo.toFixed(2)} USDC`);
          return saldo;
        }
      }
    } catch(e) {
      console.log('[Execution] CLOB balance non disponibile:', e.message);
    }
  }

  // 2. Fallback — usa variabile d'ambiente WALLET_BALANCE_USDC
  const envBalance = parseFloat(process.env.WALLET_BALANCE_USDC || '0');
  if (envBalance > 0) {
    if (walletBase !== envBalance) {
      walletBase = envBalance;
      walletHistory.push({ ts: new Date().toISOString(), valore: envBalance });
      console.log(`[Execution] Saldo da variabile d'ambiente: $${envBalance.toFixed(2)} USDC`);
    }
    return envBalance;
  }

  return null;
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

// ── EIP-712 — firma ordine Polymarket ────────────────────
async function firmaOrdineEIP712(wallet, ordine) {
  // Domain Polymarket su Polygon
  const domain = {
    name:              'ClobAuthDomain',
    version:           '1',
    chainId:           CHAIN_ID,
    verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' // CTF Exchange Polygon
  };

  // Tipi EIP-712 per ordine Polymarket
  const types = {
    Order: [
      { name: 'salt',         type: 'uint256' },
      { name: 'maker',        type: 'address' },
      { name: 'signer',       type: 'address' },
      { name: 'taker',        type: 'address' },
      { name: 'tokenId',      type: 'uint256' },
      { name: 'makerAmount',  type: 'uint256' },
      { name: 'takerAmount',  type: 'uint256' },
      { name: 'expiration',   type: 'uint256' },
      { name: 'nonce',        type: 'uint256' },
      { name: 'feeRateBps',   type: 'uint256' },
      { name: 'side',         type: 'uint8'   },
      { name: 'signatureType',type: 'uint8'   },
    ]
  };

  const firma = await wallet.signTypedData(domain, types, ordine);
  return firma;
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

      // Costruisci ordine EIP-712
      const salt      = BigInt(Math.floor(Math.random() * 1e15));
      const makerAmt  = BigInt(Math.round(tradeSize * 1e6));   // USDC 6 decimali
      const takerAmt  = BigInt(Math.round(size * 1e6));        // shares 6 decimali
      const expiration= BigInt(Math.floor(Date.now()/1000) + 3600); // 1h
      const sideNum   = segnale.direzione === 'UP' ? 0 : 1;

      const ordineEIP = {
        salt:          salt,
        maker:         wallet.address,
        signer:        wallet.address,
        taker:         '0x0000000000000000000000000000000000000000',
        tokenId:       BigInt(tokenId),
        makerAmount:   makerAmt,
        takerAmount:   takerAmt,
        expiration:    expiration,
        nonce:         BigInt(0),
        feeRateBps:    BigInt(0),
        side:          sideNum,
        signatureType: 0
      };

      // Firma EIP-712
      const firma = await firmaOrdineEIP712(wallet, ordineEIP);
      console.log('[Execution] Firma EIP-712 generata:', firma.slice(0, 20) + '...');

      // Payload per CLOB API
      const payload = {
        order: {
          salt:          salt.toString(),
          maker:         wallet.address,
          signer:        wallet.address,
          taker:         '0x0000000000000000000000000000000000000000',
          tokenId:       tokenId,
          makerAmount:   makerAmt.toString(),
          takerAmount:   takerAmt.toString(),
          expiration:    expiration.toString(),
          nonce:         '0',
          feeRateBps:    '0',
          side:          sideNum === 0 ? 'BUY' : 'SELL',
          signatureType: 0,
          signature:     firma
        },
        owner:   wallet.address,
        orderType: 'GTC'
      };

      // Header autenticazione CLOB
      const ts    = Math.floor(Date.now() / 1000).toString();
      const nonce = '0';
      const msg   = `${ts}POST/order`;
      const authSig = await wallet.signMessage(msg);

      const risposta = await chiamataConRetry(
        () => axios.post(CLOB_HOST + '/order', payload, {
          headers: {
            'Content-Type':   'application/json',
            'POLY_ADDRESS':   wallet.address,
            'POLY_SIGNATURE': authSig,
            'POLY_TIMESTAMP': ts,
            'POLY_NONCE':     nonce
          },
          timeout: 10000
        }),
        3, ordineId
      );

      risultato.ordineIdClob = risposta.dati?.orderID || risposta.dati?.id;
      console.log('[Execution] Ordine inviato:', risultato.ordineIdClob);

      // Conferma esecuzione
      if (risultato.ordineIdClob) {
        const conferma = await confermaEsecuzione(risultato.ordineIdClob);
        if (!conferma.confermato) {
          console.log('[Execution] Ordine non confermato:', conferma.motivo);
          return { successo: false, motivo: conferma.motivo, risultato };
        }
        risultato.stato = conferma.stato;
        console.log('[Execution] ✅ Ordine CONFERMATO:', conferma.stato);
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
