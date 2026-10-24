// Reads best-before dates and product names from a photo: Tesseract (in Node, no system packages)
// finds the text, then findDates() picks out the dates (Dutch and English month names and labels)
// and nameLines() the biggest lines of words, which on a pack is usually the product name.
const path = require("path");

const MONTHS = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, mrt: 3, maa: 3, maart: 3, march: 3,
  apr: 4, april: 4, may: 5, mei: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, augustus: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, okt: 10, oktober: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "mrt", "mei", "okt"];
// Words printed before a best-before date (Dutch, English, German, French)
const LABEL_RE = /(THT|TGT|BEST|BB|BBE|EXP|USE ?BY|HOUDBAAR|GEBRUIKEN|MHD|DLC|DDM|BEFORE|TOT|VERBRUIK)/;

// One wrong letter is a common OCR slip ("OCR" for OCT); only allowed for 3-letter abbreviations
function monthOf(word) {
  const w = word.toLowerCase();
  if (MONTHS[w]) return MONTHS[w];
  if (w.length !== 3) return 0;
  const near = ABBR.filter((a) => [...a].filter((c, i) => c !== w[i]).length === 1);
  return near.length === 1 ? MONTHS[near[0]] : 0;
}
const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(y, m, 0).getDate();
function makeDate(y, m, d) {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= lastDay(y, m))) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function findDates(raw, today = new Date()) {
  // In groups that contain a digit, read O as 0, I/l/| as 1, S as 5 and B as 8
  raw = String(raw).replace(/\s+/g, " ");
  const text = raw.toUpperCase().replace(/[0-9OIL|SB]+/g, (t) => (/\d/.test(t) ? t.replace(/O/g, "0").replace(/[IL|]/g, "1").replace(/S/g, "5").replace(/B/g, "8") : t));
  const found = new Map();
  const min = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate());
  const max = new Date(today.getFullYear() + 12, 11, 31);
  const covered = []; // where full dates were found, so "MEI 2027" inside "15 MEI 2027" isn't counted again
  const add = (iso, at, len, exact) => {
    if (!iso) return;
    if (exact) covered.push([at, at + len]);
    else if (covered.some(([s, e]) => at < e && at + len > s)) return;
    const [y, m, d] = iso.split("-").map(Number), date = new Date(y, m - 1, d);
    if (date < min || date > max) return;
    const before = text.slice(Math.max(0, at - 30), at);
    const score = (LABEL_RE.test(before) ? 10 : 0) + (date >= today ? 3 : 0) + (exact ? 1 : 0);
    const prev = found.get(iso);
    if (!prev || prev.score < score) found.set(iso, { expiry: iso, text: raw.slice(at, at + len).trim(), score });
  };
  const each = (re, fn) => { for (const m of text.matchAll(re)) fn(m); };
  const S = "\\s?[.\\-/]\\s?|\\s"; // a separator: . - / or a space
  // 2027-05-12
  each(new RegExp(`(?<!\\d)(20\\d\\d)(?:${S})(\\d{1,2})(?:${S})(\\d{1,2})(?!\\d)`, "g"), (m) => add(makeDate(+m[1], +m[2], +m[3]), m.index, m[0].length, true));
  // 12.05.2027, 12-05-27, 12/05/2027 (day first; month first only when the day can't be a month)
  each(new RegExp(`(?<![\\d:])(\\d{1,2})(?:${S})(\\d{1,2})(?:${S})(\\d{4}|\\d{2})(?![\\d:])`, "g"), (m) => {
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    add(makeDate(+m[3], mo, d), m.index, m[0].length, true);
  });
  // 15 MEI 2027, 28OCT26
  each(/(?<!\d)(\d{1,2})[\s.\-/]?([A-Z]{3,9})\.?[\s.\-/]?(\d{4}|\d{2})(?!\d)/g, (m) => {
    const mo = monthOf(m[2]); if (mo) add(makeDate(+m[3], mo, +m[1]), m.index, m[0].length, true);
  });
  // MEI 2027, OCT 26: the end of that month
  each(/(?<![A-Z\d])([A-Z]{3,9})\.?[\s.\-/]?(20\d\d|\d{2})(?!\d)/g, (m) => {
    const mo = monthOf(m[1]); if (!mo) return;
    const y = +m[2] < 100 ? +m[2] + 2000 : +m[2];
    add(makeDate(y, mo, lastDay(y, mo)), m.index, m[0].length, false);
  });
  // 08/2027, 08-27 after a label: the end of that month
  each(/(?<![\d.\-/:])(\d{1,2})[.\-/](20\d\d)(?![\d.\-/])/g, (m) => {
    const y = +m[2], mo = +m[1]; if (mo >= 1 && mo <= 12) add(makeDate(y, mo, lastDay(y, mo)), m.index, m[0].length, false);
  });
  return [...found.values()].sort((a, b) => b.score - a.score || a.expiry.localeCompare(b.expiry)).slice(0, 4).map(({ expiry, text, score }) => ({ expiry, text, label: score >= 10 }));
}

// One Tesseract worker, started on first use and stopped after 10 idle minutes to free memory.
// Photos are read one at a time.
let worker = null, idle = null, queue = Promise.resolve();
async function getWorker() {
  if (!worker) {
    const { createWorker, PSM } = require("tesseract.js");
    const eng = require("@tesseract.js-data/eng");
    worker = createWorker("eng", 1, { langPath: path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int"), gzip: eng.gzip, cacheMethod: "none" })
      .then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }); return w; })
      .catch((e) => { worker = null; throw e; });
  }
  return worker;
}
// The lines of words on the pack, biggest print first. Lines that are mostly digits, a date,
// a weight or too unsure are left out. ALL CAPS becomes Title Case.
function nameLines(data) {
  const out = [], seen = new Set();
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    let text = l.text.replace(/[^\p{L}\p{N}&'’\-.,% ]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^[\-.,]+|[\-.,]+$/g, "").trim();
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 3 || letters / text.replace(/\s/g, "").length < 0.6 || l.confidence < 55) continue;
    if (findDates(text).length || /^\d+([.,]\d+)?\s?(g|kg|ml|cl|l|ltr|liter|gram|stuks|pcs)\b/i.test(text)) continue;
    if (text === text.toUpperCase()) text = text.toLowerCase().replace(/(^|[\s\-])(\p{L})/gu, (m, a, c) => a + c.toUpperCase());
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: text.slice(0, 80), size: l.bbox.y1 - l.bbox.y0, confidence: Math.round(l.confidence) });
  }
  return out.sort((a, b) => b.size - a.size).slice(0, 5);
}

function recognize(image) {
  const job = queue.then(async () => {
    clearTimeout(idle);
    const w = await getWorker();
    const { data } = await w.recognize(image, {}, { text: true, blocks: true });
    idle = setTimeout(() => { const old = worker; worker = null; old?.then((x) => x.terminate()).catch(() => {}); }, 10 * 60e3);
    idle.unref?.();
    return data;
  });
  queue = job.catch(() => {});
  return job;
}
async function readDates(image) {
  const data = await recognize(image);
  return { dates: findDates(data.text), text: data.text.replace(/\s+/g, " ").trim().slice(0, 200) };
}
async function readName(image) {
  return { names: nameLines(await recognize(image)) };
}

module.exports = { findDates, readDates, readName };
