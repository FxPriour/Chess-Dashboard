/**
 * engine.js — Stockfish web-worker wrapper
 *
 * Loads stockfish.js from CDN via a blob-URL trick that bypasses the
 * browser's same-origin restriction on Web Workers.
 *
 * Public API
 * ──────────
 *   engine.init()           — load worker, send UCI handshake
 *   engine.analyze(fen)     — stop current search, start new one
 *   engine.stop()           — send "stop" to worker
 *   engine.setMultiPV(n)    — set number of lines (default 3)
 *
 * Callbacks (set directly on the instance)
 * ─────────────────────────────────────────
 *   engine.onReady()
 *   engine.onInfo(info)     — called for every "info depth … score …" line
 *   engine.onBestMove(uci)  — called when "bestmove" arrives
 */

/* global Chess */

class StockfishEngine {
  constructor () {
    this.worker      = null;
    this.isReady     = false;
    this.multiPV     = 3;

    // Callbacks — overwritten by app.js
    this.onReady    = () => {};
    this.onInfo     = () => {};
    this.onBestMove = () => {};
  }

  // ─── Public ──────────────────────────────────────────────────

  init () {
    // Blob-URL trick: worker loads an external script without CORS issues
    const cdnUrl = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';
    const blob   = new Blob(
      [`importScripts('${cdnUrl}');`],
      { type: 'application/javascript' }
    );
    const workerUrl = URL.createObjectURL(blob);

    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (e) => this._handleMessage(e.data);
    this.worker.onerror   = (e) => console.error('[Engine] Worker error:', e.message);

    this.worker.postMessage('uci');
  }

  analyze (fen, depth = 18) {
    if (!this.isReady) return;
    this.worker.postMessage('stop');
    this.worker.postMessage(`setoption name MultiPV value ${this.multiPV}`);
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${depth}`);
  }

  stop () {
    if (this.worker) this.worker.postMessage('stop');
  }

  setMultiPV (n) {
    this.multiPV = n;
    if (this.worker) {
      this.worker.postMessage(`setoption name MultiPV value ${n}`);
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  _handleMessage (msg) {
    if (msg === 'uciok') {
      this.worker.postMessage('isready');
      return;
    }

    if (msg === 'readyok') {
      this.isReady = true;
      this.onReady();
      return;
    }

    if (msg.startsWith('info')) {
      const parsed = this._parseInfo(msg);
      if (parsed) this.onInfo(parsed);
      return;
    }

    if (msg.startsWith('bestmove')) {
      const m = msg.match(/^bestmove\s+(\S+)/);
      if (m) this.onBestMove(m[1]);
    }
  }

  /**
   * Parse an "info depth … score cp … multipv … pv …" string.
   * Returns null for info lines without a score (e.g. currmove lines).
   */
  _parseInfo (msg) {
    const depth    = this._extractInt(msg, /\bdepth (\d+)/);
    const multipv  = this._extractInt(msg, /\bmultipv (\d+)/) ?? 1;
    const cp       = this._extractInt(msg, /\bscore cp (-?\d+)/);
    const mate     = this._extractInt(msg, /\bscore mate (-?\d+)/);
    const pvMatch  = msg.match(/\bpv\s+(\S+)/);

    if (depth === null || (cp === null && mate === null)) return null;

    return {
      depth,
      multipv,
      cp:       cp ?? (mate !== null ? (mate > 0 ? 30000 : -30000) : 0),
      mate,
      bestMove: pvMatch ? pvMatch[1] : null,
      raw:      msg,
    };
  }

  _extractInt (str, re) {
    const m = str.match(re);
    return m ? parseInt(m[1], 10) : null;
  }
}
