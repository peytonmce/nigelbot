# Nigel — a scrabblebot that plays the table

Modeled on how Nigel Richards plays: total recall of what's been played, a
calm sense of what his rack needs, quick unfussy decisions. No draw odds and no
forecasting — every decision comes from what has actually happened in the game.

## What it watches (src/reads.ts)
- Every sale: who won which letter, what it cost. In Vickrey the price is the
  runner-up's bid, so it shows what rivals are willing to pay; in first-price
  it's the winner's own bid.
- Every word played, so it knows exactly how many tiles each rival holds and
  which of them it knows about.
- Each rival's cash and score, live.
- Tile tracking: which tiles have turned up (e.g. a Q is worthless once every U has been seen).
- Long-term notes on each opponent (how much they overpay, how many tiles
  they win, how long their words are), saved to `.reads-<BOT_NAME>.json`
  and carried into the next match.

## How it bids (decideBid)
- Values a tile by what it does for *this* rack: completes a word now, or
  builds toward a 7+ letter word (3x), with rack balance (about 40% vowels),
  duplicate penalties, and Q/U sense.
- Spends in step with the game: leftover cash is worth nothing, so the more
  money per remaining round, the freer it bids.
- Reacts to the room:
  - Snaps up letters nobody is chasing.
  - Drops out of bidding wars over tiles it only half-wants.
  - Pays up for tiles that finish a big word.
  - Raises its bids after losing several tiles it wanted in a row.
  - Vickrey: bids its true value, and drives up the price for the leader
    when the leader is hoarding a big rack and buying that kind of tile.
  - First-price: bids just over what the rivals have actually been paying,
    and never more than the richest rival can afford.
- Never bids on the last tile (the match ends before it can be played).

## How it plays words (chooseWord)
- Bingo (7+ letters): plays it right away, choosing the word that keeps the best leftover tiles.
- Holds shorter words while building, unless it needs cash to keep up with
  current prices, the rack is clogged (12+ tiles), or the game is ending.
- Last 3 rounds: cashes everything out, since tiles left at the end are worth nothing.

## Run
    npm install && npm run generate
    BOT_NAME=nigel BOT_TOKEN=<token from /team> npm start
    npm test                      # unit tests
    npm run sim -- 30 Vickrey     # offline matches vs starter + server-style sims
    TABLE=nigel,hoarder,hoarder npm run sim -- 30 FirstPrice
