// "Nigel" — a bot that plays the table, not the odds.
//
// Nigel Richards doesn't win by calculating. He wins with total recall of
// what's been played, a calm sense of what his rack needs, and fast,
// unfussy decisions. Translated to this auction game:
//
//  * Track the tiles. Every auctioned tile and every word is noted, and so is
//    each rival's rack size, cash, and what they keep buying (reads.ts).
//  * Know what your rack wants. Bid for tiles that balance it (vowels when
//    you're consonant-heavy, S and E always), not for raw face value.
//  * Let the room set the price. Watch what each letter actually sells for
//    this game and how each rival pays. Don't get into bidding wars over
//    tiles you only half-want; pay up for the ones that finish a big word;
//    snap up what nobody else is chasing.
//  * Respond to people. Someone hoarding a big rack and buying vowels? Make
//    them pay for their vowels. Keep losing the tiles you want? Raise your
//    bids. Rivals out of money? Bid low, they can't hit back.
//  * Take the bingo. 7+ letters is the 3x ceiling, so play it the moment you
//    have it and keep a balanced leave. Cash out shorter words only when the
//    market says you need money, the rack is clogged, or the game is ending.

import type { MatchRead } from "./reads.js";
import { classOf, isVowel } from "./reads.js";
import {
  LETTER_VALUE,
  buildIndex,
  candidates,
  cashOutValue,
  rackSize,
  withLetter,
  without,
  wordReward,
  type Rack,
} from "./words.js";

export { LETTER_VALUE };

// ---------- Tuning ----------
// The knobs, in one place. `npm run sim` can override them (SIMPARAMS) to
// test changes offline before a real match sees them.
export const P = {
  priceDiv: 4, // points a tile is worth in a long word: room price / this = coins per point
  keepCash: 0.4, // max share of balance on one tile, unless it finishes a big word
  // Shortest word worth playing just to raise cash. Effectively off: on the
  // real server, cashing short words for coins emptied the rack and lost.
  cashMinLen: 99,
  lateRounds: 10, // from here, cash 5+ letter words
  bingoLen: 7,
  // From this many rounds left, the per-tile spending cap rises to 100% by
  // the end: leftover coins are worth nothing.
  spendDownFrom: 15,
  cheapBoost: 1, // 1 = in a cheap market, bid going rate + 2 to make sure we get it; 0 = off
  // Pacing: never bid more than (balance / rounds left) * this. Saves money
  // for later, when rivals run dry and tiles get cheap. Tuned against bots
  // modeled on the real leaders: ~20% -> ~45% wins.
  paceEarly: 8,
  // Hunger: with fewer than this many tiles and money to spend, bid just
  // over the going rate for any tile that fits. Fixes sitting on 100+ coins
  // with an empty rack after an early bingo (seen in real matches).
  hungerRack: 7,
  // Edge: extra coins on tiles we want (fit >= 0.8). Real matches showed
  // Nigel as runner-up in ~13 auctions a match, often by 0-2 coins.
  edge: 5,
  edgeOnePoint: 0,
  // Bingo quality: before `bingoPatientUntil` rounds left, only play a 7+
  // word worth at least `bingoMinPts`, unless the rack has `bingoFullRack`+
  // tiles. Winners' bingos average ~47 points; Nigel's were ~37.
  bingoMinPts: 50,
  bingoPatientUntil: 15,
  bingoFullRack: 11,
  // Reload: with this many rounds left or fewer, spend what's left on any
  // letter that fits, to build a second word instead of ending with coins.
  reloadFrom: 0,
  heavyBoost: 1.3, // extra value multiplier for 4+ point letters (they triple in a bingo)
  lastSpend: 0, // in the last this-many rounds, spread leftover cash over tiles that add points right now
  // Cap on 1-point tiles, as a multiple of the room's price level. At 0.85
  // it lost most 1-point tiles to the real field, which holds prices up all
  // match; at the going rate it wins its share.
  onePointCap: 1.0,
  onePointStep: 0, // raise that cap by this much per tile we wanted and lost in a row
  onePointCapMax: 1.1,
};

// ---------- Rack sense ----------

// How much a tile tends to help a rack, before looking at what's on it.
// The "RETAINS" letters and S make long words; U, V, W rarely do.
const FRIENDLY: Record<string, number> = {
  S: 1.35, E: 1.25, R: 1.15, T: 1.1, A: 1.1, I: 1.05, N: 1.1, L: 1.05,
  O: 1.0, D: 1.0, G: 0.9, C: 0.95, M: 0.95, P: 0.95, B: 0.85, H: 0.9,
  Y: 0.85, F: 0.8, K: 0.75, U: 0.75, V: 0.6, W: 0.65, X: 0.9, Z: 0.8,
  J: 0.6, Q: 0.5,
};

function vowelCount(rack: Rack): number {
  let v = 0;
  for (const [c, n] of rack) if (isVowel(c)) v += n;
  return v;
}

/** How well `letter` fits the rack: 0 = useless, ~1 = fine, >1 = wanted. */
export function tileFit(letter: string, rack: Rack, read?: MatchRead): number {
  const n = rackSize(rack);
  let fit = FRIENDLY[letter] ?? 0.8;

  // Rack balance: aim for about 40% vowels.
  const ratio = n === 0 ? 0.4 : vowelCount(rack) / n;
  if (isVowel(letter)) {
    if (ratio < 0.25) fit *= 1.5;
    else if (ratio < 0.35) fit *= 1.2;
    else if (ratio > 0.6) fit *= 0.2;
    else if (ratio > 0.5) fit *= 0.5;
  } else {
    if (ratio > 0.55) fit *= 1.35;
    else if (ratio < 0.2) fit *= 0.5;
    else if (ratio < 0.3) fit *= 0.8;
  }

  // Duplicates clog a rack (E, S, A, I tolerate a second copy).
  const have = rack.get(letter) ?? 0;
  const easy = "ESAIO".includes(letter);
  if (have >= 3) fit *= 0.2;
  else if (have === 2) fit *= easy ? 0.6 : 0.3;
  else if (have === 1) fit *= easy ? 0.95 : 0.7;

  // Q needs a U. Count: one in hand, or ones that haven't turned up yet.
  if (letter === "Q") {
    if ((rack.get("U") ?? 0) > 0) fit = 1.0;
    else if (read && read.unseen("U") === 0) fit = 0;
    else fit = 0.25;
  }
  if (letter === "U" && (rack.get("Q") ?? 0) > 0 && (rack.get("U") ?? 0) === 0) {
    fit = 2.0;
  }
  return fit;
}

/** How good the leftover tiles are to keep building on, roughly -6..+4. */
export function leaveScore(rest: Rack): number {
  const n = rackSize(rest);
  if (n === 0) return 0;
  let s = 0;
  for (const [c, k] of rest) s += ((FRIENDLY[c] ?? 0.8) - 0.95) * 2 * k;
  const ratio = vowelCount(rest) / n;
  s -= Math.abs(ratio - 0.4) * Math.min(n, 7) * 1.2;
  for (const [c, k] of rest) if (k >= 2 && !"ES".includes(c)) s -= (k - 1) * 1.2;
  if ((rest.get("Q") ?? 0) > 0 && (rest.get("U") ?? 0) === 0) s -= 3;
  return s;
}

// ---------- Bidding ----------

export interface BidContext {
  letter: string; // Letter being auctioned, e.g. "Q"
  myBalance: number; // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
  dictionary?: string[];
  read?: MatchRead; // What we've seen this match. Without it, bid on rack sense alone.
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface BidReasoning {
  bid: number;
  value: number;
  why: string;
}

export function decideBid(ctx: BidContext): number {
  return explainBid(ctx).bid;
}

export function explainBid(ctx: BidContext): BidReasoning {
  const { letter, myRack: rack, read } = ctx;
  const balance = Math.max(0, ctx.myBalance);
  const face = LETTER_VALUE[letter] ?? 1;
  const roundsLeft = read?.roundsLeft ?? 40;
  const n = rackSize(rack);

  // The final tile lands in your rack as the match ends: nothing can be
  // played with it.
  if (read && roundsLeft <= 1) return { bid: 0, value: 0, why: "last tile, unplayable" };

  // What does the tile do for me right now, and what will it do for a long word?
  let gainNow = 0;
  if (ctx.dictionary && ctx.dictionary.length) {
    const idx = buildIndex(ctx.dictionary);
    gainNow = Math.max(0, cashOutValue(idx, withLetter(rack, letter)) - cashOutValue(idx, rack));
  }
  const fit = tileFit(letter, rack, read);
  // Time left to build: none in the last couple of rounds.
  const horizon = clamp((roundsLeft - 2) / 18, 0, 1);
  const towardBingo = 1 + 2 * Math.min(1, (n + 1) / 8); // grows to 3x as the rack fills
  const gainBuild = (face * towardBingo * (face >= 4 ? P.heavyBoost : 1) + 1.5) * fit * horizon;
  const value = Math.max(gainNow, gainBuild) + 0.25 * Math.min(gainNow, gainBuild);
  if (value < 0.5) return { bid: 0, value, why: "doesn't fit" };

  // Money only matters for buying tiles, and leftover cash is worth nothing.
  // Spend in step with what's left: the richer we are per remaining round,
  // the more freely we bid.
  const rackCash = ctx.dictionary ? 0.6 * cashOutValue(buildIndex(ctx.dictionary), rack) : 0;
  const perRound = (balance + rackCash) / Math.max(1, roundsLeft);
  let cashFactor = clamp(0.8 + perRound / 4, 0.8, 2.5);

  // Let the room set the exchange rate. A tile that ends up in a long word
  // is worth about 4 points; if rivals are paying 12 coins a tile, coins are
  // cheap here and we bid in the room's currency.
  const level = read ? read.priceLevel() : NaN;
  if (!Number.isNaN(level)) cashFactor = Math.max(cashFactor, clamp(level / P.priceDiv, 1, 5));

  // Keep losing tiles we went for? Pay more, like a player who's noticed
  // they're being outbid.
  if (read) cashFactor *= 1 + 0.15 * Math.min(4, read.wantedLossStreak);
  let worth = value * cashFactor;
  const must = gainNow >= 8; // finishes something big right now
  if (must) worth = Math.max(worth, gainNow * 0.9);
  // Last few rounds: coins left at the bell are worth nothing, so any tile
  // that adds points to a word we can play now gets a share of what's left.
  if (P.lastSpend > 0 && roundsLeft <= P.lastSpend && gainNow >= 1) {
    worth = Math.max(worth, balance / Math.max(1, roundsLeft - 2));
  }

  if (!read) {
    const bid = Math.min(balance, Math.round(worth));
    return { bid, value, why: "rack sense only" };
  }

  const rate = read.goingRate(letter);
  const known = !Number.isNaN(rate);
  const richest = read.richestRivalBalance();
  let bid: number;
  let why: string;

  if (read.auction === "Vickrey") {
    // Truthful by default: we pay the runner-up's price, not ours.
    bid = worth;
    why = "my value";
    // Nobody's chasing this letter and it fits: make sure we get it.
    if (P.cheapBoost && known && rate < worth * 0.6 && fit >= 0.9) {
      bid = Math.max(bid, rate + 2);
      why = "cheap market, fits";
    }
    // Hungry: short rack, cash to spend, tile fits. Pay the going rate.
    // "Rich" = more cash than the pace we'd need to keep buying at this rate.
    const rich = balance > Math.max(40, rate * 5);
    const hungry = P.hungerRack > 0 && n < P.hungerRack && fit >= 0.7 && horizon > 0.3 && rich;
    if (hungry && known && bid < rate + 1) {
      bid = rate + 1 + 0.3 * (P.hungerRack - n);
      why = `hungry (rack ${n}), paying the going rate`;
    }
    // Contested and we only half-want it: stay out of the fight.
    if (!hungry && known && !must && rate > worth * 1.6 && fit < 1.0) {
      bid = Math.min(bid, worth * 0.8);
      why = "they want it more, let it go";
    }
    // Make the leader pay: someone sitting on a big rack, buying this kind of
    // tile, gets a higher price, as long as we'd be fine owning it.
    const threat = read.biggestThreat();
    if (
      threat &&
      read.round > 15 &&
      read.isHoarding(threat) &&
      read.threat(threat) > read.myThreat(n) &&
      threat.classBuys[classOf(letter)] >= 3 &&
      threat.balance > 10 &&
      known &&
      worth >= rate * 0.5
    ) {
      const push = Math.min(rate + 1, balance * 0.15, threat.balance);
      if (push > bid) {
        bid = push;
        why = `price-push bot ${threat.botId}`;
      }
    }
  } else {
    // First-price: we pay what we bid, so bid just over what the room will.
    const top = read.expectedTopRivalBid(letter);
    if (!known && top <= 0) {
      bid = worth * 0.7;
      why = "no read yet, shaded";
    } else if (top + 1 <= worth) {
      bid = top + 1;
      why = `just over the room (${top.toFixed(1)})`;
    } else {
      // They'll outbid our value. Put in a low bid in case they pass.
      bid = must ? worth : worth * 0.6;
      why = must ? "need it, full value" : "outpriced, low punt";
    }
    // No one can pay more than they have.
    bid = Math.min(bid, richest + 1);
  }

  // Broke rivals can't hit back. Never pay over what we're worth to ourselves
  // by more than a push, never more than we have.
  // One-point tiles are what everyone overpays for: don't join in.
  // The cap loosens each time we lose a tile we wanted: against patient
  // rivals who hold the price up, it climbs to the going rate.
  if (face === 1 && !must && !Number.isNaN(level)) {
    const streak = read ? read.wantedLossStreak : 0;
    const cap = Math.min(P.onePointCapMax, P.onePointCap + P.onePointStep * streak);
    bid = Math.min(bid, level * cap);
  }
  // Edge, on top of the caps above (they cut it off when it came first).
  // Vickrey only: we pay the runner-up's price, so the edge just turns
  // near-misses into wins. In first-price it would be pure overpayment.
  // One-point letters get just enough to break round-number ties: the
  // full edge there overpays for E's.
  if (read.auction === "Vickrey" && fit >= 0.8 && bid >= 3) bid += face === 1 ? P.edgeOnePoint : P.edge;
  // Keep enough cash to stay in the game, unless the tile finishes a big
  // word or there's little time left to spend it.
  let capShare = P.keepCash;
  if (P.spendDownFrom > 0 && roundsLeft < P.spendDownFrom) {
    const t = clamp((P.spendDownFrom - roundsLeft) / Math.max(1, P.spendDownFrom - 3), 0, 1);
    capShare = P.keepCash + (1 - P.keepCash) * t;
  }
  if (!must && roundsLeft > 8) bid = Math.min(bid, balance * capShare);
  const reloading = P.reloadFrom > 0 && roundsLeft <= P.reloadFrom && roundsLeft > 2 && fit >= 0.7;
  if (reloading) {
    // Spread the remaining coins over about half the rounds left.
    const share = balance / Math.max(2, (roundsLeft - 2) * 0.5);
    if (share > bid) {
      bid = Math.min(balance, share);
      why = `reload: spending down for a second word`;
    }
  } else if (P.paceEarly > 0 && !must) bid = Math.min(bid, Math.max(face + 1, (balance / Math.max(1, roundsLeft)) * P.paceEarly));
  bid = Math.max(0, Math.min(balance, Math.round(bid)));
  if (bid === 0 && value >= 1 && balance > 0) bid = 1;
  return { bid, value, why };
}

// ---------- Playing words ----------

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Sorted uppercase list, shared at startup
  myBalance?: number;
  read?: MatchRead;
}

export const ENDGAME_ROUNDS = 3;

/**
 * Pick a word to play now, or null to keep building.
 *
 * Keep this fast. The bot runs it on every rack change and every new auction.
 */
export function chooseWord(ctx: WordContext): string | null {
  return explainWord(ctx).word;
}

export function explainWord(ctx: WordContext): { word: string | null; why: string } {
  const idx = buildIndex(ctx.dictionary);
  const rack = ctx.myRack;
  const n = rackSize(rack);
  const read = ctx.read;
  const roundsLeft = read?.roundsLeft ?? 40;
  const balance = ctx.myBalance ?? read?.myBalance ?? 100;

  const cands = candidates(idx, rack, 80);
  if (cands.length === 0) return { word: null, why: "nothing playable" };

  // Score a play as the points now plus what the leftover is worth to us.
  const byLeave = (pool: string[], leaveWeight: number) => {
    let best = pool[0];
    let bestScore = -Infinity;
    for (const w of pool) {
      const s = wordReward(w) + leaveWeight * leaveScore(without(rack, w));
      if (s > bestScore) {
        bestScore = s;
        best = w;
      }
    }
    return best;
  };

  // Endgame: anything left at the bell is worthless. Cash out, choosing the
  // word that leaves the best follow-up play.
  if (roundsLeft <= ENDGAME_ROUNDS) {
    let best = cands[0];
    let bestTotal = -1;
    for (const w of cands.slice(0, 20)) {
      const total = wordReward(w) + cashOutValue(idx, without(rack, w), 2);
      if (total > bestTotal) {
        bestTotal = total;
        best = w;
      }
    }
    return { word: best, why: "endgame cash-out" };
  }

  // A bingo (7+ letters, the 3x ceiling): take it.
  const bingos = cands.filter((w) => w.length >= P.bingoLen);
  if (bingos.length) {
    const best = byLeave(bingos, 0.6);
    const patient = P.bingoMinPts > 0 && roundsLeft > P.bingoPatientUntil && n < P.bingoFullRack;
    if (!patient || wordReward(best) >= P.bingoMinPts) return { word: best, why: "bingo" };
  }

  // Late game with no time left to build a 7: take the 6s and 5s.
  if (roundsLeft <= P.lateRounds) {
    const longish = cands.filter((w) => w.length >= (roundsLeft <= 6 ? 4 : 5));
    if (longish.length) return { word: byLeave(longish, 0.4), why: "late, cashing long word" };
  }

  // Do we need cash to keep up with what the room is paying?
  const need = read ? cashNeed(read) : 6;
  if (balance < need) {
    const pool = cands.filter((w) => w.length >= P.cashMinLen);
    if (pool.length) return { word: byLeave(pool, 0.8), why: `need cash (${balance} < ${need.toFixed(0)})` };
  }

  // A clogged rack with no bingo in it: clear the junk with a solid word.
  if (n >= 12) {
    const solid = cands.filter((w) => w.length >= 5);
    if (solid.length) return { word: byLeave(solid, 1.0), why: "rack clogged" };
  }

  return { word: null, why: "building" };
}

/** Cash we want on hand: enough to win a few tiles at the going rate. */
function cashNeed(read: MatchRead): number {
  const all = [
    ...read.classPrices.vowel.slice(-5),
    ...read.classPrices.consonant.slice(-5),
  ];
  const typical = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 2.5;
  // Rivals with money push prices up; broke rivals mean we need less.
  const live = read.liveRivals().filter((r) => r.balance >= typical * 2).length;
  const tiles = live >= 3 ? 4 : live >= 1 ? 3 : 2;
  return Math.max(5, typical * tiles);
}
