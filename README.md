# Chess Dashboard

**A live chess broadcast tool focused on human difficulty, not just engine evaluation**  
**Un outil de diffusion d'échecs centré sur la difficulté humaine, pas seulement l'évaluation du moteur**

> *The engine tells you who's winning. The dashboard tells you how hard it is to be human in that position.*  
> *Le moteur vous dit qui gagne. Le tableau de bord vous dit à quel point la position est difficile à jouer pour un humain.*

---

## EN — What it does

Chess Dashboard connects to the [Lichess](https://lichess.org) public API to stream live games in real time. Beyond the standard engine evaluation, it displays metrics designed to reflect the **human experience** of a position:

- **Complexity score** — how many viable candidate moves exist, and how close they are in evaluation
- **Position tension** — captures available, checks available (proxy for tactical sharpness)
- **Distance from theory** — how many moves since leaving known opening lines
- **Eval bar** — colour-coded green/red based on human difficulty, not just who's ahead

Built with: [Lichess API](https://lichess.org/api) · [Stockfish.js](https://github.com/lichess-org/stockfish.js) · [chess.js](https://github.com/jhlywa/chess.js) · [chessboard.js](https://chessboardjs.com) · vanilla HTML/CSS/JS

⚠️ *Work in progress — alive and kicking.*

---

## FR — Fonctionnalités

Chess Dashboard se connecte à l'API publique de [Lichess](https://lichess.org) pour diffuser des parties en temps réel. Au-delà de l'évaluation moteur standard, il affiche des indicateurs conçus pour refléter l'**expérience humaine** d'une position :

- **Score de complexité** — nombre de coups candidats viables et écart d'évaluation entre eux
- **Tension de la position** — captures et échecs disponibles (indicateur de la vivacité tactique)
- **Distance par rapport à la théorie** — nombre de coups depuis la sortie des lignes connues
- **Barre d'évaluation** — colorée en vert/rouge selon la difficulté humaine, pas seulement l'avantage au tableau

Développé avec : [Lichess API](https://lichess.org/api) · [Stockfish.js](https://github.com/lichess-org/stockfish.js) · [chess.js](https://github.com/jhlywa/chess.js) · [chessboard.js](https://chessboardjs.com) · HTML/CSS/JS vanilla

⚠️ *Projet en cours de développement.*

---

## About · À propos

**François-Xavier Priour** — chess player, translator of 40+ chess books (Éditions Olibris), author of [Chess Multitudes](https://chessmultitudes.substack.com) (English-language chess newsletter). Non-developer learning to build tools that don't exist yet.

[github.com/FxPriour](https://github.com/FxPriour) · [linkedin.com/in/fxpriour](https://linkedin.com/in/fxpriour)
