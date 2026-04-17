/**
 * EXECUTION ENGINE v2 — Arbitrage Terminal
 *
 * STATO: PAPER TRADING — non esegue ordini reali finché TRADING_ENABLED=true
 *
 * VARIABILI D'AMBIENTE:
 *   TRADING_ENABLED=false       — 'true' per live trading
 *   WALLET_PRIVATE_KEY=0x...    — chiave privata Phantom/Polygon
 *   TRADE_SIZE_USDC=10          — USDC per operazione
 *   MAX_DAILY_TRADES=20         — limite operazioni/giorno
 *   MAX_DAILY_LOSS_USDC=50      — stop loss giornaliero
 *   MAX_WALLET_EXPOSURE=0.10    — max 10% wallet per singola operazione
 */

const axios = require('axios');

const TRADING_ENABLED   = process.env.TRADING_ENABLED === 'true';
const TRADE_SIZE_USDC   = parseFloat(process.env.TRADE_SIZE_USDC  || '10');
const MAX_DAILY_TRADES  = parseInt(process.env.MAX_DAILY_TRADES   || '20');
const MAX_DAILY_LOSS    = parseFloat(process.env.MAX_DAILY_LOSS_USDC || '50');
const MAX_EXPOSURE_PCT  = parseFloat(process.env.MAX_WALLET_EXPOSURE || '0.10');
const CLOB_HOST         = 'https://clob.polymarket.com';
const CHAIN_ID          = 137;

// ── Stato giornaliero ─────────────────────────────────────
let dailyStats = {
  date: new Date().toDateString(),
  trades: 0, pnl: 0, wins: 0, losses: 0,
  esposizioneTotale: 0
};

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats = { date: today, trades: 0, pnl: 0, wins: 0, losses: 0, esposizioneTotale: 0 };
    console.log('[Execution] Reset stats giornaliere');
  }
}

// ── Saldo wallet (da CLOB API quando live) ─────────────────
async function getSaldoWallet() {
  if (!TRADING_ENABLED || !process.env.WALLET_PRIVATE_KEY) return null;
  try {
    // In produzione: chiamata a CLOB API per saldo USDC
    // const r = await axios.get(CLOB_HOST + '/balance', { headers: authHeaders });
    // return r.data.balance;
    return null; // placeholder — implementare con chiave reale
  } catch(e) { return null; }
}

// ── Controlli sicurezza completi ───────────────────────────
async function verificaSicurezza(segnale) {
  resetIfNewDay();

  const errori = [];

  if (!TRADING_ENABLED)
    return { ok: false, motivo: 'TRADING_ENABLED=false — paper trading attivo' };

  if (!process.env.WALLET_PRIVATE_KEY)
    return { ok: false, motivo: 'WALLET_PRIVATE_KEY non configurata' };

  if (dailyStats.trades >= MAX_DAILY_TRADES)
    errori.push('Limite giornaliero: ' + dailyStats.trades + '/' + MAX_DAILY_TRADES);

  if (dailyStats.pnl <= -MAX_DAILY_LOSS)
    errori.push('Stop loss giornaliero: -$' + Math.abs(dailyStats.pnl).toFixed(2));

  if (!segnale.profittevole)
    errori.push('Segnale non profittevole');

  if (!segnale.prezzoContratto || segnale.prezzoContratto > 75)
    errori.push('Contratto troppo caro: ' + segnale.prezzoContratto + '¢');

  if (!segnale.pnlNetto || segnale.pnlNetto < 5)
    errori.push('P&L netto insufficiente: ' + segnale.pnlNetto + '¢');

  if (segnale.volume && segnale.volume < 500)
    errori.push('Volume insufficiente: $' + segnale.volume);

  // Controllo esposizione massima
  const saldo = await getSaldoWallet();
  if (saldo && TRADE_SIZE_USDC > saldo * MAX_EXPOSURE_PCT) {
    errori.push('Esposizione troppo alta: $' + TRADE_SIZE_USDC + ' > ' + (MAX_EXPOSURE_PCT*100) + '% di $' + saldo.toFixed(2));
  }

  if (errori.length > 0)
    return { ok: false, motivo: errori.join(' | ') };

  return { ok: true };
}

// ── Ottieni token IDs dal mercato ──────────────────────────
async function getTokenIds(slug, direzione) {
  try {
    const r = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { slug }, timeout: 5000
    });
    if (!r.data || !r.data.length) return null;
    const m = r.data[0];
    const tokenIds = typeof m.clobTokenIds === 'string'
      ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (!tokenIds || tokenIds.length < 2) return null;
    return direzione === 'UP' ? tokenIds[0] : tokenIds[1];
  } catch(e) {
    console.error('[Execution] Token IDs:', e.message);
    return null;
  }
}

// ── Piazza ordine ──────────────────────────────────────────
async function piazzaOrdine(segnale) {
  const check = await verificaSicurezza(segnale);
  if (!check.ok) {
    console.log('[Execution] Bloccato:', check.motivo);
    return { successo: false, motivo: check.motivo, paperTrade: !TRADING_ENABLED };
  }

  try {
    const tokenId = await getTokenIds(segnale.slug, segnale.direzione);
    if (!tokenId && TRADING_ENABLED) {
      return { successo: false, motivo: 'Token ID non trovato per ' + segnale.slug };
    }

    const price    = segnale.prezzoContratto / 100;
    const size     = parseFloat((TRADE_SIZE_USDC / price).toFixed(2));

    const risultato = {
      successo:      true,
      paperTrade:    !TRADING_ENABLED,
      asset:         segnale.asset,
      finestra:      segnale.finestra,
      direzione:     segnale.direzione,
      score:         segnale.score,
      momentum:      segnale.momentum || null,
      prezzoEntrata: segnale.prezzoContratto,
      sizeShares:    size,
      usdcSpesi:     TRADE_SIZE_USDC,
      pnlStimato:    parseFloat((segnale.pnlNetto / 100 * TRADE_SIZE_USDC).toFixed(2)),
      tokenId:       tokenId ? tokenId.slice(0, 20) + '...' : 'N/A (paper)',
      slug:          segnale.slug,
      timestamp:     new Date().toISOString()
    };

    if (TRADING_ENABLED) {
      // TODO: implementa firma EIP-712 e chiamata CLOB API
      // const { ethers } = require('ethers');
      // const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY);
      // const ordine = { tokenID: tokenId, price, size, side: 'BUY', ... };
      // const risposta = await client.createAndPostOrder(ordine);
      // risultato.txHash = risposta.transactionHash;
      console.log('[Execution] 🚨 LIVE TRADING — implementare firma EIP-712');
    } else {
      console.log('[Execution] 📋 Paper trade: ' + segnale.asset + '/' + segnale.finestra + ' ' + segnale.direzione + ' @' + segnale.prezzoContratto + '¢');
    }

    dailyStats.trades++;
    dailyStats.esposizioneTotale += TRADE_SIZE_USDC;
    return risultato;

  } catch(err) {
    console.error('[Execution] Errore ordine:', err.message);
    return { successo: false, motivo: err.message };
  }
}

// ── Registra esito operazione ──────────────────────────────
function registraEsito(ordine, esito) {
  if (!ordine || !esito) return;
  resetIfNewDay();

  const vinta = (ordine.direzione === 'UP' && esito === 'UP_WINS') ||
                (ordine.direzione === 'DOWN' && esito === 'DOWN_WINS');
  const pnlReale = vinta ? ordine.pnlStimato : -ordine.usdcSpesi;

  dailyStats.pnl += pnlReale;
  if (vinta) dailyStats.wins++; else dailyStats.losses++;

  console.log('[Execution] Esito:', esito, '| P&L reale:', (pnlReale >= 0 ? '+' : '') + '$' + pnlReale.toFixed(2));
  return { vinta, pnlReale, dailyStats };
}

// ── Stato sistema ──────────────────────────────────────────
function getStato() {
  resetIfNewDay();
  return {
    attivo:             TRADING_ENABLED,
    walletConfigurato:  !!process.env.WALLET_PRIVATE_KEY,
    tradeSizeUsdc:      TRADE_SIZE_USDC,
    maxDailyTrades:     MAX_DAILY_TRADES,
    maxDailyLoss:       MAX_DAILY_LOSS,
    maxEsposizionePct:  MAX_EXPOSURE_PCT * 100 + '%',
    oggi:               dailyStats,
    avvertenze: [
      !TRADING_ENABLED ? '⚠ Paper trading attivo — nessun ordine reale' : null,
      !process.env.WALLET_PRIVATE_KEY ? '⚠ WALLET_PRIVATE_KEY non configurata' : null,
    ].filter(Boolean)
  };
}

module.exports = { piazzaOrdine, registraEsito, getStato, verificaSicurezza };
