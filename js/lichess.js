/**
 * lichess.js — Lichess live-game streaming
 *
 * Supports two URL types:
 *
 *  1. Regular game:
 *       https://lichess.org/AbCdEfGh
 *       Streams:  GET /api/stream/game/{id}  (NDJSON, keep-alive)
 *
 *  2. Broadcast / relay game:
 *       https://lichess.org/broadcast/{slug}/{slug}/{roundId}/{gameId}
 *       Fetches:  GET /api/broadcast/round/{roundId}.pgn  (multi-game PGN)
 *       The specific game is found by searching for gameId in the PGN headers.
 *       Live updates use 5-second polling (no unauthenticated streaming API exists).
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
 *   stream.onInfo({ white, black })
 *   stream.onGameEnd({ reason, status })
 *   stream.onError(message)
 */

/* global Chess */

const BROADCAST_POLL_MS = 5000;

class LichessStream {
  constructor () {
    this.gameId         = null;
    this._abortCtrl     = null;
    this._chess         = null;
    this._moveCount     = 0;
    this._prevFen       = null;
    this._initialized   = false;
    this._pollInterval  = null;

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
    this._stopPolling();
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
  }

  // ─── Broadcast path ──────────────────────────────────────────

  /**
   * Fetch the round PGN once, load the specific game, then poll for updates.
   * The endpoint /api/broadcast/round/{roundId}.pgn returns all games in the
   * round as a multi-game PGN file.
   */
  async _connectBroadcast (roundId, gameId) {
    const url = `https://lichess.org/api/broadcast/round/${roundId}.pgn`;

    const loaded = await this._fetchBroadcastPGN(url, gameId);
    if (!loaded) return;   // error already reported

    // If game has a result header it is finished — no need to poll
    if (this._broadcastGameOver) return;

    // Poll for live updates
    this._pollInterval = setInterval(async () => {
      if (!this._abortCtrl) { this._stopPolling(); return; }
      try {
        await this._fetchBroadcastPGN(url, gameId);
        if (this._broadcastGameOver) this._stopPolling();
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Lichess] Poll error:', e.message);
      }
    }, BROADCAST_POLL_MS);
  }

  /** Fetch the round PGN, find the game, and apply new moves. Returns true on success. */
  async _fetchBroadcastPGN (url, gameId) {
    const res = await fetch(url, {
      headers: { Accept: 'application/x-chess-pgn' },
      signal:  this._abortCtrl?.signal,
    });

    if (!res.ok) {
      this.onError(
        res.status === 404
          ? `Broadcast round not found. Check the URL is correct.`
          : `Lichess API returned HTTP ${res.status}.`
      );
      return false;
    }

    const fullPgn  = await res.text();
    const gamePgn  = this._findGameInMultiPGN(fullPgn, gameId);

    if (!gamePgn) {
      this.onError(`Game "${gameId}" not found in broadcast round.`);
      return false;
    }

    this._applyBroadcastPGN(gamePgn);
    return true;
  }

  /**
   * Parse a single-game PGN and apply any moves not yet seen.
   * On the first call (isInitial), jump silently to the current position.
   */
  _applyBroadcastPGN (pgn) {
    const tmp = new Chess();
    if (!tmp.load_pgn(pgn)) {
      console.warn('[Lichess] Could not parse broadcast PGN');
      return;
    }

    const history    = tmp.history({ verbose: true });
    const totalMoves = history.length;

    // Extract player names from PGN headers
    const white = (pgn.match(/\[White "([^"]+)"\]/)    ?? [])[1];
    const black = (pgn.match(/\[Black "([^"]+)"\]/)    ?? [])[1];
    const wElo  = (pgn.match(/\[WhiteElo "([^"]+)"\]/) ?? [])[1];
    const bElo  = (pgn.match(/\[BlackElo "([^"]+)"\]/) ?? [])[1];
    if (white || black) {
      this.onInfo({
        white: white ? { name: white, rating: wElo ? parseInt(wElo) : undefined } : undefined,
        black: black ? { name: black, rating: bElo ? parseInt(bElo) : undefined } : undefined,
      });
    }

    // ── First load: jump silently to current position ─────────
    if (!this._initialized) {
      this._initialized = true;

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

    // ── Subsequent polls: apply only new moves ─────────────────
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

    // Detect game end from Result header
    const result = (pgn.match(/\[Result "([^"]+)"\]/) ?? [])[1];
    this._broadcastGameOver = !!(result && result !== '*');
    if (this._broadcastGameOver) this.onGameEnd({ status: result });
  }

  /**
   * Split a multi-game PGN and return the single game whose headers contain gameId.
   * Lichess includes the broadcast URL (with the chapter ID) in the [Site] header.
   */
  _findGameInMultiPGN (pgn, gameId) {
    // Games are separated by a blank line followed by '[Event'
    const games = pgn.split(/(?=\[Event )/).map(s => s.trim()).filter(Boolean);
    return games.find(g => g.includes(gameId)) ?? null;
  }

  _stopPolling () {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
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

  /** Returns { roundId, gameId } for broadcast URLs, null otherwise. */
  _parseBroadcastUrl (input) {
    const m = input.trim().match(
      /lichess\.org\/broadcast\/[^/]+\/[^/]+\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/
    );
    return m ? { roundId: m[1], gameId: m[2] } : null;
  }

  /** Extracts a Lichess game ID (8-12 alphanumeric chars) from a URL or bare ID. */
  _parseGameId (input) {
    const s = input.trim();
    const m = s.match(/(?:lichess\.org\/(?:game\/export\/)?)?([A-Za-z0-9]{8,12})(?:[/?]|$)/);
    return m ? m[1] : null;
  }
}
