// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  tables,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { P, explainBid, explainWord } from "./strategy.js";
import { TableReader, type MatchRead } from "./reads.js";
import { buildIndex } from "./words.js";

// Everything the bot prints also goes to bot.log in this folder, so the
// log can be read without copying it out of the window.
{
  const name = process.env.BOT_NAME ?? "bot";
  const logFile = fs.createWriteStream(path.join(process.cwd(), name === "nigel" ? "bot.log" : `bot-${name}.log`), { flags: "a" });
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
      logFile.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
    };
  }
}

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

// STRATEGY=whale: the opposite of Nigel's caution. Outbid on anything
// useful, spend every coin, cash 5+ letter words to get the money back.
const PRESETS: Record<string, Partial<typeof P>> = {
  // hoarder: build a big rack (12-16 tiles) and only play huge words (60+
  // points) until the last few rounds, then cash everything. Best real
  // record of the night: 3 wins in 8 matches.
  hoarder: { bingoMinPts: 60, bingoPatientUntil: 6, bingoFullRack: 16, cashMinLen: 99, lateRounds: 6, heavyBoost: 1.5, hungerRack: 14, paceEarly: 8 },
  // hoarder2: hoarder + cash the big word at 16 rounds left + reload from 14.
  hoarder2: { bingoMinPts: 60, bingoPatientUntil: 16, bingoFullRack: 16, cashMinLen: 99, lateRounds: 16, heavyBoost: 1.5, hungerRack: 14, paceEarly: 8, reloadFrom: 14 },
  whale: { paceEarly: 0, keepCash: 0.9, onePointCap: 1.6, edge: 6, edgeOnePoint: 3, bingoMinPts: 0, cashMinLen: 5, hungerRack: 12, priceDiv: 3, spendDownFrom: 30 },
};
const STRATEGY = process.env.STRATEGY ?? "nigel";
if (PRESETS[STRATEGY]) Object.assign(P, PRESETS[STRATEGY]);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/..." and
// the file is never found.
const here = path.dirname(fileURLToPath(import.meta.url));
const dictionaryPath = [
  path.join(here, "..", "..", "spacetimedb", "wordlist.txt"),
  path.join(here, "..", "wordlist.txt"),
].find((p) => fs.existsSync(p)) ?? path.join(here, "..", "..", "spacetimedb", "wordlist.txt");
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
if (DICTIONARY.length === 0) {
  console.error(`[${BOT_NAME}] no word list found at ${dictionaryPath}: the bot can't play words without it`);
  process.exit(1);
}
console.log(`[${BOT_NAME}] loaded ${DICTIONARY.length} words; strategy: ${STRATEGY}`);
buildIndex(DICTIONARY); // ~200 ms once, so the first auction isn't slow

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const lastWordSent = new Map<string, { word: string; at: number }>();
// Short, so the endgame cash-out can get several words down in the last
// couple of seconds. Each successful play changes the rack and retriggers.
const WORD_RETRY_MS = 150;

// ---------- The notebook: what we've seen at the table ----------
// Opponent profiles carry over between matches and runs.
const READS_PATH = path.join(process.cwd(), `.reads-${BOT_NAME}.json`);
const reader = new TableReader();
try {
  reader.load(JSON.parse(fs.readFileSync(READS_PATH, "utf8")));
  console.log(`[${BOT_NAME}] loaded notes on ${reader.profiles.size} opponents`);
} catch {
  // first run
}
function saveReads() {
  try {
    fs.writeFileSync(READS_PATH, JSON.stringify(reader.toJSON()));
  } catch (e) {
    console.warn(`[${BOT_NAME}] couldn't save reads: ${e}`);
  }
}
let retryPending = false;
// Matches whose history we've loaded and replayed; live events count from then on.
const ready = new Set<string>();
type Sub = { unsubscribe(): void };
const watched = new Map<string, Sub>();
const notMine = new Set<string>();

/** The read for a running match we're in, opening it the first time we see it. */
function readFor(conn: DbConnection, matchId: bigint): MatchRead | undefined {
  if (myBotId === null) return undefined;
  const key = String(matchId);
  if (notMine.has(key)) return undefined;
  const existing = reader.match(key);
  const m = conn.db.matchState.id.find(matchId);
  if (existing) {
    if (m) existing.bagTotal = m.bagTotal;
    return existing;
  }
  if (!m) return undefined;
  if (!amIn(conn, matchId)) {
    notMine.add(key); // rosters are fixed when a match starts
    return undefined;
  }
  if (m.status.tag !== "Running") {
    if (m.status.tag === "Ended") notMine.add(key); // finished: nothing to read
    return undefined;
  }
  const players = Array.from(conn.db.matchParticipant.mpByMatch.filter(matchId));
  if (!players.some((p) => p.botId === myBotId)) {
    notMine.add(key); // rosters are fixed when a match starts
    return undefined;
  }
  const read = reader.openMatch(
    key,
    String(myBotId),
    m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    m.startingRackSize,
  );
  for (const p of players) {
    const bot = conn.db.bot.id.find(p.botId);
    read.addRival(String(p.botId), bot?.isSimulated ?? false);
    read.setParticipant(String(p.botId), Number(p.balance), Number(p.score));
  }
  read.bagTotal = m.bagTotal;
  console.log(
    `[${BOT_NAME}] match ${matchId}: ${m.auctionType.tag}, ${players.length} players`,
  );
  return read;
}

/** Bring a read up to date: bag count, and whether an auction is on the block. */
function syncRead(conn: DbConnection, read: MatchRead, matchId: bigint) {
  const m = conn.db.matchState.id.find(matchId);
  if (!m) return;
  read.bagTotal = m.bagTotal;
  const cur = m.currentAuctionId;
  const a = cur !== undefined ? conn.db.auction.id.find(cur) : undefined;
  read.auctionOpen = a?.status.tag === "Open";
}

function ingestResult(
  conn: DbConnection,
  r: { auctionId: bigint; matchId: bigint; letter: string; winnerBotId?: bigint | null; paid: bigint },
) {
  const read = readFor(conn, r.matchId);
  if (!read) return;
  read.onAuctionResult({
    auctionId: String(r.auctionId),
    letter: r.letter,
    winnerBotId:
      r.winnerBotId !== undefined && r.winnerBotId !== null ? String(r.winnerBotId) : null,
    paid: Number(r.paid),
  });
}

function ingestPlay(conn: DbConnection, w: { id: bigint; matchId: bigint; botId: bigint; word: string }) {
  const read = readFor(conn, w.matchId);
  if (!read) return;
  read.onWordPlay({ id: String(w.id), botId: String(w.botId), word: w.word });
}

/** Replay a match's history in order: every sale, then every word. */
function replay(conn: DbConnection, matchId: bigint) {
  const results = Array.from(conn.db.auctionResult.resultByMatch.filter(matchId));
  results.sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1));
  for (const r of results) {
    trackResult(r);
    ingestResult(conn, r);
  }
  const plays = Array.from(conn.db.wordPlay.playByMatch.filter(matchId));
  plays.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const w of plays) {
    trackPlay(w);
    ingestPlay(conn, w);
  }
}

// ---------- What we download ----------
// Only what the bot needs: its own seats, and the rows of the matches it's
// in. Downloading every table means every match every team has ever
// played, which takes minutes and then buries the bot in updates.

function unsubscribeQuietly(sub: Sub | undefined) {
  try {
    sub?.unsubscribe();
  } catch {
    /* connection already gone */
  }
}

/** Start following one of our matches: its state, seats, auctions, sales and words. */
function watchMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (watched.has(key)) return;
  const sub = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const m = conn.db.matchState.id.find(matchId);
      if (m?.status.tag !== "Running") {
        // An old match of ours: nothing to do.
        unwatchMatch(key);
        return;
      }
      try {
        readFor(conn, matchId); // announces the match
        replay(conn, matchId);
      } catch (e) {
        console.warn(`[${BOT_NAME}] couldn't replay match ${matchId}: ${e instanceof Error ? e.stack : e}`);
      }
      ready.add(key);
      for (const a of conn.db.auction.auctionByMatch.filter(matchId)) {
        if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
      }
      tryPlayWord(conn);
    })
    .onError((ctx) => console.warn(`[${BOT_NAME}] following match ${matchId} failed: ${ctx.event?.message ?? ctx.event}`))
    .subscribe([
      tables.matchState.where((r) => r.id.eq(matchId)),
      tables.matchParticipant.where((r) => r.matchId.eq(matchId)),
      tables.auction.where((r) => r.matchId.eq(matchId)),
      tables.auctionResult.where((r) => r.matchId.eq(matchId)),
      tables.wordPlay.where((r) => r.matchId.eq(matchId)),
    ]);
  watched.set(key, sub);
}

// Save the whole match (every sale, every word, final scores) to
// matches.jsonl, to study what the winners do.
function recordMatch(conn: DbConnection, matchId: bigint) {
  try {
    const m = conn.db.matchState.id.find(matchId);
    const bots = Array.from(conn.db.matchParticipant.mpByMatch.filter(matchId)).map((p) => ({
      bot: Number(p.botId),
      name: conn.db.bot.id.find(p.botId)?.name ?? "?",
      sim: conn.db.bot.id.find(p.botId)?.isSimulated ?? false,
      score: Number(p.score),
      balance: Number(p.balance),
    }));
    const sales = Array.from(conn.db.auctionResult.resultByMatch.filter(matchId))
      .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
      .map((r) => [r.letter, r.winnerBotId === undefined || r.winnerBotId === null ? null : Number(r.winnerBotId), Number(r.paid), r.closedAt.toDate().getTime()]);
    const words = Array.from(conn.db.wordPlay.playByMatch.filter(matchId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((w) => [Number(w.botId), w.word, Number(w.totalReward), w.playedAt.toDate().getTime()]);
    const rec = { match: Number(matchId), me: Number(myBotId), auction: m?.auctionType.tag, bots, sales, words };
    fs.appendFileSync(path.join(process.cwd(), BOT_NAME === "nigel" ? "matches.jsonl" : `matches-${BOT_NAME}.jsonl`), JSON.stringify(rec) + "\n");
  } catch (e) {
    console.warn(`[${BOT_NAME}] couldn't record match ${matchId}: ${e instanceof Error ? e.message : e}`);
  }
}

function unwatchMatch(key: string) {
  ownTiles.delete(key);
  unsubscribeQuietly(watched.get(key));
  watched.delete(key);
  ready.delete(key);
}

/** Once we know which bot we are: follow our seats, then get playing. */
function startPlaying(conn: DbConnection) {
  const botId = myBotId!;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] ready`);
      for (const p of mySeats(conn)) watchMatch(conn, p.matchId);
      try {
        bootstrapActivity(conn);
      } catch (e) {
        console.error(`[${BOT_NAME}] startup error: ${e instanceof Error ? e.stack : e}`);
      }
      startHeartbeat(conn);
    })
    .onError((ctx) => console.error(`[${BOT_NAME}] subscribing to our seats failed: ${ctx.event?.message ?? ctx.event}`))
    .subscribe([tables.matchParticipant.where((r) => r.botId.eq(botId))]);
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

// Our own letters, counted from the public record: tiles we won minus tiles
// we played. The server's private rack view should show the same and more
// (it includes the dealt tiles), but if it comes back empty this keeps the
// bot able to spell with what it bought.
const ownTiles = new Map<string, Map<string, number>>();
const ownSeen = new Set<string>();
function trackOwn(matchId: bigint, id: string, letters: string, sign: 1 | -1) {
  if (ownSeen.has(id)) return;
  ownSeen.add(id);
  const key = String(matchId);
  const r = ownTiles.get(key) ?? new Map<string, number>();
  for (const c of letters) r.set(c, Math.max(0, (r.get(c) ?? 0) + sign));
  ownTiles.set(key, r);
}
function trackResult(r: { auctionId: bigint; matchId: bigint; letter: string; winnerBotId?: bigint | null }) {
  if (myBotId !== null && r.winnerBotId === myBotId) trackOwn(r.matchId, `a${r.auctionId}`, r.letter, 1);
}
function trackPlay(w: { id: bigint; matchId: bigint; botId: bigint; word: string }) {
  if (myBotId !== null && w.botId === myBotId) trackOwn(w.matchId, `w${w.id}`, w.word, -1);
}

let warnedEmptyView = false;
function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  const own = ownTiles.get(String(matchId));
  if (own) {
    let viewTotal = 0;
    for (const n of rack.values()) viewTotal += n;
    let ownTotal = 0;
    for (const [c, n] of own) {
      ownTotal += n;
      if (n > (rack.get(c) ?? 0)) rack.set(c, n);
    }
    if (viewTotal === 0 && ownTotal > 0 && !warnedEmptyView) {
      warnedEmptyView = true;
      console.warn(`[${BOT_NAME}] the server's rack view is empty; using the letters we've won`);
    }
  }
  for (const [c, n] of rack) if (n <= 0) rack.delete(c);
  return rack;
}

// Our own seats, via the bot-id index. Scanning the whole participant
// table on every auction (the server streams every match being played)
// starves the bot of time to do anything else.
function mySeats(conn: DbConnection) {
  return myBotId === null ? [] : Array.from(conn.db.matchParticipant.mpByBot.filter(myBotId));
}
function myRunningMatches(conn: DbConnection): bigint[] {
  return mySeats(conn)
    .filter((p) => conn.db.matchState.id.find(p.matchId)?.status.tag === "Running")
    .map((p) => p.matchId);
}
function amIn(conn: DbConnection, matchId: bigint): boolean {
  return mySeats(conn).some((p) => p.matchId === matchId);
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  const p = mySeats(conn).find((x) => x.matchId === matchId);
  return p ? { balance: Number(p.balance), score: Number(p.score) } : null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const read = readFor(conn, matchId);
  if (read) syncRead(conn, read, matchId);
  const myRack = rackForMatch(conn, matchId);
  read?.seedDealt(myRack);
  const { bid: amount, why } = explainBid({
    letter,
    myBalance: participant.balance,
    myRack,
    dictionary: DICTIONARY,
    read,
  });
  bidsByAuction.add(key);
  read?.recordMyBid(String(auctionId), letter, amount);
  if (amount <= 0) {
    console.log(`[${BOT_NAME}] pass on '${letter}' (${why})`);
    return;
  }
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' — ${why} (match ${matchId}, ${read?.roundsLeft ?? "?"} left)`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>(myRunningMatches(conn));
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    const since = now - (lastWordAttemptByMatch.get(key) ?? 0);
    if (since < WORD_RETRY_MS) {
      // Don't drop the trigger: look again once the throttle clears.
      if (!retryPending) {
        retryPending = true;
        setTimeout(() => {
          retryPending = false;
          tryPlayWord(conn);
        }, WORD_RETRY_MS - since + 5);
      }
      continue;
    }
    lastWordAttemptByMatch.set(key, now);
    const read = readFor(conn, matchId);
    if (read) syncRead(conn, read, matchId);
    const myRack = rackForMatch(conn, matchId);
    read?.seedDealt(myRack);
    const { word, why } = explainWord({
      myRack,
      dictionary: DICTIONARY,
      myBalance: participantForMatch(conn, matchId)?.balance,
      read,
    });
    if (!word) continue;
    // Don't send the same word twice while the first is still in flight.
    const last = lastWordSent.get(key);
    if (last && last.word === word && now - last.at < 1500) continue;
    lastWordSent.set(key, { word, at: now });
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}' (${why})`);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            startPlaying(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      startPlaying(conn);
    })
    .onError((ctx) => console.error(`[${BOT_NAME}] subscription failed: ${ctx.event?.message ?? ctx.event}`))
    .subscribe([
      tables.botCredential,
      tables.bot,
      tables.myRack,
      tables.openLobbies,
      tables.openLobbyMembers,
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    if (!ready.has(String(a.matchId))) return; // its subscription will bid on it
    tryBid(conn, a.id, a.matchId, a.letter);
    // A new round is also a clock tick: late in the match, cash out.
    tryPlayWord(conn);
  });

  // Watch the table: every sale and every word goes in the notebook.
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (!ready.has(String(r.matchId))) return;
    trackResult(r);
    ingestResult(conn, r);
    // A tile we just won changes what we can spell.
    if (myBotId !== null && r.winnerBotId === myBotId) tryPlayWord(conn);
  });
  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (!ready.has(String(w.matchId))) return;
    trackPlay(w);
    ingestPlay(conn, w);
  });
  const onParticipant = (p: { matchId: bigint; botId: bigint; balance: bigint; score: bigint }) => {
    const read = reader.match(String(p.matchId));
    read?.setParticipant(String(p.botId), Number(p.balance), Number(p.score));
  };
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    // A new seat of ours means a new match: start following it.
    if (myBotId !== null && p.botId === myBotId) watchMatch(conn, p.matchId);
    onParticipant(p);
  });
  conn.db.matchParticipant.onUpdate((_ctx, _old, p) => onParticipant(p));
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    // Only our own matches: the server streams every match being played.
    if (!reader.match(String(r.matchId))) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    const tag = winner === String(myBotId) ? " (us!)" : "";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} '${r.letter}' → bot ${winner}${tag} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = amIn(conn, neu.id);
      if (wasIn) {
        const read = reader.match(String(neu.id));
        if (read) {
          const top = Math.max(0, ...[...read.rivals.values()].map((r) => r.score));
          console.log(
            `[${BOT_NAME}] match ${neu.id} ended: score ${read.myScore}, place ${read.myPlace()} of ${read.rivals.size + 1} (best rival ${top})`,
          );
          reader.closeMatch(String(neu.id));
          saveReads();
        }
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
        // Stop following it once the last updates are in.
        setTimeout(() => {
          recordMatch(conn, neu.id);
          unwatchMatch(String(neu.id));
        }, 5000);
      }
    }
  });
}

// Every 20 s: say what we're doing, and get back in the lobby if we've
// somehow fallen out of it.
function startHeartbeat(conn: DbConnection) {
  setInterval(() => {
    try {
      joinLobby(conn, true);
    } catch (e) {
      console.warn(`[${BOT_NAME}] heartbeat error: ${e instanceof Error ? e.message : e}`);
    }
  }, 20_000);
}

function joinLobby(conn: DbConnection, verbose = false) {
  if (myBotId === null) return;
  const inRunning = myRunningMatches(conn).length > 0;
  if (inRunning) {
    if (verbose) {
      for (const m of myRunningMatches(conn)) {
        const r = rackForMatch(conn, m);
        const letters = [...r].map(([c, n]) => c.repeat(n)).join("");
        const bal = participantForMatch(conn, m)?.balance ?? "?";
        console.log(`[${BOT_NAME}] in match ${m}: rack ${letters || "(empty)"}, balance ${bal}`);
      }
    }
    return;
  }
  const openLobby = Array.from(conn.db.openLobbies.iter())[0];
  const members = openLobby
    ? Array.from(conn.db.openLobbyMembers.iter()).filter((lm) => lm.lobbyId === openLobby.id)
    : [];
  const alreadyIn = members.some((lm) => lm.botId === myBotId);
  if (alreadyIn) {
    if (verbose) {
      const secs = Math.max(0, Math.round((openLobby!.closesAt.toDate().getTime() - Date.now()) / 1000));
      const n = members.length;
      console.log(`[${BOT_NAME}] waiting in lobby ${openLobby!.id} (${n} bot(s) in, starts in ~${secs}s)`);
    }
    return;
  }
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

process.on("uncaughtException", (e) => console.error(`[${BOT_NAME}] error: ${e.stack ?? e}`));
process.on("unhandledRejection", (e) => console.error(`[${BOT_NAME}] error: ${e instanceof Error ? e.stack : e}`));

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn, true);
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
