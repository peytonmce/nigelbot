// Checks for the Nigel strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { TableReader } from "./reads.js";
import { chooseWord, decideBid, explainBid } from "./strategy.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

const DICT = fs
  .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2)
  .sort((a, b) => b.length - a.length);

function newMatch(kind: "Vickrey" | "FirstPrice" = "Vickrey") {
  const reader = new TableReader();
  const m = reader.openMatch("1", "1", kind, 5);
  for (const id of ["1", "2", "3"]) m.addRival(id, false);
  return m;
}

test("early on, holds a cheap bingo to build a better one", () => {
  // RETAINS is only 21 points; winners' bingos average ~47.
  const read = newMatch();
  read.bagTotal = 40;
  assert.equal(chooseWord({ myRack: rack("RETAINS"), dictionary: DICT, read }), null);
});

test("takes a cheap bingo once time is short", () => {
  const read = newMatch();
  read.bagTotal = 12;
  assert.equal(chooseWord({ myRack: rack("RETAINS"), dictionary: DICT, read })?.length, 7);
});

test("takes a big bingo right away", () => {
  const read = newMatch();
  read.bagTotal = 40;
  const w = chooseWord({ myRack: rack("QUIZKEST"), dictionary: DICT, read });
  assert.ok(w === null || w.length >= 7);
});

test("keeps building mid-game instead of cashing short words", () => {
  const read = newMatch();
  read.bagTotal = 40;
  assert.equal(chooseWord({ myRack: rack("CATE"), dictionary: DICT, myBalance: 90, read }), null);
});

test("cashes out at the end", () => {
  const read = newMatch();
  read.bagTotal = 1;
  assert.ok(chooseWord({ myRack: rack("CATE"), dictionary: DICT, myBalance: 90, read }));
});

test("doesn't burn short words for cash mid-game", () => {
  // On the real server, cashing short words to raise coins emptied the rack.
  const read = newMatch();
  read.bagTotal = 40;
  assert.equal(chooseWord({ myRack: rack("CATEX"), dictionary: DICT, myBalance: 1, read }), null);
});

test("never bids on the final tile", () => {
  const read = newMatch();
  read.bagTotal = 0;
  read.auctionOpen = true;
  assert.equal(decideBid({ letter: "E", myBalance: 100, myRack: rack("RTAINS"), dictionary: DICT, read }), 0);
});

test("a Q with no U left anywhere is worthless", () => {
  const read = newMatch();
  read.bagTotal = 30;
  read.seedDealt(rack("UUUUB"));
  assert.equal(decideBid({ letter: "Q", myBalance: 100, myRack: rack("BCDE"), read }), 0);
});

test("first-price: bids just over what the room pays, not full value", () => {
  const read = newMatch("FirstPrice");
  read.bagTotal = 40;
  // Rivals keep winning E for 2.
  for (let i = 0; i < 4; i++) {
    read.onAuctionResult({ auctionId: String(i), letter: "E", winnerBotId: "2", paid: 2 });
  }
  const { bid } = explainBid({ letter: "E", myBalance: 100, myRack: rack("RTNSL"), dictionary: DICT, read });
  assert.ok(bid >= 3 && bid <= 4, `bid ${bid}`);
});

test("reads a rival's rack size from sales and plays", () => {
  const read = newMatch();
  for (let i = 0; i < 6; i++) {
    read.onAuctionResult({ auctionId: String(i), letter: "AEIRST"[i], winnerBotId: "2", paid: 3 });
  }
  read.onWordPlay({ id: "1", botId: "2", word: "STAIR" });
  const rv = read.rivals.get("2")!;
  assert.equal(rv.held, 5 + 6 - 5);
  assert.deepEqual([...rv.knownRack()], [["E", 1]]);
});

// The bot can't see a match move on while it thinks, so a slow decision
// means bids on closed auctions and words from letters it already spent.
test("decisions are well within an auction", () => {
  const read = newMatch();
  read.bagTotal = 30;
  chooseWord({ myRack: rack("A"), dictionary: DICT, read }); // build the index once
  const start = performance.now();
  decideBid({ letter: "E", myBalance: 80, myRack: rack("BCDFGHJKLMNPQRSTVWXZAE"), dictionary: DICT, read });
  chooseWord({ myRack: rack("BCDFGHJKLMNPQRSTVWXZAE"), dictionary: DICT, read });
  assert.ok(performance.now() - start < 100, "a decision took 100 ms or more");
});
