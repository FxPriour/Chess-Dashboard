/**
 * app.js — main orchestrator
 *
 * Wires together:
 *   • ChessBoard  (board.js)
 *   • StockfishEngine (engine.js)
 *   • LichessStream   (lichess.js)
 *   • DOM controls
 *
 * Indicator stubs (filled in later sessions):
 *   • Complexity       — placeholder, wired to engine MultiPV
 *   • Position Tension — placeholder, wired to chess.js move generation
 *   • Theory Distance  — placeholder, counts moves from start
 */

/* global ChessBoard, StockfishEngine, LichessStream, Chess */

document.addEventListener('DOMContentLoaded', () => {

  // ── Instantiate modules ──────────────────────────────────────
  const board  = new ChessBoard('board');
  const engine = new StockfishEngine();
  const stream = new LichessStream();

  // Internal chess instance for indicator calculations
  // (kept in sync with the displayed position)
  const chess = new Chess();

  board.init();
  engine.init();

  // Multi-PV needed for complexity indicator later
  engine.setMultiPV(3);

  // ── DOM references ───────────────────────────────────────────
  const $ = id => document.getElementById(id);

  const connectBtn    = $('connectBtn');
  const disconnectBtn = $('disconnectBtn');
  const flipBtn       = $('flipBtn');
  const gameUrlInput  = $('gameUrl');
  const reviewUrlInput = $('reviewUrl');
  const statusEl      = $('status');
  const scoresheetEl  = $('scoresheet');

  // ── Move history & browse state ──────────────────────────────
  const moveHistory = [];   // { fen, uci, san }
  let   browseIdx   = -1;   // -1 = live (follow latest), ≥0 = browsing that index

  // ── Engine position context (for difficulty calculation) ─────
  let engineFen         = null;   // FEN currently being analysed by Stockfish
  let engineLastCapture = false;  // whether the move arriving at engineFen was a capture

  // ── Review mode state ────────────────────────────────────────
  let currentMode      = 'live';  // 'live' | 'review'
  let reviewPositions  = [];      // [{fen, uci, san}]; index 0 = start position
  let reviewIdx        = 0;       // current position index in reviewPositions
  let reviewAutoPlay   = null;    // setInterval handle for auto-play

  // ── Engine callbacks ─────────────────────────────────────────

  engine.onReady = () => {
    $('engStatus').textContent = 'Stockfish 10 ready';
  };

  /**
   * Collect all MultiPV lines before updating the UI.
   * We gather them into a map keyed by depth and flush when we see
   * multipv === engine.multiPV (the last line at that depth).
   */
  const pvLines = {};   // multipv index → latest info object

  engine.onInfo = (info) => {
    pvLines[info.multipv] = info;

    // Only render once we have a complete set of PV lines
    if (info.multipv !== engine.multiPV) return;

    const top = pvLines[1];
    if (!top) return;

    // Eval bar & engine readout
    updateEvalBar(top.cp, top.mate, computeDifficulty(pvLines, top.depth));
    $('engEval').textContent  = top.mate !== null
      ? (top.mate > 0 ? `+M${top.mate}` : `-M${Math.abs(top.mate)}`)
      : (top.cp >= 0 ? `+${(top.cp / 100).toFixed(2)}` : `${(top.cp / 100).toFixed(2)}`);
    $('engDepth').textContent = top.depth;
    $('engBest').textContent  = top.bestMove ?? '—';

    // ── Complexity (stub) ────────────────────────────────────────
    // Full implementation will use spread of MultiPV scores.
    // For now: wider spread = lower complexity (engine clear on best move),
    //          narrow spread = higher complexity (many moves look equal).
    updateComplexityStub(pvLines, top.depth);
  };

  engine.onBestMove = (uci) => {
    $('engBest').textContent = uci;
  };

  // ── Stream callbacks ─────────────────────────────────────────

  stream.onConnect = ({ gameId }) => {
    setStatus(`Connecting to ${gameId}…`, '');
    connectBtn.disabled    = true;
    disconnectBtn.disabled = false;
    board.reset();
    chess.reset();
    clearIndicators();
  };

  stream.onInfo = ({ white, black }) => {
    const wName = white?.user?.name ?? white?.name ?? 'White';
    const bName = black?.user?.name ?? black?.name ?? 'Black';
    const wRating = white?.rating ? ` (${white.rating})` : '';
    const bRating = black?.rating ? ` (${black.rating})` : '';
    $('playerWhite').textContent = wName + wRating;
    $('playerBlack').textContent = bName + bRating;
  };

  stream.onMove = (moveData) => {
    const { fen, lastMoveUci, lastMoveSan, moveNumber, isInitial, turn } = moveData;

    // Sync internal chess instance (always tracks live position)
    chess.load(fen);

    // Board + engine only update when not browsing past moves
    if (browseIdx === -1) {
      board.setPosition(fen, lastMoveUci, !isInitial);
      engineFen         = fen;
      engineLastCapture = !!(lastMoveSan && lastMoveSan.includes('x'));
      engine.analyze(fen);
    }

    // Move ticker (always shows live move)
    const sideLabel = turn === 'w' ? 'Black just moved' : 'White just moved';
    const moveLabel = lastMoveSan
      ? `${Math.ceil(moveNumber / 2)}${turn === 'w' ? '.' : '…'} ${lastMoveSan}`
      : `Move ${moveNumber}`;
    $('moveTicker').textContent = `${moveLabel}  ·  ${sideLabel}`;

    // Status bar
    const turnStr = turn === 'w' ? 'White to move' : 'Black to move';
    setStatus(
      `${isInitial ? 'Joined at move ' : 'Move '}${moveNumber} — ${turnStr}`,
      'connected'
    );

    // Scoresheet: push every non-initial move that has a SAN
    if (!isInitial && lastMoveSan) {
      ssPushMove(fen, lastMoveUci, lastMoveSan);
    }

    // ── Position Tension (stub) ──────────────────────────────────
    updateTensionStub(chess);

    // ── Theory Distance (stub) ──────────────────────────────────
    updateTheoryStub(moveNumber);
  };

  stream.onGameEnd = ({ reason, status }) => {
    const msg = status
      ? `Game over — ${typeof status === 'object' ? status.name : status}`
      : `Stream ended (${reason ?? 'unknown'})`;
    setStatus(msg, '');
    connectBtn.disabled    = false;
    disconnectBtn.disabled = true;
    engine.stop();
  };

  stream.onError = (msg) => {
    setStatus(`Error: ${msg}`, 'error');
    connectBtn.disabled    = false;
    disconnectBtn.disabled = true;
  };

  // ── Button handlers ──────────────────────────────────────────

  connectBtn.addEventListener('click', () => {
    const val = gameUrlInput.value.trim();
    if (!val) { gameUrlInput.focus(); return; }
    stream.connect(val);
  });

  disconnectBtn.addEventListener('click', () => {
    stream.disconnect();
    engine.stop();
    setStatus('Disconnected', '');
    connectBtn.disabled    = false;
    disconnectBtn.disabled = true;
  });

  flipBtn.addEventListener('click', () => board.flip());

  gameUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectBtn.click();
  });

  // ── Eval bar ─────────────────────────────────────────────────

  /**
   * Update the two-segment vertical eval bar.
   *
   * Layout (top → bottom):
   *   top segment    = black's share of bar (always darker shade)
   *   bottom segment = white's share of bar (always brighter shade)
   *
   * SIZE encodes who is winning (cp / mate).
   * COLOR encodes human difficulty derived from MultiPV spread.
   *
   * difficulty: 'easy' | 'medium' | 'hard' | null
   */
  function updateEvalBar (cp, mate, difficulty = null) {
    const topEl  = $('evalTop');
    const botEl  = $('evalBottom');
    const midEl  = document.querySelector('.eval-midline');
    const lblTop = $('evalLabelTop');
    const lblBot = $('evalLabelBot');

    // ── Height (who is winning) ────────────────────────────────
    let topPct, labelTop, labelBot;

    if (mate !== null) {
      topPct   = mate > 0 ? 5 : 95;
      labelTop = mate < 0 ? `M${Math.abs(mate)}` : '·';
      labelBot = mate > 0 ? `M${mate}`           : '·';
    } else {
      const raw = 50 - (Math.atan(cp / 250) / Math.PI) * 100;
      topPct    = Math.max(5, Math.min(95, raw));
      const abs = Math.abs(cp / 100).toFixed(1);
      labelTop  = cp < 0 ? `+${abs}` : '·';
      labelBot  = cp > 0 ? `+${abs}` : '·';
    }

    topEl.style.height = topPct + '%';
    botEl.style.height = (100 - topPct) + '%';
    midEl.style.top    = topPct + '%';

    // ── Color (human difficulty) ───────────────────────────────
    const { lo, hi } = difficultyPalette(difficulty);
    topEl.style.backgroundColor = lo;
    botEl.style.backgroundColor = hi;

    lblTop.textContent = labelTop;
    lblBot.textContent = labelBot;
  }

  /**
   * Return { lo, hi } CSS colors for each difficulty level.
   * lo = top (black's side, darker)
   * hi = bottom (white's side, brighter)
   */
  function difficultyPalette (difficulty) {
    switch (difficulty) {
      case 'easy':   return { lo: '#1b5e20', hi: '#69f0ae' };
      case 'medium': return { lo: '#bf360c', hi: '#ff9800' };
      case 'hard':   return { lo: '#7f0000', hi: '#ff5252' };
      default:       return { lo: '#1c1c36', hi: '#444466' };
    }
  }

  /**
   * Two-stage difficulty assessment.
   *
   * Stage 1 — Obvious-move filter (chess.js, no extra engine work):
   *   Override to 'easy' when a human would find the move intuitively:
   *   very few legal moves, in check, recapture available, hanging piece,
   *   or mate in 1 on the board.
   *
   * Stage 2 — PV spread (only when no obvious move detected):
   *   gap PV1-PV2 > 100 cp → 'hard'  (one precise move required)
   *   gap PV1-PV2 < 50 cp  → 'easy'  (multiple good options)
   *   50–100 cp            → 'medium'
   *
   * Requires depth ≥ 8 and at least 2 PV lines.
   */
  function computeDifficulty (lines, depth) {
    if (depth < 8 || !engineFen) return null;

    // Stage 1
    if (isObviousPosition(lines)) return 'easy';

    // Stage 2
    const cp1 = lines[1]?.cp ?? null;
    const cp2 = lines[2]?.cp ?? null;
    if (cp1 === null || cp2 === null) return null;

    const gap = Math.abs(cp1 - cp2);
    if (gap >= 100) return 'hard';
    if (gap <= 50)  return 'easy';
    return 'medium';
  }

  /**
   * Return true when the position has an intuitively obvious best move,
   * so that large PV gaps don't falsely signal difficulty.
   *
   * Uses engineFen (the position currently being analysed) and
   * engineLastCapture (whether the move arriving at that position was a capture).
   */
  function isObviousPosition (lines) {
    const pos = new Chess();
    if (!pos.load(engineFen)) return false;

    const moves = pos.moves({ verbose: true });

    // 1. Very few legal moves (forced or near-forced)
    if (moves.length <= 3) return true;

    // 2. Side to move is in check
    if (pos.in_check()) return true;

    // 3. Last move was a capture — recapture is likely the natural reply
    if (engineLastCapture) return true;

    // 4. A hanging piece can be taken for free
    if (hasHangingCapture(pos, moves)) return true;

    // 5. Mate in 1 is available
    if (lines[1]?.mate === 1) return true;

    return false;
  }

  /**
   * Return true when moves contains a capture that wins material outright,
   * or takes a piece that has no defender.
   *
   * Piece values: P=1 N=3 B=3 R=5 Q=9
   */
  function hasHangingCapture (pos, moves) {
    const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    const captures = moves.filter(m => m.captured && m.captured !== 'k');

    for (const cap of captures) {
      const gained = VAL[cap.captured] ?? 0;
      const spent  = VAL[cap.piece]    ?? 0;

      // Pure material gain regardless of defenders
      if (gained > spent) return true;

      // Equal-value piece: only flag if undefended (no recapture exists)
      if (gained === spent) {
        const tmp = new Chess();
        tmp.load(engineFen);
        tmp.move({ from: cap.from, to: cap.to, promotion: 'q' });
        const defended = tmp.moves({ verbose: true }).some(m => m.to === cap.to);
        if (!defended) return true;
      }
    }
    return false;
  }

  // ── Indicator stubs ──────────────────────────────────────────
  // These will be replaced with full logic in later sessions.

  /**
   * Complexity stub:
   * Uses the spread between the top-3 MultiPV lines.
   * Small spread → many moves look equal → HIGH complexity.
   * Large spread → one move clearly best → LOW complexity.
   */
  function updateComplexityStub (lines, depth) {
    if (depth < 8) return;   // wait for meaningful depth

    const scores = [1, 2, 3]
      .map(i => lines[i]?.cp)
      .filter(v => v !== undefined);

    if (scores.length < 2) return;

    const spread = Math.abs(scores[0] - scores[scores.length - 1]);
    // Narrow spread (≤30 cp) = max complexity; wide spread (≥300 cp) = min
    const rawScore = Math.max(0, 1 - spread / 300);
    const pct      = Math.round(rawScore * 100);

    setIndicator('Complexity', pct,
      /* label */ `${pct}`,
      /* fill  */ pct,
      /* color */ '#7c6aff',
      /* desc  */
        spread < 50  ? 'Many candidate moves look equal' :
        spread < 150 ? 'A few viable options' :
                       'Engine has a clear preference'
    );
  }

  /**
   * Tension stub:
   * Counts captures + checks available from the current position.
   */
  function updateTensionStub (chessInstance) {
    const moves    = chessInstance.moves({ verbose: true });
    const captures = moves.filter(m => m.flags.includes('c') || m.flags.includes('e')).length;
    const checks   = moves.filter(m => m.san.includes('+')).length;
    const total    = captures + checks;
    const pct      = Math.min(100, Math.round((total / 15) * 100));

    setIndicator('Tension', total,
      `${total}`,
      pct,
      total > 8 ? '#ff5252' : total > 3 ? '#ffab40' : '#69f0ae',
      `${captures} capture${captures !== 1 ? 's' : ''}, ${checks} check${checks !== 1 ? 's' : ''} available`
    );
  }

  /**
   * Theory stub:
   * Counts moves since theoretical book lines are typically ≤ 15-20 moves.
   * Full implementation will compare against an opening book.
   */
  function updateTheoryStub (moveNumber) {
    // Naive: assume theory runs for ~15 moves; beyond that = out of book
    const BOOK_DEPTH = 15;
    const outBy      = Math.max(0, moveNumber - BOOK_DEPTH);
    const pct        = Math.min(100, Math.round((outBy / 30) * 100));

    setIndicator('Theory', outBy,
      outBy === 0 ? '—' : `+${outBy}`,
      pct,
      pct > 60 ? '#ff5252' : '#69f0ae',
      outBy === 0
        ? 'Likely still in known theory'
        : `~${outBy} move${outBy !== 1 ? 's' : ''} beyond typical book depth`
    );
  }

  // ── Scoresheet ───────────────────────────────────────────────

  /** Append one half-move to the scoresheet DOM and history. */
  function ssPushMove (fen, uci, san) {
    const idx = moveHistory.length;
    moveHistory.push({ fen, uci, san });

    if (idx % 2 === 0) {
      // White move — start a new row
      const rowNum = (idx >> 1) + 1;
      const row = document.createElement('div');
      row.className = 'ss-row';
      row.innerHTML =
        `<span class="ss-num">${rowNum}.</span>` +
        `<span class="ss-half" data-idx="${idx}">${san}</span>` +
        `<span class="ss-half" data-idx="${idx + 1}"></span>`;
      scoresheetEl.appendChild(row);
    } else {
      // Black move — fill placeholder in current row
      const cell = scoresheetEl.querySelector(`.ss-half[data-idx="${idx}"]`);
      if (cell) cell.textContent = san;
    }

    ssRefreshHighlights();
    // Auto-scroll to bottom only when live
    if (browseIdx === -1) scoresheetEl.scrollTop = scoresheetEl.scrollHeight;
  }

  /** Update active / live-marker classes on all move cells. */
  function ssRefreshHighlights () {
    scoresheetEl.querySelectorAll('.ss-half').forEach(el => {
      el.classList.remove('active', 'live-marker');
    });
    const liveEnd = moveHistory.length - 1;
    if (liveEnd < 0) return;

    if (browseIdx === -1) {
      // Live: highlight latest move
      const el = scoresheetEl.querySelector(`.ss-half[data-idx="${liveEnd}"]`);
      if (el) el.classList.add('active');
    } else {
      // Browsing: highlight browsed move, outline the live move
      const browsedEl = scoresheetEl.querySelector(`.ss-half[data-idx="${browseIdx}"]`);
      const liveEl    = scoresheetEl.querySelector(`.ss-half[data-idx="${liveEnd}"]`);
      if (browsedEl) browsedEl.classList.add('active');
      if (liveEl)    liveEl.classList.add('live-marker');
    }
  }

  /** Jump the board to a history entry; pass liveEnd index to go live. */
  function ssJumpTo (idx) {
    const liveEnd = moveHistory.length - 1;
    browseIdx = (idx >= liveEnd) ? -1 : idx;

    const entry = moveHistory[browseIdx === -1 ? liveEnd : browseIdx];
    if (!entry) return;

    board.setPosition(entry.fen, entry.uci, false);
    engineFen         = entry.fen;
    engineLastCapture = !!(entry.san && entry.san.includes('x'));
    engine.analyze(entry.fen);
    ssRefreshHighlights();

    const visIdx = browseIdx === -1 ? liveEnd : browseIdx;
    scoresheetEl.querySelector(`.ss-half[data-idx="${visIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  // Click handler (event delegation) — works for both modes
  scoresheetEl.addEventListener('click', (e) => {
    const cell = e.target.closest('.ss-half');
    if (!cell || !cell.textContent.trim()) return;
    const idx = parseInt(cell.dataset.idx, 10);
    if (isNaN(idx)) return;
    if (currentMode === 'review') {
      reviewGoTo(idx + 1);   // data-idx k → reviewPositions[k+1]
    } else {
      ssJumpTo(idx);
    }
  });

  // Arrow-key navigation (← →)
  document.addEventListener('keydown', (e) => {
    if (document.activeElement === gameUrlInput ||
        document.activeElement === reviewUrlInput) return;

    if (currentMode === 'review') {
      if (e.key === 'ArrowLeft')  { reviewGoTo(reviewIdx - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { reviewGoTo(reviewIdx + 1); e.preventDefault(); }
      return;
    }

    if (moveHistory.length === 0) return;
    const cur = browseIdx === -1 ? moveHistory.length - 1 : browseIdx;
    if (e.key === 'ArrowLeft') {
      if (cur > 0) ssJumpTo(cur - 1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      ssJumpTo(cur + 1);
      e.preventDefault();
    }
  });

  // ── Mode switching ────────────────────────────────────────────

  function switchMode (mode) {
    currentMode = mode;
    $('modeLiveBtn').classList.toggle('active', mode === 'live');
    $('modeReviewBtn').classList.toggle('active', mode === 'review');
    $('liveControls').style.display   = mode === 'live'   ? '' : 'none';
    $('reviewControls').style.display = mode === 'review' ? '' : 'none';
    $('replayBar').style.display      = mode === 'review' ? '' : 'none';

    if (mode === 'live') {
      reviewStopAutoPlay();
      reviewPositions = [];
      reviewIdx = 0;
      engine.stop();
      setStatus('Not connected', '');
    } else {
      stream.disconnect();
      engine.stop();
      clearIndicators();
      setStatus('Paste a finished Lichess game URL and click Load', '');
    }
  }

  $('modeLiveBtn').addEventListener('click',   () => switchMode('live'));
  $('modeReviewBtn').addEventListener('click', () => switchMode('review'));

  // ── Review: game loading ──────────────────────────────────────

  /** Detect broadcast URL; returns { roundId, gameId } or null. */
  function parseBroadcastUrl (input) {
    const m = input.trim().match(
      /lichess\.org\/broadcast\/[^/]+\/[^/]+\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/
    );
    return m ? { roundId: m[1], gameId: m[2] } : null;
  }

  /** Parse an 8-char Lichess game ID from a URL or bare ID. */
  function parseGameId (input) {
    const s = input.trim();
    const m = s.match(/(?:lichess\.org\/(?:game\/export\/)?)?([A-Za-z0-9]{8,12})(?:[/?]|$)/);
    return m ? m[1] : null;
  }

  async function reviewFetchAndLoad (urlOrId) {
    setStatus('Loading…', '');
    $('loadBtn').disabled = true;

    try {
      // ── Broadcast game ────────────────────────────────────────
      const broadcast = parseBroadcastUrl(urlOrId);
      if (broadcast) {
        const { roundId, gameId } = broadcast;
        const res = await fetch(
          `https://lichess.org/api/broadcast/round/${roundId}/games`,
          { headers: { Accept: 'application/x-ndjson' } }
        );
        if (!res.ok) {
          setStatus(res.status === 404 ? `Broadcast round not found` : `HTTP ${res.status}`, 'error');
          return;
        }
        // Read the full NDJSON response and find the matching game
        const text = await res.text();
        let pgn = null;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.id === gameId && data.pgn) { pgn = data.pgn; break; }
          } catch (e) { /* skip malformed */ }
        }
        if (!pgn) {
          setStatus(`Game "${gameId}" not found in broadcast round`, 'error');
          return;
        }
        reviewLoadPGN(pgn);
        return;
      }

      // ── Regular Lichess game ───────────────────────────────────
      const gameId = parseGameId(urlOrId);
      if (!gameId) {
        setStatus('Cannot parse game ID', 'error');
        return;
      }
      const res = await fetch(
        `https://lichess.org/game/export/${gameId}?moves=true&clocks=false&evals=false&opening=false`,
        { headers: { Accept: 'application/x-chess-pgn' } }
      );
      if (!res.ok) {
        setStatus(res.status === 404 ? `Game "${gameId}" not found` : `HTTP ${res.status}`, 'error');
        return;
      }
      const pgn = await res.text();
      reviewLoadPGN(pgn);

    } catch (err) {
      setStatus(`Network error: ${err.message}`, 'error');
    } finally {
      $('loadBtn').disabled = false;
    }
  }

  function reviewLoadPGN (pgn) {
    // Parse PGN with chess.js
    const tmp = new Chess();
    if (!tmp.load_pgn(pgn)) {
      setStatus('Could not parse PGN', 'error');
      return;
    }
    const history = tmp.history({ verbose: true });

    // Extract player names / ratings from PGN headers
    const wName  = (pgn.match(/\[White "([^"]+)"\]/)    ?? [])[1] ?? 'White';
    const bName  = (pgn.match(/\[Black "([^"]+)"\]/)    ?? [])[1] ?? 'Black';
    const wElo   = (pgn.match(/\[WhiteElo "([^"]+)"\]/) ?? [])[1];
    const bElo   = (pgn.match(/\[BlackElo "([^"]+)"\]/) ?? [])[1];

    // Build positions array: index 0 = start, index k = after move k
    const startFen = new Chess().fen();
    reviewPositions = [{ fen: startFen, uci: null, san: null }];
    const replay = new Chess();
    for (const mv of history) {
      const applied = replay.move(mv.san);
      if (!applied) break;
      reviewPositions.push({
        fen: replay.fen(),
        uci: mv.from + mv.to + (mv.promotion ?? ''),
        san: mv.san,
      });
    }

    const total = reviewPositions.length - 1;
    if (total === 0) { setStatus('No moves found in PGN', 'error'); return; }

    // Reset UI
    clearIndicators();
    $('playerWhite').textContent = wName + (wElo ? ` (${wElo})` : '');
    $('playerBlack').textContent = bName + (bElo ? ` (${bElo})` : '');

    // Pre-populate scoresheet (without using ssPushMove to avoid auto-scroll)
    for (let i = 1; i <= total; i++) {
      const p      = reviewPositions[i];
      const dataIdx = i - 1;
      moveHistory.push({ fen: p.fen, uci: p.uci, san: p.san });
      if (dataIdx % 2 === 0) {
        const row = document.createElement('div');
        row.className = 'ss-row';
        row.innerHTML =
          `<span class="ss-num">${(dataIdx >> 1) + 1}.</span>` +
          `<span class="ss-half" data-idx="${dataIdx}">${p.san}</span>` +
          `<span class="ss-half" data-idx="${dataIdx + 1}"></span>`;
        scoresheetEl.appendChild(row);
      } else {
        const cell = scoresheetEl.querySelector(`.ss-half[data-idx="${dataIdx}"]`);
        if (cell) cell.textContent = p.san;
      }
    }

    reviewIdx = 0;
    reviewGoTo(0);
    setStatus(`${total} moves — use ← → or click to navigate`, 'connected');
  }

  $('loadBtn').addEventListener('click', () => {
    reviewFetchAndLoad(reviewUrlInput.value.trim());
  });
  reviewUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loadBtn').click();
  });

  // ── Review: navigation ────────────────────────────────────────

  function reviewGoTo (idx) {
    reviewIdx = Math.max(0, Math.min(idx, reviewPositions.length - 1));
    const entry = reviewPositions[reviewIdx];
    const total = reviewPositions.length - 1;

    // Board & engine
    board.setPosition(entry.fen, entry.uci, false);
    engineFen         = entry.fen;
    engineLastCapture = !!(entry.san && entry.san.includes('x'));
    engine.analyze(entry.fen);

    // Sync chess instance for indicators
    chess.load(entry.fen);
    updateTensionStub(chess);
    updateTheoryStub(reviewIdx);

    // Move ticker
    if (reviewIdx === 0) {
      $('moveTicker').textContent = 'Starting position';
    } else {
      const fen      = entry.fen;
      const turn     = fen.split(' ')[1];              // whose turn AFTER this position
      const fullMove = Math.ceil(reviewIdx / 2);
      const dot      = turn === 'b' ? '.' : '…';      // '.' = white moved, '…' = black moved
      $('moveTicker').textContent =
        `${fullMove}${dot} ${entry.san}  ·  ${turn === 'b' ? 'White' : 'Black'} played`;
    }

    // Move counter
    $('moveCounter').textContent = `${reviewIdx} / ${total}`;

    // Prev/next buttons
    $('prevMoveBtn').disabled = reviewIdx === 0;
    $('nextMoveBtn').disabled = reviewIdx === total;

    // Stop auto-play if we reached the end
    if (reviewIdx === total && reviewAutoPlay) reviewStopAutoPlay();

    // Scoresheet highlight
    scoresheetEl.querySelectorAll('.ss-half').forEach(el => el.classList.remove('active', 'live-marker'));
    if (reviewIdx > 0) {
      const cell = scoresheetEl.querySelector(`.ss-half[data-idx="${reviewIdx - 1}"]`);
      if (cell) { cell.classList.add('active'); cell.scrollIntoView({ block: 'nearest' }); }
    }
  }

  // ── Review: auto-play ─────────────────────────────────────────

  function reviewStartAutoPlay () {
    const delay = (11 - parseInt($('speedSlider').value, 10)) * 500;
    reviewAutoPlay = setInterval(() => reviewGoTo(reviewIdx + 1), delay);
    $('playPauseBtn').textContent = '⏸';
  }

  function reviewStopAutoPlay () {
    if (reviewAutoPlay) { clearInterval(reviewAutoPlay); reviewAutoPlay = null; }
    $('playPauseBtn').textContent = '▶';
  }

  $('prevMoveBtn').addEventListener('click',   () => reviewGoTo(reviewIdx - 1));
  $('nextMoveBtn').addEventListener('click',   () => reviewGoTo(reviewIdx + 1));
  $('playPauseBtn').addEventListener('click',  () => {
    if (reviewAutoPlay) { reviewStopAutoPlay(); }
    else {
      if (reviewIdx >= reviewPositions.length - 1) reviewGoTo(0);  // restart from beginning
      reviewStartAutoPlay();
    }
  });

  // Restart interval when speed changes during auto-play
  $('speedSlider').addEventListener('input', () => {
    if (reviewAutoPlay) { reviewStopAutoPlay(); reviewStartAutoPlay(); }
  });

  // ── Indicator helper ─────────────────────────────────────────

  function setIndicator (name, rawValue, label, fillPct, color, desc) {
    const key = name === 'Complexity' ? 'Complexity'
              : name === 'Tension'    ? 'Tension'
              :                        'Theory';

    const idMap = {
      Complexity: { val: 'valComplexity', fill: 'fillComplexity', desc: 'descComplexity', card: 'cardComplexity' },
      Tension:    { val: 'valTension',    fill: 'fillTension',    desc: 'descTension',    card: 'cardTension'    },
      Theory:     { val: 'valTheory',     fill: 'fillTheory',     desc: 'descTheory',     card: 'cardTheory'     },
    };

    const ids = idMap[key];
    if (!ids) return;

    $(ids.val).textContent  = label;
    $(ids.desc).textContent = desc;
    $(ids.card).classList.add('active');

    const fillEl = $(ids.fill);
    fillEl.style.width           = Math.max(0, Math.min(100, fillPct)) + '%';
    fillEl.style.backgroundColor = color;
  }

  function clearIndicators () {
    scoresheetEl.innerHTML = '';
    moveHistory.splice(0);
    browseIdx = -1;
    for (const id of ['valComplexity','valTension','valTheory']) $(id).textContent = '—';
    for (const id of ['descComplexity','descTension','descTheory']) $(id).textContent = 'Awaiting…';
    for (const id of ['fillComplexity','fillTension','fillTheory']) {
      $(id).style.width = '0%';
    }
    for (const id of ['cardComplexity','cardTension','cardTheory']) {
      $(id).classList.remove('active');
    }
    for (const id of ['engEval','engDepth','engBest']) $(id).textContent = '—';
    $('engStatus').textContent = 'Stockfish 10 ready';
    $('moveTicker').textContent = '—';
    $('playerWhite').textContent = 'White';
    $('playerBlack').textContent = 'Black';

    // Reset eval bar to 50/50
    updateEvalBar(0, null);
  }

  function setStatus (msg, cls) {
    statusEl.textContent = msg;
    statusEl.className   = 'status ' + (cls ?? '');
  }

  // ── Initial state ────────────────────────────────────────────
  updateEvalBar(0, null);

});
