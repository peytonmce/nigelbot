// Reading the table.
//
// Everything here comes from what has actually happened: who won which
// letter, what it cost, which words went down, who has money left. No draw
// odds. It's the notebook a strong player keeps in their head: "he's sitting
// on eleven tiles and hasn't played in a while", "vowels are going for 4
// this game", "she always overpays for the big letters".

import { LETTER_VALUE } from "./words.js";

export type AuctionKind = "Vickrey" | "FirstPrice";

export const FULL_BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

const VOWELS = new Set(["A", "E", "I", "O", "U"]);
export const isVowel = (c: string) => VOWELS.has(c);
export const isHeavy = (c: string) => (LETTER_VALUE[c] ?? 0) >= 4;

export type LetterClass = "vowel" | "consonant" | "heavy";
export function classOf(c: string): LetterClass {
  if (isVowel(c)) return "vowel";
  if (isHeavy(c)) return "heavy";
  return "consonant";
}

function bump(m: Map<string, number>, k: string, by = 1) {
  m.set(k, (m.get(k) ?? 0) + by);
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** What we remember about a rival from match to match. */
export interface Profile {
  botId: string;
  isSim: boolean;
  matches: number;
  premiumEma: number; // paid minus face value when they win
  winsPerMatchEma: number;
  wordLenEma: number;
}

export class Rival {
  balance = 100;
  score = 0;
  won = new Map<string, number>();
  played = new Map<string, number>();
  wins = 0;
  tilesPlayed = 0;
  words = 0;
  lastPlayRound = 0;
  lastWinRound = 0;
  premiums: number[] = [];
  classBuys: Record<LetterClass, number> = { vowel: 0, consonant: 0, heavy: 0 };
  constructor(
    readonly botId: string,
    readonly isSim: boolean,
    private readonly startRack: number,
  ) {}

  /** Exact count of tiles they're holding (dealt + won - played). */
  get held(): number {
    return this.startRack + this.wins - this.tilesPlayed;
  }

  /** Letters we know are on their rack (won and not yet played). */
  knownRack(): Map<string, number> {
    const r = new Map<string, number>();
    for (const [c, n] of this.won) {
      const left = n - (this.played.get(c) ?? 0);
      if (left > 0) r.set(c, left);
    }
    return r;
  }
}

export class MatchRead {
  rivals = new Map<string, Rival>();
  /** Clearing prices per letter that reflect a rival's bid. */
  prices = new Map<string, number[]>();
  classPrices: Record<LetterClass, number[]> = { vowel: [], consonant: [], heavy: [] };
  /** Tiles whose identity we've seen: our dealt rack, every auctioned tile,
   *  and rivals' dealt tiles once they show up in a word. */
  seen = new Map<string, number>();
  myBids = new Map<string, { letter: string; amount: number }>();
  round = 0;
  bagTotal = 98;
  auctionOpen = false;
  myBalance = 100;
  myScore = 0;
  wantedLossStreak = 0;
  unsold = 0;
  private resultIds = new Set<string>();
  private playIds = new Set<string>();
  private dealtSeeded = false;

  constructor(
    readonly matchId: string,
    readonly myBotId: string,
    public auction: AuctionKind,
    readonly startRack: number,
    private readonly book: TableReader,
  ) {}

  addRival(botId: string, isSim: boolean) {
    if (botId === this.myBotId || this.rivals.has(botId)) return;
    this.rivals.set(botId, new Rival(botId, isSim, this.startRack));
  }

  /** Call once with our dealt tiles, as soon as the rack shows up. */
  seedDealt(rack: Map<string, number>) {
    if (this.dealtSeeded || rack.size === 0) return;
    this.dealtSeeded = true;
    for (const [c, n] of rack) bump(this.seen, c, n);
  }

  get roundsLeft(): number {
    // The bag count excludes the tile on the block right now.
    return this.bagTotal + (this.auctionOpen ? 1 : 0);
  }

  recordMyBid(auctionId: string, letter: string, amount: number) {
    this.myBids.set(auctionId, { letter, amount });
  }

  onAuctionResult(r: {
    auctionId: string;
    letter: string;
    winnerBotId: string | null;
    paid: number;
  }) {
    if (this.resultIds.has(r.auctionId)) return;
    this.resultIds.add(r.auctionId);
    this.round++;
    bump(this.seen, r.letter);
    const mine = this.myBids.get(r.auctionId);
    const face = LETTER_VALUE[r.letter] ?? 1;

    if (r.winnerBotId === null) {
      this.unsold++;
      return;
    }
    const iWon = r.winnerBotId === this.myBotId;
    if (iWon) this.wantedLossStreak = 0;
    else if (mine && mine.amount > 0) this.wantedLossStreak++;

    // Does the price tell us what a rival was willing to pay?
    //  First-price: paid is the winner's own bid.
    //  Vickrey: paid is the runner-up's bid, which is a rival's unless it was ours.
    let rivalPrice: number | null = null;
    if (this.auction === "FirstPrice") {
      if (!iWon) rivalPrice = r.paid;
    } else if (iWon) {
      rivalPrice = r.paid > 1 ? r.paid : null; // 1 = reserve, nobody else bid
    } else if (!mine || mine.amount !== r.paid) {
      rivalPrice = r.paid;
    } else {
      rivalPrice = r.paid; // we were the runner-up: the winner paid at least this
    }
    if (rivalPrice !== null) {
      const list = this.prices.get(r.letter) ?? [];
      list.push(rivalPrice);
      this.prices.set(r.letter, list);
      this.classPrices[classOf(r.letter)].push(rivalPrice);
      this.book.notePrice(r.letter, rivalPrice);
    }

    if (!iWon) {
      const rv = this.rivals.get(r.winnerBotId);
      if (rv) {
        rv.wins++;
        rv.lastWinRound = this.round;
        bump(rv.won, r.letter);
        rv.classBuys[classOf(r.letter)]++;
        if (this.auction === "FirstPrice") rv.premiums.push(r.paid - face);
        else if (rivalPrice !== null && mine?.amount !== r.paid) rv.premiums.push(r.paid - face);
      }
    }
  }

  onWordPlay(p: { id: string; botId: string; word: string }) {
    if (this.playIds.has(p.id)) return;
    this.playIds.add(p.id);
    if (p.botId === this.myBotId) return;
    const rv = this.rivals.get(p.botId);
    if (!rv) return;
    for (const c of p.word) {
      // A letter they never won must have come from their dealt rack:
      // that's a tile we're seeing for the first time.
      const before = (rv.played.get(c) ?? 0) - (rv.won.get(c) ?? 0);
      bump(rv.played, c);
      if (before >= 0) bump(this.seen, c);
    }
    rv.tilesPlayed += p.word.length;
    rv.words++;
    rv.lastPlayRound = this.round;
  }

  setParticipant(botId: string, balance: number, score: number) {
    if (botId === this.myBotId) {
      this.myBalance = balance;
      this.myScore = score;
      return;
    }
    const rv = this.rivals.get(botId);
    if (rv) {
      rv.balance = balance;
      rv.score = score;
    }
  }

  // ---------- Questions a player asks themselves ----------

  /** How many of `c` haven't turned up anywhere yet (in the bag or someone's dealt tiles). */
  unseen(c: string): number {
    return Math.max(0, (FULL_BAG[c] ?? 0) - (this.seen.get(c) ?? 0));
  }

  /** What this letter has been going for. NaN if we have nothing to go on. */
  goingRate(c: string): number {
    const own = this.prices.get(c) ?? [];
    if (own.length >= 2) return median(own.slice(-5));
    const cls = this.classPrices[classOf(c)];
    const face = LETTER_VALUE[c] ?? 1;
    if (cls.length >= 3) {
      const rate = median(cls.slice(-6));
      return own.length === 1 ? (rate + own[0]) / 2 : Math.max(rate, face * 0.8);
    }
    if (own.length === 1) return own[0];
    return this.book.globalRate(c);
  }

  /** What a tile typically sells for in this room, across all letters. */
  priceLevel(): number {
    const all: number[] = [];
    for (const k of ["vowel", "consonant", "heavy"] as const) all.push(...this.classPrices[k].slice(-8));
    if (all.length >= 4) return median(all);
    return this.book.globalLevel();
  }

  /** Rivals who can still afford to bid. */
  liveRivals(): Rival[] {
    return [...this.rivals.values()].filter((r) => r.balance > 0);
  }

  richestRivalBalance(): number {
    let m = 0;
    for (const r of this.rivals.values()) m = Math.max(m, r.balance);
    return m;
  }

  /** Highest bid we'd expect from the field for `c`, from how each rival has
   *  actually been paying, capped by what they can afford. */
  expectedTopRivalBid(c: string): number {
    const face = LETTER_VALUE[c] ?? 1;
    let top = 0;
    for (const r of this.liveRivals()) {
      const prof = this.book.profile(r.botId);
      const prem =
        r.premiums.length >= 2
          ? median(r.premiums.slice(-6))
          : prof && prof.matches > 0
            ? prof.premiumEma
            : 1;
      top = Math.max(top, Math.min(r.balance, face + prem));
    }
    const rate = this.goingRate(c);
    return Number.isNaN(rate) ? top : Math.max(top, rate);
  }

  /** A rival sitting on a big rack and not cashing it: building something long. */
  isHoarding(r: Rival): boolean {
    return r.held >= 9 && this.round - r.lastPlayRound >= 6;
  }

  /** Who's the one to worry about: points banked plus tiles in hand. */
  threat(r: Rival): number {
    return r.score + r.held * 3;
  }

  myThreat(myHeld: number): number {
    return this.myScore + myHeld * 3;
  }

  biggestThreat(): Rival | null {
    let best: Rival | null = null;
    for (const r of this.rivals.values()) {
      if (!best || this.threat(r) > this.threat(best)) best = r;
    }
    return best;
  }

  /** Our place right now by banked score, 1 = leading. */
  myPlace(): number {
    let place = 1;
    for (const r of this.rivals.values()) if (r.score > this.myScore) place++;
    return place;
  }

  /** At the end, fold what we saw into the long-term notebook. */
  finish() {
    for (const r of this.rivals.values()) this.book.updateProfile(r);
  }
}

export class TableReader {
  matches = new Map<string, MatchRead>();
  profiles = new Map<string, Profile>();
  private global = new Map<string, number>(); // EMA of clearing price per letter

  match(id: string): MatchRead | undefined {
    return this.matches.get(id);
  }

  openMatch(
    matchId: string,
    myBotId: string,
    auction: AuctionKind,
    startRack: number,
  ): MatchRead {
    let m = this.matches.get(matchId);
    if (!m) {
      m = new MatchRead(matchId, myBotId, auction, startRack, this);
      this.matches.set(matchId, m);
    }
    return m;
  }

  closeMatch(matchId: string) {
    const m = this.matches.get(matchId);
    if (!m) return;
    m.finish();
    this.matches.delete(matchId);
  }

  notePrice(c: string, p: number) {
    const prev = this.global.get(c);
    this.global.set(c, prev === undefined ? p : prev * 0.85 + p * 0.15);
  }

  globalLevel(): number {
    const v = [...this.global.values()];
    return v.length >= 5 ? median(v) : NaN;
  }

  globalRate(c: string): number {
    return this.global.get(c) ?? NaN;
  }

  profile(botId: string): Profile | undefined {
    return this.profiles.get(botId);
  }

  updateProfile(r: Rival) {
    const p = this.profiles.get(r.botId) ?? {
      botId: r.botId,
      isSim: r.isSim,
      matches: 0,
      premiumEma: 1,
      winsPerMatchEma: 10,
      wordLenEma: 4,
    };
    const a = p.matches === 0 ? 1 : 0.3;
    if (r.premiums.length) p.premiumEma = p.premiumEma * (1 - a) + median(r.premiums) * a;
    p.winsPerMatchEma = p.winsPerMatchEma * (1 - a) + r.wins * a;
    if (r.words) p.wordLenEma = p.wordLenEma * (1 - a) + (r.tilesPlayed / r.words) * a;
    p.matches++;
    this.profiles.set(r.botId, p);
  }

  toJSON() {
    return {
      profiles: [...this.profiles.values()],
      global: Object.fromEntries(this.global),
    };
  }

  load(data: unknown) {
    const d = data as { profiles?: Profile[]; global?: Record<string, number> };
    for (const p of d?.profiles ?? []) this.profiles.set(p.botId, p);
    for (const [k, v] of Object.entries(d?.global ?? {})) this.global.set(k, v);
  }
}
