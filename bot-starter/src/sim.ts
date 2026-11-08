// Offline match simulator: same rules as the server module (98-tile bag,
// 5-tile dealt racks, sealed-bid auctions, length multipliers, sims that bid
// face value +/- jitter and play their longest 3+ word after every win).
//
//   npx tsx src/sim.ts [matches] [Vickrey|FirstPrice]
//
// Seats: Nigel, the starter-kit strategy, and four server-style sims.

import * as fs from "node:fs";
import * as path from "node:path";
import { TableReader, FULL_BAG, type AuctionKind } from "./reads.js";
import { P, explainBid, explainWord, tileFit } from "./strategy.js";
if (process.env.SIMPARAMS) Object.assign(P, JSON.parse(process.env.SIMPARAMS));
import {
  LETTER_VALUE,
  bestWord,
  buildIndex,
  rackSize,
  without,
  wordReward,
  type Rack,
} from "./words.js";

const dict = fs
  .readFileSync(path.join(import.meta.dirname, "..", "..", "spacetimedb", "wordlist.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2);
dict.sort((a, b) => b.length - a.length);
const idx = buildIndex(dict);

let seed = Number(process.env.SEED ?? 12345);
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

type Kind = "nigel" | "starter" | "hoarder" | "pricey" | "pricey6" | "field" | "Cheapskate" | "ValueBidder" | "Aggressive";
interface Seat {
  id: string;
  kind: Kind;
  balance: number;
  score: number;
  rack: Rack;
  read?: ReturnType<TableReader["openMatch"]>;
  tiles?: number;
  early?: number;
  late?: number;
  spent?: number;
  reader?: TableReader;
}

// A sensible bot another team might write: overpays to hoard, plays only
// 7+ letter words, dumps everything at the end.
// Like the bots on the real server: pay 9-15 a tile, cash words often.
function priceyBid(letter: string, balance: number, roundsLeft: number): number {
  if (roundsLeft <= 1) return 0;
  const v = LETTER_VALUE[letter];
  return Math.max(0, Math.min(balance, 2 * v + 8 + randInt(-3, 3)));
}

// Modeled on the real leaders (Lbender, Lucy, Odysseus, QuertyBot): their
// median prices by letter value, holding for 7+ letter words, spending
// down as money runs out.
const FIELD_K = Number(process.env.FIELD_K ?? 1);
const FIELD_NOISE = Number(process.env.FIELD_NOISE ?? 3);
const FIELD_PACE = Number(process.env.FIELD_PACE ?? 0);
const FIELD_FITLO = Number(process.env.FIELD_FITLO ?? 0.4);
const FIELD_FITHI = Number(process.env.FIELD_FITHI ?? 1.5);
const FIELD_PRICE: Record<number, number> = { 1: 11, 2: 12, 3: 16, 4: 19, 5: 21, 8: 26, 10: 27 };
function fieldBid(letter: string, balance: number, roundsLeft: number, rack: Rack): number {
  if (roundsLeft <= 1) return 0;
  const base = FIELD_PRICE[LETTER_VALUE[letter]] ?? 12;
  const fit = Math.max(FIELD_FITLO, Math.min(FIELD_FITHI, tileFit(letter, rack)));
  const want = Math.round(base * fit * FIELD_K) + randInt(-FIELD_NOISE, FIELD_NOISE);
  const paced = FIELD_PACE > 0 ? Math.floor((balance / Math.max(1, roundsLeft)) * FIELD_PACE) : want;
  return Math.max(0, Math.min(want, paced, Math.floor(balance * 0.6)));
}

function hoarderBid(letter: string, balance: number, roundsLeft: number): number {
  if (roundsLeft <= 1) return 0;
  const v = LETTER_VALUE[letter];
  const want = 2 * v + ("AEIOUS".includes(letter) ? 3 : 1);
  return Math.max(0, Math.min(want, Math.floor(balance / 3)));
}

function canSpell(word: string, rack: Rack): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c] > (rack.get(c) ?? 0)) return false;
  }
  return true;
}

function add(r: Rack, c: string) {
  r.set(c, (r.get(c) ?? 0) + 1);
}

function simBid(kind: Kind, letter: string, balance: number): number {
  const v = LETTER_VALUE[letter];
  const vowel = "AEIOU".includes(letter);
  const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (vowel ? 4 : 2);
  return Math.max(Math.min(Math.max(base + randInt(-2, 2), 1), balance), 0);
}

function starterBid(letter: string, balance: number, rack: Rack): number {
  const value = LETTER_VALUE[letter] ?? 1;
  const want = (rack.get(letter) ?? 0) === 0 ? value + 2 : Math.max(1, value);
  return Math.min(want, Math.max(0, balance));
}

const SIMS: Kind[] = ["Cheapskate", "ValueBidder", "Aggressive"];
const readers = new Map<number, TableReader>();

function playMatch(matchNo: number, auction: AuctionKind, kinds: Kind[]) {
  const bag: string[] = [];
  for (const [c, n] of Object.entries(FULL_BAG)) for (let i = 0; i < n; i++) bag.push(c);
  const draw = () => bag.splice(Math.floor(rand() * bag.length), 1)[0];

  const seats: Seat[] = kinds.map((kind, i) => ({
    id: String(i + 1),
    kind,
    balance: 100,
    score: 0,
    rack: new Map(),
  }));
  for (const s of seats) for (let k = 0; k < 5; k++) add(s.rack, draw());

  const nigels = seats.filter((s) => s.kind === "nigel");
  nigels.forEach((me, i) => {
    if (!readers.has(i)) readers.set(i, new TableReader());
    me.reader = readers.get(i)!;
    me.read = me.reader.openMatch(String(matchNo), me.id, auction, 5);
    for (const s of seats) me.read.addRival(s.id, !["nigel", "starter", "hoarder", "pricey", "pricey6", "field"].includes(s.kind));
    me.read.seedDealt(me.rack);
  });
  const allReads = () => nigels.map((n) => n.read!);
  let wordId = 0;

  const play = (s: Seat, w: string) => {
    s.rack = without(s.rack, w);
    const r = wordReward(w);
    s.balance += r;
    s.score += r;
    const id = String(wordId++);
    for (const read of allReads()) {
      read.onWordPlay({ id, botId: s.id, word: w });
      for (const t of seats) read.setParticipant(t.id, t.balance, t.score);
    }
  };

  const nigelPlays = () => {
    for (const me of nigels) {
      for (;;) {
        const { word } = explainWord({ myRack: me.rack, dictionary: dict, myBalance: me.balance, read: me.read });
        if (!word) break;
        play(me, word);
      }
    }
  };

  let auctionNo = 0;
  while (bag.length > 0) {
    const letter = draw();
    for (const read of allReads()) {
      read.bagTotal = bag.length;
      read.auctionOpen = true;
    }
    nigelPlays();

    const bids: { s: Seat; amt: number }[] = [];
    for (const s of seats) {
      let amt = 0;
      if (s.kind === "nigel") {
        amt = explainBid({ letter, myBalance: s.balance, myRack: s.rack, dictionary: dict, read: process.env.NOREAD && s.id === "1" ? undefined : s.read }).bid;
        s.read!.recordMyBid(String(auctionNo), letter, amt);
      } else if (s.kind === "field") amt = fieldBid(letter, s.balance, bag.length + 1, s.rack);
      else if (s.kind === "pricey" || s.kind === "pricey6") amt = priceyBid(letter, s.balance, bag.length + 1);
      else if (s.kind === "hoarder") amt = hoarderBid(letter, s.balance, bag.length + 1);
      else if (s.kind === "starter") amt = starterBid(letter, s.balance, s.rack);
      else amt = simBid(s.kind, letter, s.balance);
      if (amt > 0) bids.push({ s, amt });
    }
    // Shuffle, then sort by amount, so ties go to a random bidder.
    for (let i = bids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bids[i], bids[j]] = [bids[j], bids[i]];
    }
    bids.sort((a, b) => b.amt - a.amt);

    let winner: Seat | null = null;
    let paid = 0;
    if (bids.length) {
      const [first, second] = bids;
      paid = auction === "FirstPrice" ? first.amt : second ? second.amt : Math.min(1, first.amt);
      if (first.s.balance >= paid) {
        winner = first.s;
        winner.balance -= paid;
        winner.tiles = (winner.tiles ?? 0) + 1;
        if (auctionNo < 30) winner.early = (winner.early ?? 0) + 1;
        if (auctionNo >= 40) winner.late = (winner.late ?? 0) + 1;
        winner.spent = (winner.spent ?? 0) + paid;
        add(winner.rack, letter);
      }
    }
    for (const read of allReads()) {
      read.auctionOpen = false;
      read.onAuctionResult({ auctionId: String(auctionNo), letter, winnerBotId: winner?.id ?? null, paid });
      for (const t of seats) read.setParticipant(t.id, t.balance, t.score);
    }
    auctionNo++;

    if (bag.length === 0) break; // match ends with this close: no more plays
    if (winner && SIMS.includes(winner.kind)) {
      const w = bestWord(idx, winner.rack, 3);
      if (w) play(winner, w);
    }
    // The starter plays its longest word whenever its rack changes.
    for (const s of seats) {
      if (s.kind !== "starter") continue;
      for (;;) {
        // Longest spellable word (reward order differs, so scan by length).
        let w: string | null = null;
        const size = rackSize(s.rack);
        for (const d of dict) {
          if (d.length <= size && canSpell(d, s.rack)) {
            w = d;
            break;
          }
        }
        if (!w) break;
        play(s, w);
      }
    }
    for (const s of seats) {
      if (s.kind !== "pricey" && s.kind !== "pricey6") continue;
      for (;;) {
        const w = bestWord(idx, s.rack, bag.length <= 2 ? 2 : s.kind === "pricey" ? 4 : 6);
        if (!w) break;
        play(s, w);
      }
    }
    // Field bots: bingo when they can, a 5+ word when broke, dump at the end.
    for (const s of seats) {
      if (s.kind !== "field") continue;
      for (;;) {
        const minLen = bag.length <= 3 ? 2 : s.balance < 10 ? 5 : 7;
        const w = bestWord(idx, s.rack, minLen);
        if (!w) break;
        play(s, w);
      }
    }
    // The hoarder plays 7+ words, and dumps everything in the last rounds.
    for (const s of seats) {
      if (s.kind !== "hoarder") continue;
      for (;;) {
        const w = bestWord(idx, s.rack, bag.length <= 2 ? 2 : 7);
        if (!w) break;
        play(s, w);
      }
    }
    nigelPlays();
  }
  for (const n of nigels) n.reader!.closeMatch(String(matchNo));

  const order = [...seats].sort((a, b) => b.score - a.score);
  return seats.map((s) => ({
    kind: s.kind === "nigel" ? `nigel#${s.id}` : s.kind,
    score: s.score,
    tiles: s.tiles ?? 0,
    early: s.early ?? 0,
    late: s.late ?? 0,
    spent: s.spent ?? 0,
    left: s.balance,
    place: 1 + order.filter((o) => o.score > s.score).length,
  }));
}

const N = Number(process.argv[2] ?? 30);
const auction = (process.argv[3] ?? "Vickrey") as AuctionKind;
const totals = new Map<string, { score: number; place: number; wins: number; n: number; tiles: number; spent: number; left: number; early: number; late: number }>();
const t0 = Date.now();
for (let m = 0; m < N; m++) {
  const kinds = (process.env.TABLE ?? "nigel,starter").split(",") as Kind[];
  while (kinds.length < 6) kinds.push(SIMS[randInt(0, 2)]);
  for (const r of playMatch(m, auction, kinds)) {
    const t = totals.get(r.kind) ?? { score: 0, place: 0, wins: 0, n: 0, tiles: 0, spent: 0, left: 0, early: 0, late: 0 };
    t.tiles += r.tiles;
    t.early += r.early;
    t.late += r.late;
    t.spent += r.spent;
    t.left += r.left;
    t.score += r.score;
    t.place += r.place;
    t.wins += r.place === 1 ? 1 : 0;
    t.n++;
    totals.set(r.kind, t);
  }
}
console.log(`${N} ${auction} matches in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, t] of [...totals].sort((a, b) => a[1].place / a[1].n - b[1].place / b[1].n)) {
  console.log(
    `${k.padEnd(12)} avg score ${(t.score / t.n).toFixed(1).padStart(6)}  avg place ${(t.place / t.n).toFixed(2)}  wins ${((100 * t.wins) / t.n).toFixed(0)}%  tiles ${(t.tiles / t.n).toFixed(1)} (e${(t.early / t.n).toFixed(1)} l${(t.late / t.n).toFixed(1)}) spent ${(t.spent / t.n).toFixed(0)} left ${(t.left / t.n).toFixed(0)}`,
  );
}
