/**
 * What is this file, and what fills are in it?
 *
 * The journal was built around TradingView's own exports and matched them by
 * FILENAME. Chris trades a funded Tradovate account through TradingView, so
 * the same trades exist in two places: TradingView's export, whose activity
 * log only reaches back about an hour and leaves older trades with no stop and
 * therefore no R, and Tradovate's own export, which is the broker's complete
 * record of the account.
 *
 * So a file is recognised by its COLUMNS instead, which is how every importer
 * that survives contact with real exports does it, and translated into the one
 * shape the rest of the app already reads. Nothing downstream changes: the
 * pairing, the R rules, the Diary and the stats carry on as they were.
 *
 * Adding a broker is adding one entry to SOURCES.
 */

/** Headers compared with the punctuation and the case taken out.
 *
 *  Tradovate's Fills report carries its own internal columns beside the human
 *  ones: `_timestamp` in UTC next to `Timestamp` in your local time, and both
 *  of them become "timestamp" once the punctuation goes. The internal ones
 *  keep a "raw" in front so the two never collide, and so the file's own local
 *  stamps are the ones used, which is what the journal's offset setting is
 *  there to read. */
const norm = h => {
  const clean = String(h).toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^_/.test(String(h).trim()) ? "raw" + clean : clean;
};

/** The first of these columns that has anything in it. */
const pick = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== "") return row[n];
  return null;
};

const num = v => {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v).replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** "MNQZ5", "MNQZ2026" and "CME_MINI:MNQ1!" are all the MNQ contract. */
export function rootSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase().split(":").pop().replace("1!", "");
  const m = s.match(/^([A-Z0-9]{1,4}?)[FGHJKMNQUVXZ]\d{1,4}$/);
  return m ? m[1] : s;
}

const two = n => String(n).padStart(2, "0");
const pad = hhmm => (hhmm.split(":").length === 2 ? hhmm + ":00" : hhmm)
  .split(":").map(p => p.padStart(2, "0")).join(":");

/**
 * A date and a time as the journal stamps them: "YYYY-MM-DD HH:MM:SS", left in
 * whatever local time the export was written in, which is what the app's own
 * offset setting exists to interpret.
 *
 * Tradovate writes "M/D/YY" dates, sometimes puts the whole stamp in the
 * fill-time column instead, and can write a 12-hour clock. All of those arrive
 * here, and anything else returns nothing rather than a guess.
 */
export function stamp(date, time) {
  const d = String(date || "").trim(), t = String(time || "").trim();
  const whole = t.length > 10 && (t.includes("/") || t.includes("-")) ? t
    : (d && t ? d + " " + t : d || t);
  if (!whole) return null;

  const iso = whole.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2}(:\d{2})?)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${pad(iso[4])}`;

  const us = whole.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[, ]+(\d{1,2}:\d{2}(:\d{2})?)\s*([ap]\.?m\.?)?)?/i);
  if (!us) return null;
  const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
  let hhmmss = pad(us[4] || "00:00:00");
  const ampm = (us[6] || "").toLowerCase().replace(/\./g, "");
  if (ampm) {
    let [h, m, s] = hhmmss.split(":").map(Number);
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    hhmmss = [h, m, s].map(two).join(":");
  }
  return `${year}-${two(Number(us[1]))}-${two(Number(us[2]))} ${hhmmss}`;
}

const BUY = /^(b|buy|bot|bought|long)$/i;
const SELL = /^(s|sell|sld|sold|short)$/i;

/**
 * The exports this app knows.
 *
 * `need` lists the columns a file must have to BE that export, as groups of
 * alternatives. They are chosen so no file can answer to two of them.
 */
export const SOURCES = [
  {
    id: "tradingview-orders",
    name: "TradingView order history",
    need: [["symbol"], ["side"], ["fillprice"]],
    // Already the shape the engine reads. Listed so a dropped TradingView
    // file is RECOGNISED rather than reported as unknown; the engine's own
    // reader still handles it, because it also de-duplicates on order id.
    fills: () => [],
  },
  {
    id: "tradovate-orders",
    name: "Tradovate orders",
    /* Tradovate's own export: orderId, Account, Date, Fill Time, B/S,
       Contract, Product, Filled Qty, Avg Fill Price, Status, Type, and the
       order's own price columns. Only filled rows are fills; the stop and
       limit orders sitting in the same file are what give a trade its R. */
    /* B/S and a contract column are Tradovate's own and nothing else here
       has them, so a file is never claimed by two sources. The quantity
       column is named differently in the Fills report and the orders panel,
       and both are accepted. */
    need: [["bs", "buysell"], ["contract", "product"],
           ["quantity", "qty", "filledqty", "fillqty", "filledquantity"]],
    fills(rows) {
      const out = [];
      for (const r of rows) {
        const status = (pick(r, ["status"]) || "filled").toLowerCase();
        if (!status.includes("fill")) continue;
        const qty = num(pick(r, ["filledqty", "fillqty", "filledquantity",
                                 "qty", "quantity"]));
        // The Fills report has no status column at all: every row in it is a
        // fill. The orders panel export has one, and only "Filled" counts.
        const price = num(pick(r, ["avgfillprice", "avgprice", "fillprice",
                                   "price"]));
        const when = stamp(pick(r, ["date", "tradedate"]),
                           pick(r, ["filltime", "timestamp", "time", "datetime"]));
        const raw = pick(r, ["product", "contract", "symbol"]);
        const side = String(pick(r, ["bs", "buysell", "side"]) || "").trim();
        if (!qty || price === null || !when || !raw) continue;
        out.push({
          "Symbol": rootSymbol(raw),
          "Side": BUY.test(side) ? "buy" : SELL.test(side) ? "sell" : side.toLowerCase(),
          "Fill price": String(price),
          "Quantity": String(qty),
          "Closing time": when,
          "Type": pick(r, ["type", "ordertype"]) || "",
          "Stop price": pick(r, ["stopprice", "stoppx", "stop"]) || "",
          "Limit price": pick(r, ["limitprice", "limitpx", "limit"]) || "",
          "Commission": pick(r, ["commission", "fees", "fee"]) || "",
        });
      }
      return out;
    },
    /**
     * The stops and targets this export carries, in the shape TradingView's
     * activity log produces, so R is measured by exactly the same code.
     *
     * A stop order placed on a position IS the risk taken at entry, and the
     * broker keeps every one of them, filled or cancelled when the target
     * came first. TradingView's activity log reaches back about an hour;
     * this reaches back as far as the export does.
     */
    moves(rows) {
      const out = [];
      for (const r of rows) {
        const type = String(pick(r, ["type", "ordertype"]) || "").toLowerCase();
        const sl = num(pick(r, ["stopprice", "stoppx", "stop"]));
        const tp = num(pick(r, ["limitprice", "limitpx", "limit"]));
        const isStop = type.includes("stop") && sl !== null;
        const isTarget = type.includes("limit") && !type.includes("stop") && tp !== null;
        if (!isStop && !isTarget) continue;
        const when = stamp(pick(r, ["date", "tradedate"]),
                           pick(r, ["placingtime", "timestamp", "time",
                                    "filltime", "datetime"]));
        const raw = pick(r, ["product", "contract", "symbol"]);
        if (!when || !raw) continue;
        out.push({t: when, symbol: rootSymbol(raw),
                  sl: isStop ? sl : null, tp: isTarget ? tp : null});
      }
      // Oldest first, so the FIRST stop of a trade is the one set at entry.
      out.sort((a, b) => (a.t < b.t ? -1 : 1));
      return out;
    },
  },
];

/* Tradovate's Account Balance History: one row a day, the account's own
   closing balance and what it realised. This is the record the firm's
   trailing drawdown is measured against, and it is net of every fee, which a
   pile of fills can only estimate. */
SOURCES.push({
  id: "tradovate-balance",
  name: "Tradovate account balance history",
  need: [["accountname", "accountid"], ["tradedate"], ["totalamount"]],
  fills: () => [],
  balances(rows) {
    const out = [];
    for (const r of rows) {
      const date = String(pick(r, ["tradedate", "date"]) || "").trim();
      const amount = num(pick(r, ["totalamount", "balance", "netliq"]));
      if (!/^\d{4}-\d{2}-\d{2}/.test(date) || amount === null) continue;
      out.push({date: date.slice(0, 10), amount,
                realized: num(pick(r, ["totalrealizedpnl", "realizedpnl"])),
                account: String(pick(r, ["accountname", "accountid"]) || "")});
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  },
});

/** Which export this file is, by its columns alone. */
export function sniff(headers) {
  const has = new Set((headers || []).map(norm));
  for (const s of SOURCES)
    if (s.need.every(group => group.some(n => has.has(n)))) return s;
  return null;
}

/**
 * Read every file the app was given, and return what the engine needs.
 *
 * @param files    [{name, text}]
 * @param parseCSV the app's own CSV reader, passed in so this module stays
 *                 free of the engine and can be tested on its own
 * @returns {fills, moves, spans, found}. `spans` are the stretches these files
 *          can vouch for, so a trade outside them is honestly marked as having
 *          no stop on record rather than being given the wrong one.
 */
export function readAny(files, parseCSV) {
  const fills = [], moves = [], spans = [], found = [], balances = [];
  for (const f of files || []) {
    const rows = parseCSV(f.text || "");
    if (!rows.length) continue;
    const source = sniff(Object.keys(rows[0]));
    // TradingView's own files are read by the engine, which de-duplicates
    // them on order id. Reading them here as well would double every trade.
    if (!source || source.id === "tradingview-orders") continue;
    const lower = rows.map(r => {
      const o = {};
      for (const k of Object.keys(r)) o[norm(k)] = r[k];
      return o;
    });
    if (source.balances) {
      const days = source.balances(lower);
      if (days.length) {
        balances.push(...days);
        found.push({file: f.name, source: source.id, name: source.name,
                    days: days.length});
      }
      continue;
    }
    const got = source.fills(lower);
    if (!got.length) continue;
    fills.push(...got);
    const stops = source.moves ? source.moves(lower) : [];
    moves.push(...stops);
    found.push({file: f.name, source: source.id, name: source.name,
                fills: got.length, stops: stops.length});
    /* A broker's own export is complete for the period it covers, so every
       trade inside it can be judged. TradingView's activity log cannot say
       that, which is the whole reason spans exist. */
    const times = got.map(g => g["Closing time"]).filter(Boolean).sort();
    if (times.length) spans.push([times[0], times[times.length - 1]]);
  }
  fills.sort((a, b) => (a["Closing time"] < b["Closing time"] ? -1 : 1));
  balances.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {fills, moves, spans, found, balances};
}
