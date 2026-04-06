/**
 * board.js — chessboard.js wrapper
 *
 * Public API
 * ──────────
 *   board.init()
 *   board.setPosition(fen, lastMoveUci, animate = true)
 *   board.reset()
 *   board.flip()
 *   board.orientation()    → 'white' | 'black'
 */

/* globals Chessboard, $ */

class ChessBoard {
  constructor (elementId) {
    this.elementId   = elementId;
    this.instance    = null;
    this._orientation = 'white';
    this._lastHighlights = [];
  }

  // ─── Public ──────────────────────────────────────────────────

  init () {
    this.instance = Chessboard(this.elementId, {
      position:   'start',
      orientation: this._orientation,
      pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
      // Disable dragging — display only for now
      draggable:  false,
    });

    // Make board responsive when window resizes
    window.addEventListener('resize', () => this.instance.resize());
  }

  /**
   * Move the board to a new FEN position.
   * @param {string}  fen          - FEN string
   * @param {string}  lastMoveUci  - UCI move that produced this position (e.g. "e2e4")
   * @param {boolean} animate      - whether to animate the piece
   */
  setPosition (fen, lastMoveUci, animate = true) {
    this._clearHighlights();

    this.instance.position(fen, animate);

    if (lastMoveUci && lastMoveUci.length >= 4) {
      const from = lastMoveUci.slice(0, 2);
      const to   = lastMoveUci.slice(2, 4);
      this._highlightSquare(from, 'highlight-from');
      this._highlightSquare(to,   'highlight-to');
      this._lastHighlights = [from, to];
    }
  }

  reset () {
    this._clearHighlights();
    this.instance.start(false);
  }

  flip () {
    this._orientation = this._orientation === 'white' ? 'black' : 'white';
    this.instance.flip();
  }

  orientation () { return this._orientation; }

  // ─── Internal ────────────────────────────────────────────────

  _highlightSquare (sq, cls) {
    // chessboard.js squares: class="square-55d63" data-square="e4"
    $(`#${this.elementId} [data-square="${sq}"]`).addClass(cls);
  }

  _clearHighlights () {
    for (const sq of this._lastHighlights) {
      $(`#${this.elementId} [data-square="${sq}"]`)
        .removeClass('highlight-from highlight-to');
    }
    this._lastHighlights = [];
  }
}
