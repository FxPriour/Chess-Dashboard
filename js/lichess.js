/**
 * lichess.js — Lichess live-game streaming
 *
 * Connects to:  GET https://lichess.org/api/stream/game/{id}
 *
 * The endpoint returns NDJSON (newline-delimited JSON).
 * Each line is a full game-state snapshot; the `moves` field grows as
 * new moves are played.  Authentication is not required for public games.
 *
 * Two secondary formats are also handled transparently:
 *   • Board-API  gameFull / gameState   (for games the user owns)
 *   • keep-alive empty lines            (ignored)
 *
 * Public API
 * ──────────
 *   stream.connect(urlOrId)   → Promise
 *   stream.disconnect()
 *   stream.gameId             → string | null
 *
 * Callbacks (set directly on instance)
 * ─────────────────────────────────────
 *   stream.onConnect({ gameId })
 *   stream.onMove({ fen, lastMoveUci, lastMoveSan, moveNumber, isInitial, turn })
 *   stream.onInfo({ white, black, clock, variant, speed })
 *   stream.onGameEnd({ reason, status })
 *   stream.onError(message)
 */

/* global Chess */

class LichessStream {
  constructor () {
    this.gameId         = null;
    this._abortCtrl     = null;
    this._chess         = null;
    this._moveCount     = 0;
    this._prevFen       = null;

    // Callbacks — overwritten by app.js
    this.onConnect  = () => {};
    this.onMove     = () => {};
    this.onInfo     = () => {};
    this.onGameEnd  = () => {};
    this.onError    = () => {};
  }

  // ─── Public ──────────────────────────────────────────────────

  async connect (urlOrId) {
    const gameId = this._parseGameId(urlOrId);
    if (!gameId) {
      this.onError('Cannot parse game ID — paste a Lichess URL or the 8-char ID directly.');
      return;
    }

    this.disconnect();
    this.gameId     = gameId;
    this._chess     = new Chess();
    this._moveCount = 0;
    this._prevFen   = null;

    this.onConnect({ gameId });

    try {
      this._abortCtrl = new AbortController();

      const res = await fetch(
        `https://lichess.org/api/stream/game/${gameId}`,
        {
          headers: { Accept: 'application/x-ndjson' },
          signal:  this._abortCtrl.signal,
        }
      );

      if (!res.ok) {
        const msg = res.status === 404
          ? `Game "${gameId}" not found. Check it is public and has started.`
          : `Lichess API returned HTTP ${res.status}.`;
        this.onError(msg);
        return;
      }

      await this._readStream(res.body);

    } catch (err) {
      if (err.name !== 'AbortError') {
        this.onError(`Network error: ${err.message}`);
      }
    }
  }

  disconnect () {
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
  }

  // ─── Stream reader ───────────────────────────────────────────

  async _readStream (body) {
    const reader  = body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          this.onGameEnd({ reason: 'stream closed' });
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();           // keep any incomplete final chunk

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;       // keep-alive ping — ignore
          try {
            this._handleData(JSON.parse(trimmed));
          } catch (e) {
            console.warn('[Lichess] Unparseable line:', trimmed);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.onError(`Stream error: ${err.message}`);
      }
    }
  }

  // ─── Event routing ───────────────────────────────────────────

  _handleData (data) {
    console.debug('[Lichess]', data);   // helpful when debugging in DevTools

    // ── Board-API format (gameFull) ───────────────────────────
    if (data.type === 'gameFull') {
      this.onInfo({
        white:   data.white,
        black:   data.black,
        clock:   data.clock,
        variant: data.variant,
        speed:   data.speed,
      });
      this._applyMoveString(data.state?.moves ?? '');
      return;
    }

    // ── Board-API format (gameState update) ───────────────────
    if (data.type === 'gameState') {
      this._applyMoveString(data.moves ?? '');
      const ended = data.status && data.status !== 'started' && data.status !== 'created';
      if (ended) this.onGameEnd({ status: data.status, winner: data.winner });
      return;
    }

    // ── Streaming format: initial game metadata ───────────────
    // First message has { id, players, speed, … } but no fen/type
    if (data.id && data.players && !data.fen) {
      this.onInfo({
        white: data.players.white,
        black: data.players.black,
      });
      return;
    }

    // ── Streaming format: per-move position update ────────────
    // Subsequent messages have { fen, lm?, wc, bc }
    if (data.fen) {
      this._applyFenUpdate(data.fen, data.lm ?? null);
      return;
    }

    // ── stream/game format (top-level game snapshot) ──────────
    if (typeof data.moves === 'string') {
      // Surface player names if available
      if (data.players) {
        this.onInfo({
          white: data.players.white,
          black: data.players.black,
        });
      }

      this._applyMoveString(data.moves);

      // Check for terminal status
      const status = data.status?.name ?? data.status;
      if (status && status !== 'started' && status !== 'created') {
        this.onGameEnd({ status });
      }
      return;
    }

    console.debug('[Lichess] Unrecognised event format:', data);
  }

  // ─── Move application ────────────────────────────────────────

  /**
   * Handle a { fen, lm } streaming update.
   * Converts the UCI last-move to SAN using the previous position.
   */
  _applyFenUpdate (fen, lm) {
    const parts    = fen.split(' ');
    const turn     = parts[1];                         // 'w' or 'b'
    const fullMove = parseInt(parts[5], 10);
    const halfMoves = (fullMove - 1) * 2 + (turn === 'b' ? 1 : 0);

    let lastMoveSan = null;
    if (lm && this._prevFen) {
      const tmp = new Chess();
      tmp.load(this._prevFen);
      const move = tmp.move({
        from: lm.slice(0, 2),
        to:   lm.slice(2, 4),
        promotion: lm.length === 5 ? lm[4] : undefined,
      });
      if (move) lastMoveSan = move.san;
    }

    this._prevFen   = fen;
    this._moveCount = halfMoves;

    this.onMove({
      fen,
      lastMoveUci: lm,
      lastMoveSan,
      moveNumber:  halfMoves,
      isInitial:   !lm,
      turn,
    });
  }

  /**
   * Apply moves from a space-separated UCI move string.
   * If this is the first batch (join mid-game), we jump silently to the
   * current position then fire a single onMove with isInitial:true.
   * Subsequent calls animate one move at a time.
   */
  _applyMoveString (movesStr) {
    const all = movesStr.trim() ? movesStr.trim().split(/\s+/) : [];

    if (all.length === 0) return;

    // ── Initial bulk-load: jump silently to current position ──
    if (this._moveCount === 0) {
      for (const uci of all) {
        if (!this._applyUCI(uci)) break;
        this._moveCount++;
      }
      this.onMove({
        fen:         this._chess.fen(),
        lastMoveUci: all[all.length - 1] ?? null,
        lastMoveSan: null,            // SAN not tracked on initial load
        moveNumber:  this._moveCount,
        isInitial:   true,
        turn:        this._chess.turn(),
      });
      return;
    }

    // ── Incremental: play each new move with an event ─────────
    while (this._moveCount < all.length) {
      const uci  = all[this._moveCount];
      const move = this._applyUCI(uci);
      if (!move) {
        console.warn('[Lichess] Could not apply UCI move:', uci, 'FEN:', this._chess.fen());
        break;
      }
      this._moveCount++;
      this.onMove({
        fen:         this._chess.fen(),
        lastMoveUci: uci,
        lastMoveSan: move.san,
        moveNumber:  this._moveCount,
        isInitial:   false,
        turn:        this._chess.turn(),
      });
    }
  }

  /**
   * Apply a single UCI move (e.g. "e2e4", "e7e8q") to the internal Chess
   * instance.  Returns the move object on success, null on failure.
   */
  _applyUCI (uci) {
    if (!uci || uci.length < 4) return null;
    const from      = uci.slice(0, 2);
    const to        = uci.slice(2, 4);
    const promotion = uci.length === 5 ? uci[4] : undefined;
    return this._chess.move({ from, to, promotion }) ?? null;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * Extract an 8-char Lichess game ID from a URL or bare ID.
   * Handles:
   *   https://lichess.org/AbCdEfGh
   *   https://lichess.org/AbCdEfGh/white
   *   https://lichess.org/game/export/AbCdEfGh
   *   AbCdEfGh
   */
  _parseGameId (input) {
    const s = input.trim();
    const m = s.match(/(?:lichess\.org\/(?:game\/export\/)?)?([A-Za-z0-9]{8,12})(?:[/?]|$)/);
    return m ? m[1] : null;
  }
}
