// Pantry Shelf: a small self-hosted server, Node 20+.
// Serves ./public and a JSON API backed by JSON files in DATA_DIR.
// Also sends daily expiry reminders (email, phone push) and writes nightly backups.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const env = process.env;
const PORT = Number(env.PORT || 3000);
const DATA_DIR = env.DATA_DIR || path.join(__dirname, "data");
const BACKUP_DIR = env.BACKUP_DIR || path.join(__dirname, "backups");
const PASSWORD = env.PANTRY_PASSWORD || "";
const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const APP_URL = (env.APP_URL || "").replace(/\/+$/, "");
const OFF_URL = (env.OFF_URL || "https://world.openfoodfacts.org").replace(/\/+$/, "");
const MEALDB_URL = (env.MEALDB_URL || "https://www.themealdb.com").replace(/\/+$/, "");
const REMINDER_SKIP_EMPTY = (env.REMINDER_SKIP_EMPTY || "true") !== "false";
const BACKUP_TIME = env.BACKUP_TIME || "02:30";
const BACKUP_KEEP_DAYS = Number(env.BACKUP_KEEP_DAYS || 30);
const PUBLIC = path.join(__dirname, "public");
const COOKIE = "pantry_session";
const YEAR = 365 * 24 * 3600;
const UA = "PantryShelf/2.0 (self-hosted pantry app)";
const HOUSEHOLD = { id: "h", name: "Household" };

if (!PASSWORD) console.warn("PANTRY_PASSWORD is not set: the app is open to anyone who can reach it.");
if (!env.SESSION_SECRET) console.warn("SESSION_SECRET is not set: everyone is logged out when the server restarts.");

// ---------- storage: one JSON file per collection, written atomically ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
function jsonFile(name, key) {
  const file = path.join(DATA_DIR, name);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8"))[key] || {}; } catch (e) { if (e.code !== "ENOENT") throw e; }
  let writing = Promise.resolve();
  return {
    get data() { return data; },
    set data(v) { data = v; },
    save() {
      const body = JSON.stringify({ [key]: data }, null, 1);
      writing = writing.then(async () => {
        await fsp.writeFile(file + ".tmp", body);
        await fsp.rename(file + ".tmp", file);
      }).catch((e) => console.error(`Could not save ${name}:`, e));
      return writing;
    },
    flushed: () => writing,
  };
}
const itemsDb = jsonFile("items.json", "items");        // label code -> item
const shoppingDb = jsonFile("shopping.json", "list");   // id -> {name, done, addedAt}
const productsDb = jsonFile("products.json", "products"); // barcode -> {name, unit, place, source}
const metaDb = jsonFile("meta.json", "meta");           // lastReminder, lastBackup, cover
const settingsDb = jsonFile("settings.json", "settings"); // reminder and backup settings edited in the app
const usersDb = jsonFile("users.json", "users");        // id -> {name, salt, hash, gen, createdAt}
const historyDb = jsonFile("history.json", "history");  // id -> {item, name, qty, unit, place, outcome, by, at}
const pushDb = jsonFile("push.json", "subs");            // id -> {sub, by, ua, createdAt}
const ALL_DBS = [itemsDb, shoppingDb, productsDb, metaDb, settingsDb, usersDb, historyDb, pushDb];
const COVER_FILE = path.join(DATA_DIR, "cover.jpg");
const AVATAR_DIR = path.join(DATA_DIR, "avatars"); // one small JPEG per person, named by their id
fs.mkdirSync(AVATAR_DIR, { recursive: true });
// Emoji someone can pick instead of a photo
const AVATAR_EMOJI = ["🍅", "🥕", "🧀", "🍞", "🥑", "🍋", "🍇", "🍓", "🥦", "🌶️", "🍄", "🥚", "🍌", "🍉", "🥥", "🍯", "🍪", "🧁", "☕", "🐱", "🐶", "🌻", "⭐", "🏠"];
let version = Date.now();
const bump = () => (version = Date.now());

// ---------- auth ----------
// Everyone can log in with the household password, or with their own name and password
// (added in Settings > People) so the history shows who used what.
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
function makeToken(user) { const v = `v2.${user.id}.${user.id === "h" ? 0 : user.gen || 0}.${Date.now()}`; return `${v}.${sign(v)}`; }
function tokenUser(t) {
  if (!t) return null;
  const i = t.lastIndexOf("."); if (i < 0) return null;
  const v = t.slice(0, i), s = t.slice(i + 1), want = sign(v);
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  const [ver, id, gen] = v.split(".");
  if (ver === "v1" || id === "h") return PASSWORD ? HOUSEHOLD : null; // version 1 logins count as the household
  const u = usersDb.data[id];
  if (!u || String(u.gen || 0) !== gen) return null; // removed, or password changed since
  return { id, name: u.name };
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) { const [k, ...v] = part.trim().split("="); if (k) out[k] = decodeURIComponent(v.join("=")); }
  return out;
}
const openMode = () => !PASSWORD && !Object.keys(usersDb.data).length;
const whoIs = (req) => (openMode() ? HOUSEHOLD : tokenUser(cookies(req)[COOKIE]));
const authed = (req) => !!whoIs(req);
const loginAttempts = new Map(); // ip -> {n, until}
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) { return { salt, hash: crypto.scryptSync(pw, salt, 32).toString("hex") }; }
function passwordMatches(pw, u) {
  const got = crypto.scryptSync(pw, u.salt, 32), want = Buffer.from(u.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sameText = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const findUser = (name) => Object.entries(usersDb.data).find(([, u]) => u.name.toLowerCase() === String(name).trim().toLowerCase());
function cleanPerson(body) {
  const name = str(body.name, 30);
  if (!name) return { error: "Type a name." };
  if (name.toLowerCase() === "household") return { error: "Pick another name." };
  if (typeof body.password !== "string" || body.password.length < 6) return { error: "Use a password of at least 6 characters." };
  return { name, password: body.password.slice(0, 200) };
}

// ---------- validation ----------
const ID_RE = /^[2-9A-HJ-NP-Z]{6}$/;
const LIST_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BARCODE_RE = /^\d{8,14}$/;
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanItem(body) {
  const qty = Number(body.qty);
  const by = str(body.addedBy, 30);
  const out = {
    name: str(body.name, 80), qty: Number.isFinite(qty) && qty >= 0 ? qty : 1, unit: str(body.unit, 20), place: str(body.place, 30),
    expiry: str(body.expiry, 10), addedAt: Number(body.addedAt) || Date.now(), updatedAt: Date.now(),
  };
  if (by) out.addedBy = by;
  const bc = str(body.barcode, 14);
  if (BARCODE_RE.test(bc)) out.barcode = bc;
  if (!out.name || !DATE_RE.test(out.expiry)) return null;
  return out;
}
function cleanEntry(body) {
  const name = str(body.name, 80);
  if (!name) return null;
  return { name, done: !!body.done, addedAt: Number(body.addedAt) || Date.now(), updatedAt: Date.now() };
}

// ---------- dates in the server's time zone (TZ) ----------
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function daysLeft(expiry, now = new Date()) {
  const [y, m, d] = expiry.split("-").map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}
const sortedItems = () => Object.entries(itemsDb.data).map(([id, it]) => ({ id, ...it, days: daysLeft(it.expiry) })).sort((a, b) => a.days - b.days);

// ---------- outbound http ----------
async function getJson(url, ms = 8000) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

// ---------- barcode lookup (own memory first, then Open Food Facts) ----------
const offCache = new Map(); // barcode -> {at, value}
async function lookupBarcode(code) {
  const own = productsDb.data[code];
  if (own) return { ...own, barcode: code, source: "pantry" };
  const hit = offCache.get(code);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.value;
  let value = null;
  const data = await getJson(`${OFF_URL}/api/v2/product/${code}.json?fields=product_name,product_name_en,generic_name,brands,quantity`);
  const p = data && data.status === 1 && data.product;
  if (p) {
    const name = str(p.product_name || p.product_name_en || p.generic_name || "", 80);
    const brand = str((p.brands || "").split(",")[0] || "", 40);
    if (name) value = { barcode: code, name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name, quantity: str(p.quantity || "", 30), source: "openfoodfacts" };
  }
  offCache.set(code, { at: Date.now(), value });
  return value;
}
function rememberProduct(item) {
  if (!item.barcode) return;
  productsDb.data[item.barcode] = { name: item.name, unit: item.unit, place: item.place, updatedAt: Date.now() };
  productsDb.save();
}

// ---------- recipe ideas (TheMealDB, by the items that expire first) ----------
const mealCache = new Map(); // ingredient -> {at, meals}
async function mealsWith(ingredient) {
  const hit = mealCache.get(ingredient);
  if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.meals;
  const data = await getJson(`${MEALDB_URL}/api/json/v1/1/filter.php?i=${encodeURIComponent(ingredient)}`);
  const meals = (data && data.meals) || [];
  mealCache.set(ingredient, { at: Date.now(), meals });
  return meals;
}
// "Basmati rice (Tilda)" -> ["basmati_rice", "rice", "basmati"]
function ingredientGuesses(name) {
  const words = name.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const out = [];
  if (words.length > 1) out.push(words.join("_"));
  if (words.length > 2) out.push(words.slice(-2).join("_"));
  for (const w of [...words].reverse()) out.push(w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w);
  return [...new Set(out)].slice(0, 4);
}
async function recipeIdeas() {
  const pool = sortedItems().filter((it) => it.days >= -1).slice(0, 8);
  const meals = new Map(); // id -> {id, name, thumb, url, uses:Set, score}
  const used = [];
  for (const it of pool) {
    for (const guess of ingredientGuesses(it.name)) {
      let found;
      try { found = await mealsWith(guess); } catch (e) { console.error("Recipe lookup failed:", e.message); return { error: "Couldn't reach the recipe site. Try again later.", ideas: [] }; }
      if (!found.length) continue;
      used.push({ item: it.name, ingredient: guess.replace(/_/g, " ") });
      const weight = 1 + Math.max(0, 30 - it.days) / 10; // sooner expiry counts more
      for (const m of found) {
        const e = meals.get(m.idMeal) || { id: m.idMeal, name: m.strMeal, thumb: m.strMealThumb, url: `${MEALDB_URL}/meal/${m.idMeal}`, uses: new Set(), score: 0 };
        if (!e.uses.has(it.name)) { e.uses.add(it.name); e.score += weight; }
        meals.set(m.idMeal, e);
      }
      break;
    }
  }
  const ideas = [...meals.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 12)
    .map((m) => ({ ...m, uses: [...m.uses], score: undefined }));
  return { ideas, matched: used, checked: pool.map((p) => p.name) };
}

// ---------- history: what was added, used and thrown away, and by whom ----------
const HISTORY_MAX = 5000;
const COUNTABLE = new Set(["pcs", "cans", "jars", "packs", "bottles", "boxes", "bags"]);
function logEvent(item, outcome, qty, by) {
  historyDb.data[crypto.randomUUID()] = { name: item.name, qty, unit: item.unit || "", place: item.place || "Pantry", outcome, by: by.name, at: Date.now() };
  const keys = Object.keys(historyDb.data);
  if (keys.length > HISTORY_MAX) {
    keys.sort((a, b) => historyDb.data[a].at - historyDb.data[b].at);
    for (const k of keys.slice(0, keys.length - HISTORY_MAX)) delete historyDb.data[k];
  }
  return historyDb.save();
}
// "3 cans" counts as 3; "0.5 kg" counts as one thing
const amount = (e) => (COUNTABLE.has(e.unit) && e.qty > 0 ? e.qty : 1);
const monthKey = (t) => isoDay(new Date(t)).slice(0, 7);
function historySummary() {
  const events = Object.entries(historyDb.data).map(([id, e]) => ({ ...e, id })).sort((a, b) => b.at - a.at);
  const now = new Date(), months = [];
  for (let i = 5; i >= 0; i--) months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, used: 0, wasted: 0 }]));
  const wasted = new Map(), people = new Map(), thisMonth = months[months.length - 1];
  for (const e of events) {
    const m = monthKey(e.at);
    if (byMonth[m] && (e.outcome === "used" || e.outcome === "wasted")) byMonth[m][e.outcome] += amount(e);
    if (e.outcome === "wasted" && byMonth[m]) {
      const k = e.name.toLowerCase(), w = wasted.get(k) || { name: e.name, count: 0 };
      w.count += amount(e); wasted.set(k, w);
    }
    if (m === thisMonth) {
      const p = people.get(e.by) || { name: e.by, added: 0, used: 0, wasted: 0 };
      p[e.outcome] = (p[e.outcome] || 0) + (e.outcome === "added" ? 1 : amount(e)); people.set(e.by, p);
    }
  }
  return {
    months: months.map((m) => byMonth[m]),
    topWasted: [...wasted.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
    recent: events.slice(0, 20),
  };
}

// ---------- reminders ----------
// Settings saved in the app win; .env only gives the starting values.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function reminderSettings() {
  const s = settingsDb.data, pick = (k, d) => (s[k] !== undefined ? s[k] : d);
  return {
    enabled: pick("enabled", true),
    time: pick("time", TIME_RE.test(env.REMINDER_TIME || "") ? env.REMINDER_TIME : "08:00"),
    days: pick("days", Number(env.REMINDER_DAYS) || 7),
    // How often: every day, once a week on `weekday` (0 = Sunday), or once a month on `monthday`
    frequency: pick("frequency", ["weekly", "monthly"].includes(env.REMINDER_FREQUENCY) ? env.REMINDER_FREQUENCY : "daily"),
    weekday: pick("weekday", 1),
    monthday: pick("monthday", 1),
    mailTo: pick("mailTo", env.MAIL_TO || ""),
    smtpHost: pick("smtpHost", env.SMTP_HOST || "smtp.gmail.com"),
    smtpPort: pick("smtpPort", Number(env.SMTP_PORT) || 587),
    smtpUser: pick("smtpUser", env.SMTP_USER || ""),
    smtpPass: pick("smtpPass", env.SMTP_PASS || ""),
    mailFrom: pick("mailFrom", env.MAIL_FROM || ""),
  };
}
const emailReady = (r = reminderSettings()) => !!(r.smtpHost && r.mailTo && r.smtpUser && r.smtpPass);
function channelsNow() {
  const r = reminderSettings();
  return {
    ntfy: !!env.NTFY_URL,
    telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    email: emailReady(r),
    push: Object.keys(pushDb.data).length > 0,
  };
}
const activeChannels = () => { const c = channelsNow(); return Object.keys(c).filter((k) => c[k]); };
function saveReminderSettings(body) {
  const cur = reminderSettings(), next = {};
  next.enabled = body.enabled === undefined ? cur.enabled : !!body.enabled;
  next.time = body.time === undefined ? cur.time : String(body.time);
  if (!TIME_RE.test(next.time)) return "Pick a time like 08:00.";
  next.frequency = body.frequency === undefined ? cur.frequency : String(body.frequency);
  if (!["daily", "weekly", "monthly"].includes(next.frequency)) return "Pick every day, once a week or once a month.";
  next.weekday = body.weekday === undefined ? cur.weekday : Number(body.weekday);
  if (!Number.isInteger(next.weekday) || next.weekday < 0 || next.weekday > 6) return "Pick a day of the week.";
  next.monthday = body.monthday === undefined ? cur.monthday : Number(body.monthday);
  if (!Number.isInteger(next.monthday) || next.monthday < 1 || next.monthday > 31) return "Pick a day of the month.";
  next.days = body.days === undefined ? cur.days : Number(body.days);
  if (!Number.isInteger(next.days) || next.days < 1 || next.days > 60) return "Days ahead must be between 1 and 60.";
  const list = (body.mailTo === undefined ? cur.mailTo : String(body.mailTo)).split(/[,;\s]+/).filter(Boolean);
  if (list.length > 10) return "Up to 10 email addresses.";
  const bad = list.find((a) => !EMAIL_RE.test(a));
  if (bad) return `"${bad.slice(0, 60)}" isn't an email address.`;
  next.mailTo = list.join(", ");
  next.smtpUser = body.smtpUser === undefined ? cur.smtpUser : str(body.smtpUser, 120);
  if (next.smtpUser && !EMAIL_RE.test(next.smtpUser)) return "The sending account must be an email address.";
  next.smtpHost = body.smtpHost === undefined ? cur.smtpHost : str(body.smtpHost, 120);
  if (!/^[a-z0-9.-]+$/i.test(next.smtpHost)) return "The mail server name looks wrong.";
  next.smtpPort = body.smtpPort === undefined ? cur.smtpPort : Number(body.smtpPort);
  if (![25, 465, 587, 2525].includes(next.smtpPort)) return "Mail server port must be 587, 465, 25 or 2525.";
  // An empty password field means "keep the saved one"; spaces from Google's display are removed
  const pass = typeof body.smtpPass === "string" ? body.smtpPass.replace(/\s+/g, "") : "";
  next.smtpPass = pass ? pass.slice(0, 200) : cur.smtpPass;
  next.mailFrom = next.smtpUser;
  settingsDb.data = { ...settingsDb.data, ...next };
  mailer = null; // reconnect with the new account on the next send
  return null;
}
function reminderText() {
  const list = sortedItems();
  const expired = list.filter((i) => i.days < 0);
  const DAYS = reminderSettings().days;
  const soon = list.filter((i) => i.days >= 0 && i.days <= DAYS);
  const when = (d) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
  const line = (i) => `- ${i.name} (${i.qty} ${i.unit || ""}`.trimEnd() + `, ${i.place || "Pantry"}): ${i.days < 0 ? `expired ${-i.days} day${i.days === -1 ? "" : "s"} ago` : when(i.days)}`;
  const parts = [];
  if (expired.length) parts.push(`Expired:\n${expired.map(line).join("\n")}`);
  if (soon.length) parts.push(`Use within ${DAYS} days:\n${soon.map(line).join("\n")}`);
  const count = expired.length + soon.length;
  const bits = [soon.length && `${soon.length} to use soon`, expired.length && `${expired.length} expired`].filter(Boolean);
  const title = count ? `Pantry: ${bits.join(", ")}` : "Pantry: nothing expiring soon";
  let body = parts.length ? parts.join("\n\n") : `Nothing expires in the next ${DAYS} days.`;
  if (APP_URL) body += `\n\nOpen the shelf: ${APP_URL}`;
  const first = [...expired, ...soon].map((i) => i.name);
  const short = count ? `${first.slice(0, 4).join(", ")}${first.length > 4 ? ` and ${first.length - 4} more` : ""}` : `Nothing expires in the next ${DAYS} days.`;
  return { title, body, short, count };
}
async function sendNtfy({ title, body, count }) {
  const headers = { Title: title.replace(/[^\x20-\x7e]/g, ""), Tags: count ? "hourglass_flowing_sand" : "white_check_mark", "User-Agent": UA };
  if (APP_URL) headers.Click = APP_URL;
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  const res = await fetch(env.NTFY_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}
async function sendTelegram({ title, body }) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${title}\n\n${body}`, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
let mailer = null;
async function sendEmail({ title, body, html, attachments }) {
  const r = reminderSettings();
  if (!mailer) {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({ host: r.smtpHost, port: r.smtpPort, secure: r.smtpPort === 465, auth: { user: r.smtpUser, pass: r.smtpPass } });
  }
  const from = r.mailFrom || r.smtpUser;
  try {
    await mailer.sendMail({ from: `Pantry Shelf <${from}>`, to: r.mailTo, subject: title, text: body, html, attachments });
  } catch (e) {
    if (e.code === "EAUTH") throw new Error("The mail account or app password was refused. Check them in Settings.");
    throw e;
  }
}
// Phone notifications (Web Push). The server makes its own keys on first use and keeps them in DATA_DIR.
let webpush = null;
function pushLib() {
  if (webpush) return webpush;
  const lib = require("web-push"), file = path.join(DATA_DIR, "vapid.json");
  let keys;
  try { keys = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { keys = lib.generateVAPIDKeys(); fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 }); }
  const subject = /^https:\/\//.test(APP_URL) ? APP_URL : `mailto:${reminderSettings().smtpUser || "pantry-shelf@example.com"}`;
  lib.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  lib.publicKey = keys.publicKey;
  return (webpush = lib);
}
async function sendPush({ title, short }, only) {
  const lib = pushLib(), payload = JSON.stringify({ title, body: short, url: "/" });
  const targets = Object.entries(pushDb.data).filter(([id]) => !only || id === only);
  let ok = 0, lastErr = null, changed = false;
  for (const [id, s] of targets) {
    try { await lib.sendNotification(s.sub, payload, { TTL: 12 * 3600 }); ok++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { delete pushDb.data[id]; changed = true; } // phone unsubscribed
      else lastErr = e;
    }
  }
  if (changed) await pushDb.save();
  if (!ok && targets.length) throw new Error(lastErr ? `The push service refused it (${lastErr.statusCode || lastErr.message}).` : "This phone's notifications were switched off. Turn them on again.");
  return ok;
}
async function sendReminder({ force = false } = {}) {
  const msg = reminderText();
  if (!force && !msg.count && REMINDER_SKIP_EMPTY) return { sent: [], skipped: "nothing expiring" };
  const sent = [], failed = [], channels = channelsNow();
  for (const [name, fn] of [["ntfy", sendNtfy], ["telegram", sendTelegram], ["email", sendEmail], ["push", sendPush]]) {
    if (!channels[name]) continue;
    try { await fn(msg); sent.push(name); } catch (e) { console.error(`Reminder via ${name} failed:`, e.message); failed.push({ channel: name, error: e.message }); }
  }
  return { sent, failed };
}

// ---------- backups ----------
let backupDirOk = false;
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.accessSync(BACKUP_DIR, fs.constants.W_OK); backupDirOk = true; }
catch (e) { console.warn(`Backups are off: can't write to ${BACKUP_DIR} (${e.code}).`); }
const snapshot = () => ({ app: "pantry-shelf", version: 2, exportedAt: new Date().toISOString(), items: itemsDb.data, shopping: shoppingDb.data, products: productsDb.data, history: historyDb.data });
const BACKUP_RE = /^pantry-[\w-]+\.json$/;
async function writeBackup(name) {
  const file = path.join(BACKUP_DIR, name);
  await fsp.writeFile(file + ".tmp", JSON.stringify(snapshot(), null, 1));
  await fsp.rename(file + ".tmp", file);
  return file;
}
async function runBackup() {
  const file = await writeBackup(`pantry-${isoDay(new Date())}.json`);
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400e3;
  for (const f of await fsp.readdir(BACKUP_DIR)) {
    if (!BACKUP_RE.test(f)) continue;
    const st = await fsp.stat(path.join(BACKUP_DIR, f));
    if (st.mtimeMs < cutoff) await fsp.unlink(path.join(BACKUP_DIR, f));
  }
  return file;
}
async function listBackups() {
  if (!backupDirOk) return [];
  const out = [];
  for (const f of await fsp.readdir(BACKUP_DIR)) {
    if (!BACKUP_RE.test(f)) continue;
    const st = await fsp.stat(path.join(BACKUP_DIR, f));
    out.push({ file: f, at: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.at - a.at);
}
// When the weekly summary goes out: a weekday (0 = Sunday) and a time, set in Settings > Backups
const summarySchedule = () => ({
  summaryDay: Number.isInteger(settingsDb.data.summaryDay) ? settingsDb.data.summaryDay : 0,
  summaryTime: TIME_RE.test(settingsDb.data.summaryTime || "") ? settingsDb.data.summaryTime : BACKUP_TIME,
});
async function backupStatus() {
  const sched = summarySchedule();
  if (!backupDirOk) return { enabled: false, emailCopy: !!settingsDb.data.backupEmail, emailReady: emailReady(), ...sched };
  const files = await listBackups();
  return { enabled: true, time: BACKUP_TIME, keepDays: BACKUP_KEEP_DAYS, count: files.length, latest: files[0]?.file || null, files: files.slice(0, 40),
    emailCopy: !!settingsDb.data.backupEmail, emailReady: emailReady(), lastEmailed: metaDb.data.lastBackupEmail || null, ...sched };
}
// Put a backup back. A copy of what's there now is saved first, so a restore can be undone.
async function restoreSnapshot(snap) {
  if (!snap || snap.app !== "pantry-shelf" || !snap.items || typeof snap.items !== "object") throw new Error("That isn't a Pantry Shelf backup.");
  const items = {};
  for (const [id, it] of Object.entries(snap.items)) {
    const clean = ID_RE.test(id) && it && cleanItem({ ...it, updatedAt: undefined });
    if (clean) items[id] = { ...clean, updatedAt: Number(it.updatedAt) || Date.now() };
  }
  let safety = null;
  if (backupDirOk) {
    const d = new Date();
    safety = path.basename(await writeBackup(`pantry-before-restore-${isoDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`));
  }
  itemsDb.data = items;
  if (snap.shopping && typeof snap.shopping === "object") shoppingDb.data = snap.shopping;
  if (snap.products && typeof snap.products === "object") productsDb.data = snap.products;
  if (snap.history && typeof snap.history === "object") historyDb.data = snap.history;
  await Promise.all([itemsDb.save(), shoppingDb.save(), productsDb.save(), historyDb.save()]);
  bump();
  return { items: Object.keys(items).length, safety };
}
// The weekly email: a summary to read, the same as a PDF report, and the backup file for restoring
function weeklyReport() {
  const report = require("./report");
  const day = isoDay(new Date());
  const summary = report.summarize({
    items: sortedItems(), history: historySummary(), days: reminderSettings().days,
    shopping: Object.values(shoppingDb.data).filter((e) => !e.done).sort((a, b) => a.addedAt - b.addedAt),
  });
  return { report, summary, day };
}
async function emailBackup() {
  if (!emailReady()) throw new Error("Set up the reminder email first (Gmail address, app password and who gets it).");
  const { report, summary, day } = weeklyReport(), opts = { day, appUrl: APP_URL };
  const bits = [summary.soon.length && `${summary.soon.length} to use soon`, summary.expired.length && `${summary.expired.length} expired`].filter(Boolean);
  await sendEmail({
    title: `Pantry this week: ${bits.length ? bits.join(", ") : `${summary.total} items, nothing urgent`}`,
    body: report.text(summary, opts),
    html: report.html(summary, opts),
    attachments: [
      { filename: `pantry-report-${day}.pdf`, content: await report.pdf(summary, opts), contentType: "application/pdf" },
      { filename: `pantry-backup-${day}.json`, content: JSON.stringify(snapshot(), null, 1), contentType: "application/json" },
    ],
  });
  metaDb.data.lastBackupEmail = day; await metaDb.save();
}

// Is today a reminder day? A month without the chosen date (say the 31st) uses its last day.
function reminderDue(rs, now) {
  if (rs.frequency === "weekly") return now.getDay() === rs.weekday;
  if (rs.frequency === "monthly") return now.getDate() === Math.min(rs.monthday, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  return true;
}

// ---------- daily scheduler (checks once a minute) ----------
async function tick() {
  const now = new Date(), day = isoDay(now), t = hhmm(now), meta = metaDb.data;
  const rs = reminderSettings();
  if (rs.enabled && reminderDue(rs, now) && t >= rs.time && meta.lastReminder !== day && activeChannels().length) {
    meta.lastReminder = day; await metaDb.save();
    const r = await sendReminder();
    console.log(`Reminder: ${r.skipped || `sent via ${r.sent.join(", ") || "nothing"}`}`);
  }
  if (t >= BACKUP_TIME && meta.lastBackup !== day && backupDirOk) {
    meta.lastBackup = day; await metaDb.save();
    try { console.log("Backup written:", await runBackup()); } catch (e) { console.error("Backup failed:", e.message); }
  }
  // Weekly summary with the PDF report and an off-machine copy of the backup
  const ws = summarySchedule();
  if (settingsDb.data.backupEmail && now.getDay() === ws.summaryDay && t >= ws.summaryTime && meta.lastBackupEmail !== day && emailReady()) {
    meta.lastBackupEmail = day; await metaDb.save();
    try { await emailBackup(); console.log("Backup emailed."); } catch (e) { console.error("Emailing the backup failed:", e.message); }
  }
}
setInterval(() => tick().catch((e) => console.error(e)), 60_000);
setTimeout(() => tick().catch((e) => console.error(e)), 5_000);

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const SECURITY = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://www.themealdb.com; media-src 'self' blob:",
  "Permissions-Policy": "camera=(self)",
};
function sessionCookie(req, user) {
  const secure = (req.headers["x-forwarded-proto"] || "") === "https" ? "; Secure" : "";
  return `${COOKIE}=${makeToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}${secure}`;
}
function send(res, status, body, headers = {}) {
  const isObj = body && typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY, ...(isObj ? { "Content-Type": "application/json" } : {}), "Cache-Control": "no-store", ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error("too large"), { tooLarge: true })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 64 * 1024) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
async function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === "/" || !path.extname(p)) p = "/index.html";
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found");
  try {
    const data = await fsp.readFile(file);
    const cache = p.startsWith("/vendor/") ? "public, max-age=31536000, immutable" : "no-cache";
    send(res, 200, data, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": cache });
  } catch { send(res, 404, "Not found"); }
}

async function api(req, res, p, me) {
  const m = (re) => p.match(re);
  let r;
  if (p === "/api/state" && req.method === "GET") return send(res, 200, { version, items: itemsDb.data, shopping: shoppingDb.data, cover: metaDb.data.cover || null, coverPos: metaDb.data.coverPos || { x: 50, y: 50 } });

  // Which part of the cover photo shows: a focus point in percent, set by dragging in Settings
  if (p === "/api/cover/position" && req.method === "PUT") {
    const b = await readBody(req), clamp = (v) => Math.min(100, Math.max(0, Math.round(Number(v))));
    if (!Number.isFinite(Number(b.x)) || !Number.isFinite(Number(b.y))) return send(res, 400, { error: "Bad position." });
    metaDb.data.coverPos = { x: clamp(b.x), y: clamp(b.y) }; await metaDb.save(); bump();
    return send(res, 200, { ok: true, coverPos: metaDb.data.coverPos });
  }

  // Cover photo for the header, uploaded from Settings (the page sends a resized JPEG)
  if (p === "/api/cover" && req.method === "POST") {
    let img;
    try { img = await readRaw(req, 4 * 1024 * 1024); } catch (e) { return send(res, 413, { error: "That photo is too large. Try a smaller one." }); }
    if (!(img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff)) return send(res, 400, { error: "That file isn't a JPEG photo." });
    await fsp.writeFile(COVER_FILE + ".tmp", img); await fsp.rename(COVER_FILE + ".tmp", COVER_FILE);
    metaDb.data.cover = Date.now(); metaDb.data.coverPos = { x: 50, y: 50 }; await metaDb.save(); bump();
    return send(res, 200, { ok: true, cover: metaDb.data.cover, coverPos: metaDb.data.coverPos });
  }
  if (p === "/api/cover" && req.method === "DELETE") {
    await fsp.unlink(COVER_FILE).catch(() => {});
    delete metaDb.data.cover; await metaDb.save(); bump();
    return send(res, 200, { ok: true, cover: null });
  }
  if (p === "/api/items" && req.method === "GET") return send(res, 200, { version, items: itemsDb.data });

  if ((r = m(/^\/api\/items\/([^/]+)$/))) {
    const id = r[1];
    if (!ID_RE.test(id)) return send(res, 400, { error: "Bad label code." });
    if (req.method === "PUT") {
      const data = cleanItem(await readBody(req));
      if (!data) return send(res, 400, { error: "Name and best-before date are required." });
      const prev = itemsDb.data[id];
      if (!prev && Object.keys(itemsDb.data).length >= 5000) return send(res, 507, { error: "The shelf is full." });
      data.addedBy = prev?.addedBy || me.name;
      data.updatedBy = me.name;
      itemsDb.data[id] = data; bump(); await itemsDb.save(); rememberProduct(data);
      if (!prev) await logEvent(data, "added", data.qty, me);
      return send(res, 200, { ok: true, item: data, version });
    }
    if (req.method === "DELETE") {
      const body = await readBody(req).catch(() => ({}));
      const gone = itemsDb.data[id];
      delete itemsDb.data[id]; bump(); await itemsDb.save();
      // What happened to what was left: eaten ("used") or thrown away ("wasted")
      if (gone && ["used", "wasted"].includes(body.outcome) && gone.qty > 0) await logEvent(gone, body.outcome, gone.qty, me);
      let entry = null;
      if (gone && body.addToShopping) {
        const already = Object.values(shoppingDb.data).some((e) => !e.done && e.name.toLowerCase() === gone.name.toLowerCase());
        if (!already) { entry = { name: gone.name, done: false, addedAt: Date.now(), updatedAt: Date.now() }; shoppingDb.data[crypto.randomUUID()] = entry; await shoppingDb.save(); }
      }
      return send(res, 200, { ok: true, version, addedToShopping: !!entry });
    }
  }

  // Took one out of a box of several: count it, keep the rest on the shelf
  if ((r = m(/^\/api\/items\/([^/]+)\/use$/)) && req.method === "POST") {
    const it = itemsDb.data[r[1]];
    if (!it) return send(res, 404, { error: "That item isn't on the shelf any more." });
    const body = await readBody(req).catch(() => ({}));
    const outcome = body.outcome === "wasted" ? "wasted" : "used";
    const take = Math.min(1, Math.max(0, +it.qty));
    it.qty = Math.max(0, Math.round((+it.qty - 1) * 1000) / 1000); it.updatedAt = Date.now(); it.updatedBy = me.name;
    bump(); await itemsDb.save();
    if (take > 0) await logEvent(it, outcome, take, me);
    return send(res, 200, { ok: true, item: it, version });
  }

  if ((r = m(/^\/api\/shopping\/([^/]+)$/))) {
    const id = r[1];
    if (id === "clear-done" && req.method === "POST") {
      for (const [k, e] of Object.entries(shoppingDb.data)) if (e.done) delete shoppingDb.data[k];
      bump(); await shoppingDb.save(); return send(res, 200, { ok: true, shopping: shoppingDb.data });
    }
    if (!LIST_ID_RE.test(id)) return send(res, 400, { error: "Bad id." });
    if (req.method === "PUT") {
      const e = cleanEntry(await readBody(req));
      if (!e) return send(res, 400, { error: "Type what to buy." });
      if (!shoppingDb.data[id] && Object.keys(shoppingDb.data).length >= 1000) return send(res, 507, { error: "The list is full." });
      shoppingDb.data[id] = e; bump(); await shoppingDb.save(); return send(res, 200, { ok: true, entry: e });
    }
    if (req.method === "DELETE") { delete shoppingDb.data[id]; bump(); await shoppingDb.save(); return send(res, 200, { ok: true }); }
  }

  if ((r = m(/^\/api\/barcode\/([^/]+)$/)) && req.method === "GET") {
    if (!BARCODE_RE.test(r[1])) return send(res, 400, { error: "That isn't a product barcode." });
    try { const product = await lookupBarcode(r[1]); return send(res, 200, { product }); }
    catch (e) { console.error("Barcode lookup failed:", e.message); return send(res, 502, { error: "Couldn't reach Open Food Facts. Type the name instead." }); }
  }

  if (p === "/api/recipes" && req.method === "GET") return send(res, 200, await recipeIdeas());

  if (p === "/api/settings" && req.method === "GET") {
    return send(res, 200, {
      reminders: (() => {
        const r = reminderSettings();
        return { channels: activeChannels(), enabled: r.enabled, time: r.time, days: r.days, frequency: r.frequency, weekday: r.weekday, monthday: r.monthday, mailTo: r.mailTo, smtpUser: r.smtpUser,
          smtpHost: r.smtpHost, smtpPort: r.smtpPort, hasPassword: !!r.smtpPass, lastSent: metaDb.data.lastReminder || null,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
      })(),
      backups: await backupStatus(),
      push: { devices: Object.keys(pushDb.data).length },
    });
  }
  if (p === "/api/settings/reminders" && req.method === "PUT") {
    const problem = saveReminderSettings(await readBody(req));
    if (problem) return send(res, 400, { error: problem });
    await settingsDb.save();
    console.log("Reminder settings changed in the app.");
    return send(res, 200, { ok: true });
  }
  if (p === "/api/reminders/test" && req.method === "POST") {
    if (!activeChannels().length) return send(res, 400, { error: "Fill in the email settings, or turn on phone notifications, first." });
    return send(res, 200, await sendReminder({ force: true }));
  }
  if (p === "/api/history" && req.method === "GET") return send(res, 200, historySummary());
  // Remove one entry, e.g. something logged while trying the app out
  const histMatch = p.match(/^\/api\/history\/([\w-]{1,64})$/);
  if (histMatch && req.method === "DELETE") {
    if (!historyDb.data[histMatch[1]]) return send(res, 404, { error: "That entry is already gone." });
    delete historyDb.data[histMatch[1]]; await historyDb.save(); bump();
    return send(res, 200, { ok: true });
  }
  // Start the history over; a backup with the old history is saved first
  if (p === "/api/history" && req.method === "DELETE") {
    let safety = null;
    if (backupDirOk) {
      const d = new Date();
      safety = path.basename(await writeBackup(`pantry-before-clear-history-${isoDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`));
    }
    historyDb.data = {}; await historyDb.save(); bump();
    console.log(`History cleared by ${me.name}.`);
    return send(res, 200, { ok: true, safety });
  }

  // ---- people: a login for each person in the household
  if (p === "/api/people" && req.method === "GET") {
    const people = Object.entries(usersDb.data).map(([id, u]) => ({ id, name: u.name, createdAt: u.createdAt, avatar: u.avatar || null })).sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, { people, me, householdPassword: !!PASSWORD, emoji: AVATAR_EMOJI });
  }
  if (p === "/api/people" && req.method === "POST") {
    const c = cleanPerson(await readBody(req));
    if (c.error) return send(res, 400, { error: c.error });
    if (findUser(c.name)) return send(res, 409, { error: `There's already someone called ${c.name}.` });
    if (Object.keys(usersDb.data).length >= 20) return send(res, 507, { error: "That's the most people the app keeps (20)." });
    const id = crypto.randomBytes(6).toString("hex");
    usersDb.data[id] = { name: c.name, ...hashPassword(c.password), gen: 1, createdAt: Date.now() };
    await usersDb.save();
    return send(res, 200, { ok: true, id });
  }
  // Avatar: a photo (the page sends a small square JPEG) or one of the emoji
  if ((r = m(/^\/api\/people\/([a-f0-9]{12})\/avatar$/))) {
    const u = usersDb.data[r[1]];
    if (!u) return send(res, 404, { error: "That person was removed." });
    const file = path.join(AVATAR_DIR, `${r[1]}.jpg`);
    if (req.method === "GET") {
      try { return send(res, 200, await fsp.readFile(file), { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" }); }
      catch { return send(res, 404, "No photo"); }
    }
    if (req.method === "PUT") {
      if ((req.headers["content-type"] || "").startsWith("image/jpeg")) {
        let img;
        try { img = await readRaw(req, 1024 * 1024); } catch { return send(res, 413, { error: "That photo is too large." }); }
        if (!(img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff)) return send(res, 400, { error: "That file isn't a JPEG photo." });
        await fsp.writeFile(file + ".tmp", img); await fsp.rename(file + ".tmp", file);
        u.avatar = { photo: Date.now() };
      } else {
        const { emoji } = await readBody(req);
        if (!AVATAR_EMOJI.includes(emoji)) return send(res, 400, { error: "Pick one of the emoji." });
        await fsp.unlink(file).catch(() => {});
        u.avatar = { emoji };
      }
      await usersDb.save();
      return send(res, 200, { ok: true, avatar: u.avatar });
    }
    if (req.method === "DELETE") {
      await fsp.unlink(file).catch(() => {});
      delete u.avatar; await usersDb.save();
      return send(res, 200, { ok: true, avatar: null });
    }
  }
  if ((r = m(/^\/api\/people\/([a-f0-9]{12})$/))) {
    const u = usersDb.data[r[1]];
    if (!u) return send(res, 404, { error: "That person was already removed." });
    if (req.method === "PUT") { // new password; logs that person out on their other phones
      const body = await readBody(req);
      const c = cleanPerson({ name: u.name, password: body.password });
      if (c.error) return send(res, 400, { error: c.error });
      Object.assign(u, hashPassword(c.password), { gen: (u.gen || 0) + 1 });
      await usersDb.save();
      const headers = r[1] === me.id ? { "Set-Cookie": sessionCookie(req, { id: r[1], gen: u.gen }) } : {};
      return send(res, 200, { ok: true }, headers);
    }
    if (req.method === "DELETE") {
      if (r[1] === me.id) return send(res, 400, { error: "You can't remove yourself. Ask someone else, or log in with the household password." });
      if (!PASSWORD && Object.keys(usersDb.data).length === 1) return send(res, 400, { error: "Keep at least one person: there's no household password to log in with." });
      delete usersDb.data[r[1]]; await usersDb.save();
      await fsp.unlink(path.join(AVATAR_DIR, `${r[1]}.jpg`)).catch(() => {});
      return send(res, 200, { ok: true });
    }
  }

  // ---- phone notifications
  if (p === "/api/push/key" && req.method === "GET") {
    try { return send(res, 200, { key: pushLib().publicKey }); }
    catch (e) { console.error("Push setup failed:", e.message); return send(res, 500, { error: "Phone notifications aren't available on this server." }); }
  }
  if (p === "/api/push" && req.method === "POST") {
    const { subscription } = await readBody(req);
    const ep = subscription && subscription.endpoint;
    if (typeof ep !== "string" || !/^https:\/\//.test(ep) || !subscription.keys?.p256dh || !subscription.keys?.auth) return send(res, 400, { error: "This browser sent a broken subscription. Try again." });
    if (Object.keys(pushDb.data).length >= 50) return send(res, 507, { error: "Too many phones signed up. Turn notifications off on an old one first." });
    const id = crypto.createHash("sha256").update(ep).digest("hex").slice(0, 24);
    pushDb.data[id] = { sub: { endpoint: ep, keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) } }, by: me.name, ua: str(req.headers["user-agent"] || "", 200), createdAt: Date.now() };
    await pushDb.save();
    return send(res, 200, { ok: true, id });
  }
  if (p === "/api/push" && req.method === "DELETE") {
    const { endpoint } = await readBody(req);
    const id = typeof endpoint === "string" && crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
    if (id && pushDb.data[id]) { delete pushDb.data[id]; await pushDb.save(); }
    return send(res, 200, { ok: true });
  }
  if (p === "/api/push/test" && req.method === "POST") {
    const { endpoint } = await readBody(req);
    const id = typeof endpoint === "string" && crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
    if (!id || !pushDb.data[id]) return send(res, 400, { error: "This phone isn't signed up. Turn notifications on first." });
    const msg = reminderText();
    try { await sendPush(msg.count ? msg : { title: "Pantry Shelf", short: "Notifications work on this phone." }, id); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  // ---- backups: restore, and the weekly emailed copy
  if (p === "/api/settings/backups" && req.method === "PUT") {
    const body = await readBody(req);
    if (body.emailCopy && !emailReady()) return send(res, 400, { error: "Set up the reminder email first, then switch this on." });
    const next = { ...settingsDb.data };
    if (body.emailCopy !== undefined) next.backupEmail = !!body.emailCopy;
    if (body.summaryDay !== undefined) {
      if (!Number.isInteger(body.summaryDay) || body.summaryDay < 0 || body.summaryDay > 6) return send(res, 400, { error: "Pick a day of the week." });
      next.summaryDay = body.summaryDay;
    }
    if (body.summaryTime !== undefined) {
      if (!TIME_RE.test(String(body.summaryTime))) return send(res, 400, { error: "Pick a time like 11:00." });
      next.summaryTime = String(body.summaryTime);
    }
    settingsDb.data = next;
    await settingsDb.save();
    return send(res, 200, { ok: true, backups: await backupStatus() });
  }
  if (p === "/api/report.pdf" && req.method === "GET") {
    const { report, summary, day } = weeklyReport();
    return send(res, 200, await report.pdf(summary, { day, appUrl: APP_URL }), { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="pantry-report-${day}.pdf"` });
  }
  if (p === "/api/backup/email" && req.method === "POST") {
    try { await emailBackup(); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/api/backup/restore" && req.method === "POST") {
    let snap;
    if ((req.headers["x-restore-file"] || "") !== "") {
      const f = String(req.headers["x-restore-file"]);
      if (!backupDirOk || !BACKUP_RE.test(f)) return send(res, 400, { error: "Pick a backup from the list." });
      try { snap = JSON.parse(await fsp.readFile(path.join(BACKUP_DIR, f), "utf8")); } catch { return send(res, 404, { error: "That backup can't be read." }); }
    } else {
      let raw;
      try { raw = await readRaw(req, 20 * 1024 * 1024); } catch { return send(res, 413, { error: "That file is too large to be a pantry backup." }); }
      try { snap = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "That file isn't a Pantry Shelf backup." }); }
    }
    try {
      const out = await restoreSnapshot(snap);
      console.log(`Restored a backup (${out.items} items) for ${me.name}.`);
      return send(res, 200, { ok: true, ...out });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/api/backup" && req.method === "GET") {
    return send(res, 200, JSON.stringify(snapshot(), null, 1), { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="pantry-${isoDay(new Date())}.json"` });
  }
  if (p === "/api/backup/run" && req.method === "POST") {
    if (!backupDirOk) return send(res, 400, { error: "Backups are off: the backup folder isn't writable." });
    await runBackup(); return send(res, 200, { ok: true, backups: await backupStatus() });
  }
  return send(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  try {
    if (p === "/healthz") return send(res, 200, { ok: true });

    if (p === "/api/login" && req.method === "POST") {
      const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
      const a = loginAttempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return send(res, 429, { error: "Too many tries. Wait a minute and try again." });
      const { name, password } = await readBody(req);
      let user = null;
      if (typeof password === "string" && password) {
        if (typeof name === "string" && name.trim()) {
          const hit = findUser(name);
          if (hit && passwordMatches(password, hit[1])) user = { id: hit[0], gen: hit[1].gen };
        } else if (PASSWORD && sameText(password, PASSWORD)) user = HOUSEHOLD;
      }
      if (!user) {
        a.n += 1; if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; }
        loginAttempts.set(ip, a);
        return send(res, 401, { error: typeof name === "string" && name.trim() ? "That name and password don't match." : "That password isn't right." });
      }
      loginAttempts.delete(ip);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, user) });
    }
    if (p === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    }
    if (p === "/api/session") { // asked before logging in
      const me = whoIs(req);
      return send(res, me ? 200 : 401, me ? { ok: true, passwordProtected: !openMode(), me } : { error: "login", hasPeople: Object.keys(usersDb.data).length > 0, householdPassword: !!PASSWORD });
    }
    if (p === "/cover.jpg" && req.method === "GET") {
      if (!authed(req)) return send(res, 401, "Log in first");
      try { return send(res, 200, await fsp.readFile(COVER_FILE), { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" }); }
      catch { return send(res, 404, "No cover photo"); }
    }
    if (p.startsWith("/api/")) {
      const me = whoIs(req);
      if (!me) return send(res, 401, { error: "login" });
      return await api(req, res, p, me);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 400, { error: "Bad request" });
  }
});

server.listen(PORT, () => {
  const on = activeChannels(), rs = reminderSettings();
  console.log(`Pantry Shelf ${require("./package.json").version} listening on :${PORT}, data in ${DATA_DIR}`);
  console.log(`Reminders: ${on.length ? `${on.join(", ")} at ${rs.time}${rs.enabled ? "" : " (switched off in Settings)"}` : "off (no channel set)"}; backups: ${backupDirOk ? `${BACKUP_DIR} at ${BACKUP_TIME}, keep ${BACKUP_KEEP_DAYS} days` : "off"}`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  server.close();
  Promise.all(ALL_DBS.map((d) => d.flushed())).finally(() => process.exit(0));
});
