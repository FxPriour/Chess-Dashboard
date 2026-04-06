/**
 * lichess.js — Lichess live-game streaming
 *
 * Supports two URL types:
 *
 *  1. Regular game:
 *       https://lichess.org/AbCdEfGh
 *       Streams:  GET /api/stream/game/{id}  (NDJSON)
 *
 *  2. Broadcast / relay game:
 *       https://lichess.org/broadcast/{slug}/{slug}/{roundId}/{gameId}
 *       Streams:  GET /api/broadcast/round/{roundId}/games  (NDJSON)
 *       Each NDJSON line is one game in the round; we filter by gameId.
 *       Each line contains a `pgn` field with full PGN including headers.
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
    this._initialized   = false;   // used by broadcast path

    // Callbacks — overwritten by app.js
    this.onConnect  = () => {};
    this.onMove     = () => {};
    this.onInfo     = () => {};
    this.onGameEnd  = () => {};
    this.onError    = () => {};
  }

  // ─── Public ──────────────────────────────────────────────────

  async connect (urlOrId) {
    this.disconnect();
    this._chess       = new Chess();
    this._moveCount   = 0;
    this._prevFen     = null;
    this._initialized = false;

    // ── Broadcast URL? ────────────────────────────────────────
    const broadcast = this._parseBroadcastUrl(urlOrId);
    if (broadcast) {
      this.gameId = broadcast.gameId;
      this.onConnect({ gameId: broadcast.gameId });
      try {
        this._abortCtrl = new AbortController();
        await this._connectBroadcast(broadcast.roundId, broadcast.gameId);
      } catch (err) {
        if (err.name !== 'AbortError') this.onError(`Network error: ${err.message}`);
      }
      return;
    }

    // ── Regular game ──────────────────────────────────────────
    const gameId = this._parseGameId(urlOrId);
    if (!gameId) {
      this.onError('Cannot parse game ID — paste a Lichess URL or the 8-char ID directly.');
      return;
    }

    this.gameId = gameId;
    this.onConnect({ gameId });

    try {
      this._abortCtrl = new AbortController();
      const res = await fetch(
        `https://lichess.org/api/stream/game/${gameId}`,
        { headers: { Accept: 'application/x-ndjson' }, signal: this._abortCtrl.signal }
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
      if (err.name !== 'AbortError') this.onError(`Network error: ${err.message}`);
    }
  }

  disconnect () {
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
  }

  // ─── Broadcast path ──────────────────────────────────────────

  async _connectBroadcast (roundId, gameId) {
    const res = await fetch(
      `https://lichess.org/api/broadcast/round/${roundId}/games`,
      { headers: { Accept: 'application/x-ndjson' }, signal: this._abortCtrl.signal }
    );
    if (!res.ok) {
      this.onError(
        res.status === 404
          ? `Broadcast round "${roundId}" not found.`
          : `Lichess API returned HTTP ${res.status}.`
      );
      return;
    }
    await this._readBroadcastStream(res.body, gameId);
  }

  async _readBroadcastStream (body, targetGameId) {
    const reader  = body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { this.onGameEnd({ reason: 'stream closed' }); break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.id === targetGameId) this._handleBroadcastGame(data);
          } catch (e) {
            console.warn('[Lichess] Broadcast parse error:', line);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.onError(`Broadcast stream error: ${err.message}`);
    }
  }

  /**
   * Process one broadcast game snapshot.
   * Each snapshot contains a full PGN with all moves played so far.
   * We diff against this._moveCount to emit only new moves incrementally.
   */
  _handleBroadcastGame (data) {
    console.debug('[Lichess Broadcast]', data);

    // Surface player names
    const white = data.players?.white ?? data.white;
    const black = data.players?.black ?? data.black;
    if (white || black) this.onInfo({ white, black });

    if (!data.pgn) return;

    // Parse PGN into a temp chess instance
    const tmp = new Chess();
    const ok  = tmp.load_pgn(data.pgn);
    if (!ok) {
      console.warn('[Lichess] Could not parse broadcast PGN');
      return;
    }

    const history    = tmp.history({ verbose: true });
    const totalMoves = history.length;

    // ── First snapshot: jump silently to current position ─────
    if (!this._initialized) {
      this._initialized = true;

      // Advance this._chess to match current position
      for (const mv of history) {
        this._chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      }
      this._moveCount = totalMoves;

      const last = history[totalMoves - 1] ?? null;
      this.onMove({
        fen:         this._chess.fen(),
        lastMoveUci: last ? `${last.from}${last.to}${last.promotion ?? ''}` : null,
        lastMoveSan: last?.san ?? null,
        moveNumber:  totalMoves,
        isInitial:   true,
        turn:        this._chess.turn(),
      });

    // ── Subsequent snapshots: apply only new moves ─────────────
    } else if (totalMoves > this._moveCount) {
      const newMoves = history.slice(this._moveCount);
      for (const mv of newMoves) {
        const applied = this._chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
        if (!applied) break;
        this._moveCount++;
        this.onMove({
          fen:         this._chess.fen(),
          lastMoveUci: `${mv.from}${mv.to}${mv.promotion ?? ''}`,
          lastMoveSan: applied.san,
          moveNumber:  this._moveCount,
          isInitial:   false,
          turn:        this._chess.turn(),
        });
      }
    }

    // Detect game end from PGN Result header
    const resultMatch = data.pgn.match(/\[Result "([^"]+)"\]/);
    const result      = resultMatch?.[1];
    if (result && result !== '*') this.onGameEnd({ status: result });
  }

  // ─── Regular game stream ──────────────────────────────────────

  async _readStream (body) {
    const reader  = body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { this.onGameEnd({ reason: 'stream closed' }); break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this._handleData(JSON.parse(trimmed));
          } catch (e) {
            console.warn('[Lichess] Unparseable line:', trimmed);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.onError(`Stream error: ${err.message}`);
    }
  }

  _handleData (data) {
    console.debug('[Lichess]', data);

    if (data.type === 'gameFull') {
      this.onInfo({ white: data.white, black: data.black, clock: data.clock, variant: data.variant, speed: data.speed });
      this._applyMoveString(data.state?.moves ?? '');
      return;
    }
    if (data.type === 'gameState') {
      this._applyMoveString(data.moves ?? '');
      const ended = data.status && data.status !== 'started' && data.status !== 'created';
      if (ended) this.onGameEnd({ status: data.status, winner: data.winner });
      return;
    }
    if (data.id && data.players && !data.fen) {
      this.onInfo({ white: data.players.white, black: data.players.black });
      return;
    }
    if (data.fen) {
      this._applyFenUpdate(data.fen, data.lm ?? null);
      return;
    }
    if (typeof data.moves === 'string') {
      if (data.players) this.onInfo({ white: data.players.white, black: data.players.black });
      this._applyMoveString(data.moves);
      const status = data.status?.name ?? data.status;
      if (status && status !== 'started' && status !== 'created') this.onGameEnd({ status });
      return;
    }

    console.debug('[Lichess] Unrecognised event format:', data);
  }

  _applyFenUpdate (fen, lm) {
    const parts     = fen.split(' ');
    const turn      = parts[1];
    const fullMove  = parseInt(parts[5], 10);
    const halfMoves = (fullMove - 1) * 2 + (turn === 'b' ? 1 : 0);

    let lastMoveSan = null;
    if (lm && this._prevFen) {
      const tmp = new Chess();
      tmp.load(this._prevFen);
      const move = tmp.move({ from: lm.slice(0, 2), to: lm.slice(2, 4), promotion: lm.length === 5 ? lm[4] : undefined });
      if (move) lastMoveSan = move.san;
    }

    this._prevFen   = fen;
    this._moveCount = halfMoves;
    this.onMove({ fen, lastMoveUci: lm, lastMoveSan, moveNumber: halfMoves, isInitial: !lm, turn });
  }

  _applyMoveString (movesStr) {
    const all = movesStr.trim() ? movesStr.trim().split(/\s+/) : [];
    if (all.length === 0) return;

    if (this._moveCount === 0) {
      for (const uci of all) {
        if (!this._applyUCI(uci)) break;
        this._moveCount++;
      }
      this.onMove({
        fen:         this._chess.fen(),
        lastMoveUci: all[all.length - 1] ?? null,
        lastMoveSan: null,
        moveNumber:  this._moveCount,
        isInitial:   true,
        turn:        this._chess.turn(),
      });
      return;
    }

    while (this._moveCount < all.length) {
      const uci  = all[this._moveCount];
      const move = this._applyUCI(uci);
      if (!move) { console.warn('[Lichess] Could not apply UCI move:', uci); break; }
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

  _applyUCI (uci) {
    if (!uci || uci.length < 4) return null;
    return this._chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length === 5 ? uci[4] : undefined }) ?? null;
  }

  // ─── URL parsers ──────────────────────────────────────────────

  /**
   * Detect a broadcast URL and extract roundId + gameId.
   * Pattern: lichess.org/broadcast/{slug}/{slug}/{roundId}/{gameId}
   * Returns { roundId, gameId } or null.
   */
  _parseBroadcastUrl (input) {
    const m = input.trim().match(
      /lichess\.org\/broadcast\/[^/]+\/[^/]+\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/
    );
    return m ? { roundId: m[1], gameId: m[2] } : null;
  }

  /**
   * Extract a Lichess game ID (8–12 alphanumeric chars) from a URL or bare ID.
   * Handles: https://lichess.org/AbCdEfGh[/white], /game/export/AbCdEfGh, bare IDs.
   */
  _parseGameId (input) {
    const s = input.trim();
    const m = s.match(/(?:lichess\.org\/(?:game\/export\/)?)?([A-Za-z0-9]{8,12})(?:[/?]|$)/);
    return m ? m[1] : null;
  }
}
