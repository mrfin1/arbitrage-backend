/**
 * EXECUTION ENGINE v3 — Arbitrage Terminal
 *
 * STATO: PAPER TRADING — non esegue ordini reali finché TRADING_ENABLED=true
 *
 * VARIABILI D'AMBIENTE:
 *   TRADING_ENABLED=false       — 'true' per live trading
 *
 * COMPOUNDING:
 *   Ogni operazione usa sempre il 5% del wallet attuale.
 *   Il wallet cresce ad ogni win → le operazioni diventano sempre più grandi.
 *   WALLET_PRIVATE_KEY=0x...    — chiave privata Phantom/Polygon
 *   TRADE_SIZE_USDC=10          — USDC per operazione
 *   MAX_DAILY_LOSS_PCT=0.15     — stop loss 15% del wallet (giornaliero)
 *   MAX_WALLET_EXPOSURE=0.05    — max 5% wallet per singola operazione
 */

const axios = require('axios');

const TRADING_ENABLED    = process.env.TRADING_ENABLED === 'true';
const TRADE_SIZE_USDC_MIN = parseFloat(process.env.TRADE_SIZE_USDC_MIN  || '5');   // minimo $5 per operazione
const TRADE_SIZE_USDC_MAX = parseFloat(process.env.TRADE_SIZE_USDC_MAX  || '500'); // massimo $500 per operazione
const MAX_DAILY_LOSS_PCT = parseFloat(process.env.MAX_DAILY_LOSS_PCT    || '0.15');
const MAX_EXPOSURE_PCT   = parseFloat(process.env.MAX_WALLET_EXPOSURE   || '0.05');
const MAX_DAILY_TRADES   = Infinity; // nessun limite operazioni giornaliere
const CLOB_HOST          = 'https://clob.polymarket.com';
const CHAIN_ID           = 137;

// ── Stato giornaliero ─────────────────────────────────────
let dailyStats = {
  date: new Date().toDateString(),
  trades: 0, pnl: 0, wins: 0, losses: 0
};

// ── Posizioni aperte (tracking real-time) ─────────────────
let posizioniAperte = [];
let pnlHistory      = [];   // { ts, pnl } per grafico P&L
let walletHistory   = [];   // { ts, valore } per grafico wallet
let walletBase      = 1000; // aggiornato dal saldo reale

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats = { date: today, trades: 0, pnl: 0, wins: 0, losses: 0 };
    console.log('[Execution] Reset stats giornaliere');
  }
}

// ── Saldo wallet ──────────────────────────────────────────
async function getSaldoWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  try {
    // TODO: implementare con chiave reale
    // const r = await axios.get(CLOB_HOST + '/balance', { headers: authHeaders });
    // walletBase = r.data.balance;
    // return walletBase;
    return null;
  } catch(e) { return null; }
}

// Aggiorna saldo dopo ogni operazione conclusa
async function aggiornaSaldoDopoOperazione(pnlRealizzato) {
  const saldo = await getSaldoWallet();
  const nuovoValore = saldo || (walletBase + dailyStats.pnl);
  walletHistory.push({ ts: new Date().toISOString(), valore: parseFloat(nuovoValore.toFixed(2)) });
  if (walletHistory.length > 1000) walletHistory.shift();
  console.log('[Execution] Saldo aggiornato: $' + nuovoValore.toFixed(2) + ' (P&L realizzato: ' + (pnlRealizzato >= 0 ? '+' : '') + '$' + pnlRealizzato.toFixed(2) + ')');
  return nuovoValore;
}

// ── Controlli sicurezza ───────────────────────────────────
async function verificaSicurezza(segnale) {
  resetIfNewDay();
  const errori = [];

  if (!TRADING_ENABLED)
    return { ok: false, motivo: 'TRADING_ENABLED=false — paper trading attivo' };
  if (!process.env.WALLET_PRIVATE_KEY)
    return { ok: false, motivo: 'WALLET_PRIVATE_KEY non configurata' };

  // Stop loss 15% del wallet
  const saldoAttuale = await getSaldoWallet();
  const walletStimato = saldoAttuale || walletBase;
  const maxLossAbs = walletStimato * MAX_DAILY_LOSS_PCT;
  if (dailyStats.pnl <= -maxLossAbs)
    errori.push('Stop loss 15% raggiunto: -$' + Math.abs(dailyStats.pnl).toFixed(2) + ' su $' + walletStimato.toFixed(2));

  if (!segnale.profittevole)
    errori.push('Segnale non profittevole');
  if (!segnale.prezzoContratto || segnale.prezzoContratto > 75)
    errori.push('Contratto troppo caro: ' + segnale.prezzoContratto + '¢');
  if (!segnale.pnlNetto || segnale.pnlNetto < 5)
    errori.push('P&L netto insufficiente: ' + segnale.pnlNetto + '¢');
  if (segnale.volume && segnale.volume < 500)
    errori.push('Volume insufficiente: $' + segnale.volume);

  // Con compounding la size è sempre 5% — controllo solo che il wallet sia sufficiente
  if (walletStimato < TRADE_SIZE_USDC_MIN * 2)
    errori.push('Wallet insufficiente: $' + walletStimato.toFixed(2) + ' < $' + (TRADE_SIZE_USDC_MIN*2).toFixed(2));

  if (errori.length > 0) return { ok: false, motivo: errori.join(' | ') };
  return { ok: true };
}

// ── Token IDs ─────────────────────────────────────────────
async function getTokenIds(slug, direzione) {
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { slug }, timeout: 5000
    });
    if (!r.data || !r.data.length) return null;
    const m = r.data[0];
    const tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (!tokenIds || tokenIds.length < 2) return null;
    return direzione === 'UP' ? tokenIds[0] : tokenIds[1];
  } catch(e) {
    console.error('[Execution] Token IDs:', e.message);
    return null;
  }
}

// ── Retry con backoff ─────────────────────────────────────
// Riprova la chiamata HTTP fino a maxTentativi con attesa crescente
// Prima verifica se l'ordine esiste già (evita duplicati su timeout)
async function chiamataConRetry(fn, maxTentativi, ordineId) {
  const attese = [1000, 3000, 5000];
  let ultimoErrore = null;

  for (let i = 0; i < maxTentativi; i++) {
    try {
      // Se è un retry (non il primo tentativo) e abbiamo un ordineId,
      // controlla se l'ordine è già stato piazzato prima di riprovare
      if (i > 0 && ordineId) {
        const esistente = await verificaOrdineEsistente(ordineId);
        if (esistente) {
          console.log('[Execution] Ordine già esiste su CLOB — skip retry');
          return { giàEsiste: true, dati: esistente };
        }
      }

      if (i > 0) {
        const attesa = attese[i-1] || 5000;
        console.log('[Execution] Retry ' + i + '/' + (maxTentativi-1) + ' tra ' + attesa/1000 + 's...');
        await new Promise(r => setTimeout(r, attesa));
      }

      return { giàEsiste: false, dati: await fn() };

    } catch(e) {
      ultimoErrore = e;
      // Rate limit — attesa più lunga
      if (e.response && e.response.status === 429) {
        console.log('[Execution] Rate limit — attendo 10s');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      // Errore 5xx — server giù, riprova
      if (e.response && e.response.status >= 500) {
        console.log('[Execution] Server error ' + e.response.status + ' — riprovo');
        continue;
      }
      // Errore fatale (4xx escluso 429) — non riprovare
      if (e.response && e.response.status < 500 && e.response.status !== 429) {
        throw e;
      }
      console.log('[Execution] Errore tentativo ' + (i+1) + ': ' + e.message);
    }
  }
  throw ultimoErrore || new Error('Tutti i tentativi falliti');
}

// ── Verifica ordine esistente su CLOB ─────────────────────
async function verificaOrdineEsistente(ordineId) {
  try {
    const r = await axios.get(CLOB_HOST + '/order/' + ordineId, { timeout: 5000 });
    return r.data || null;
  } catch(e) { return null; }
}

// ── Conferma esecuzione ordine ────────────────────────────
// Interroga CLOB ogni 5 secondi per max 60 secondi
// Se l'ordine rimane OPEN dopo 60s → abbandona e passa al prossimo
async function confermaEsecuzione(ordineId, segnale) {
  const maxTentativi = 12; // 12 × 5s = 60s
  const intervallo   = 5000;

  console.log('[Execution] Attendo conferma ordine ' + ordineId + '...');

  for (let i = 0; i < maxTentativi; i++) {
    await new Promise(r => setTimeout(r, intervallo));
    try {
      const r = await axios.get(CLOB_HOST + '/order/' + ordineId, { timeout: 5000 });
      const stato = r.data?.status;
      console.log('[Execution] Ordine ' + ordineId + ' stato: ' + stato + ' (' + (i+1)*5 + 's)');

      if (stato === 'MATCHED' || stato === 'FILLED') {
        console.log('[Execution] Ordine CONFERMATO: ' + stato);
        return { confermato: true, stato, dati: r.data };
      }
      if (stato === 'CANCELLED' || stato === 'REJECTED') {
        console.log('[Execution] Ordine ' + stato + ' — abbandono');
        return { confermato: false, stato, motivo: 'Ordine ' + stato };
      }
      // OPEN → continua ad aspettare
    } catch(e) {
      console.log('[Execution] Errore check ordine: ' + e.message);
    }
  }

  // 60 secondi passati — abbandona
  console.log('[Execution] Timeout 60s — ordine non confermato, abbandono');
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
    const tokenId = await getTokenIds(segnale.slug, segnale.direzione);
    if (!tokenId && TRADING_ENABLED)
      return { successo: false, motivo: 'Token ID non trovato per ' + segnale.slug };

    const tradeSize    = await calcolaTradeSize(); // 5% wallet — compounding
    const price        = segnale.prezzoContratto / 100;
    const size         = parseFloat((tradeSize / price).toFixed(2));
    const pnlStimato   = parseFloat((segnale.pnlNetto / 100 * tradeSize).toFixed(2));
    const ordineId     = 'ord-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    const risultato = {
      successo:      true,
      paperTrade:    !TRADING_ENABLED,
      ordineId,
      asset:         segnale.asset,
      finestra:      segnale.finestra,
      direzione:     segnale.direzione,
      score:         segnale.score,
      momentum:      segnale.momentum || null,
      prezzoEntrata: segnale.prezzoContratto,
      sizeShares:    size,
      usdcSpesi:     tradeSize,
      pnlStimato,
      tokenId:       tokenId ? tokenId.slice(0, 20) + '...' : 'N/A (paper)',
      slug:          segnale.slug,
      timestamp:     new Date().toISOString(),
      stato:         'APERTA',
      closeAt:       segnale.closeAt || null
    };

    if (TRADING_ENABLED) {
      // Firma EIP-712 e chiamata CLOB API (da implementare con wallet configurato)
      // const { ethers } = require('ethers');
      // const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY);
      // const ordine = { tokenID: tokenId, price, size, side: 'BUY', nonce: Date.now() };
      // const firma = await wallet.signTypedData(domain, types, ordine);
      // const risposta = await chiamataConRetry(
      //   () => axios.post(CLOB_HOST + '/order', { ...ordine, signature: firma }),
      //   3, ordineId
      // );
      // risultato.txHash = risposta.dati?.transactionHash;
      // risultato.ordineIdClob = risposta.dati?.orderID;
      //
      // // Conferma esecuzione
      // const conferma = await confermaEsecuzione(risposta.dati?.orderID, segnale);
      // if (!conferma.confermato) {
      //   return { successo: false, motivo: conferma.motivo, risultato };
      // }
      console.log('[Execution] LIVE TRADING — implementare firma EIP-712');
    } else {
      console.log('[Execution] Paper trade: ' + segnale.asset + '/' + segnale.finestra + ' ' + segnale.direzione + ' @' + segnale.prezzoContratto + '¢');
    }

    dailyStats.trades++;

    // Aggiungi a posizioni aperte
    posizioniAperte.push(risultato);

    // Aggiorna storico P&L
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

  const vinta    = (ordine.direzione === 'UP' && esito === 'UP_WINS') ||
                   (ordine.direzione === 'DOWN' && esito === 'DOWN_WINS');
  const pnlReale = vinta ? ordine.pnlStimato : -ordine.usdcSpesi;

  dailyStats.pnl += pnlReale;
  if (vinta) dailyStats.wins++; else dailyStats.losses++;

  // Chiudi posizione aperta
  posizioniAperte = posizioniAperte.filter(p => p.ordineId !== ordine.ordineId);

  // Aggiorna storico P&L
  pnlHistory.push({ ts: new Date().toISOString(), pnl: parseFloat(dailyStats.pnl.toFixed(2)) });
  if (pnlHistory.length > 500) pnlHistory.shift();

  // Aggiorna saldo wallet
  const nuovoSaldo = await aggiornaSaldoDopoOperazione(pnlReale);

  console.log('[Execution] Esito:', esito, '| P&L reale:', (pnlReale >= 0 ? '+' : '') + '$' + pnlReale.toFixed(2));
  return { vinta, pnlReale, nuovoSaldo, dailyStats };
}

// ── Stato sistema ─────────────────────────────────────────
function getStato() {
  resetIfNewDay();
  return {
    attivo:             TRADING_ENABLED,
    walletConfigurato:  !!process.env.WALLET_PRIVATE_KEY,
    tradeSizeMode:      'compounding 5% wallet',
    tradeSizeMin:       TRADE_SIZE_USDC_MIN,
    tradeSizeMax:       TRADE_SIZE_USDC_MAX,
    walletStimato:      parseFloat((walletBase + dailyStats.pnl).toFixed(2)),
    prossimaTrade:      parseFloat(((walletBase + dailyStats.pnl) * MAX_EXPOSURE_PCT).toFixed(2)),
    maxDailyTrades:     'illimitato',
    stopLossPct:        MAX_DAILY_LOSS_PCT * 100 + '%',
    maxEsposizionePct:  MAX_EXPOSURE_PCT * 100 + '%',
    oggi:               dailyStats,
    posizioniAperte:    posizioniAperte.length,
    pnlHistory:         pnlHistory.slice(-100),
    walletHistory:      walletHistory.slice(-100),
    avvertenze: [
      !TRADING_ENABLED ? 'Paper trading attivo — nessun ordine reale' : null,
      !process.env.WALLET_PRIVATE_KEY ? 'WALLET_PRIVATE_KEY non configurata' : null,
    ].filter(Boolean)
  };
}

// ── Dati per frontend ─────────────────────────────────────
function getDashboardData() {
  return {
    posizioniAperte,
    pnlHistory:    pnlHistory.slice(-200),
    walletHistory: walletHistory.slice(-200),
    dailyStats
  };
}

module.exports = { piazzaOrdine, registraEsito, getStato, getDashboardData, verificaSicurezza };
