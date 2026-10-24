// Pantry Shelf: a small self-hosted server, Node 20+.
// Serves ./public and a JSON API backed by JSON files in DATA_DIR.
// Several households can share one server, each with its own shelf (DATA_DIR/households/<id>);
// the first one keeps its files in DATA_DIR itself. Also sends expiry reminders (email, phone push)
// and writes nightly backups.
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
const MAIN = "main"; // the household that was there before households existed
// Who may manage the site (households, invite codes, the email account). With ADMINS set
// (login names, comma separated) only those people; otherwise the first household's people.
const ADMINS = (env.ADMINS || "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
const isAdmin = (name, flag) => (ADMINS.length ? ADMINS.includes(String(name).toLowerCase()) : !!flag);
const HOUSEHOLD = { id: "h", name: "Household", hid: MAIN, admin: !ADMINS.length }; // the household password's login
const MAX_HOUSEHOLDS = Number(env.MAX_HOUSEHOLDS || 10);
const MAX_MEMBERS = Number(env.MAX_MEMBERS || 5);
const OPEN_SIGNUP = env.OPEN_SIGNUP === "true"; // without it, a new household needs an invite code
const INVITE_DAYS = 14;

if (!PASSWORD) console.warn("PANTRY_PASSWORD is not set: the app is open to anyone who can reach it.");
if (!env.SESSION_SECRET) console.warn("SESSION_SECRET is not set: everyone is logged out when the server restarts.");

// ---------- storage: one JSON file per collection, written atomically ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
function jsonFile(file, key) {
  const name = path.relative(DATA_DIR, file);
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
// Shared by all households
const accountsDb = jsonFile(path.join(DATA_DIR, "users.json"), "users");      // id -> {name, salt, hash, gen, household, admin, createdAt, avatar}
const householdsDb = jsonFile(path.join(DATA_DIR, "households.json"), "households"); // id -> {name, createdAt}
const invitesDb = jsonFile(path.join(DATA_DIR, "invites.json"), "invites");   // code -> {createdAt, expires, by}
const siteDb = jsonFile(path.join(DATA_DIR, "site.json"), "site");            // the email account the site sends with, the time zone

// Reminder, report and backup times follow this time zone. An admin can pick it in the app
// (saved in site.json); otherwise TZ from .env, and Europe/Amsterdam if neither is set.
const ZONES = new Set(Intl.supportedValuesOf("timeZone"));
const validZone = (z) => typeof z === "string" && (ZONES.has(z) || z === "UTC");
function applyTimeZone() {
  process.env.TZ = validZone(siteDb.data.tz) ? siteDb.data.tz : validZone(env.TZ) && env.TZ !== "UTC" ? env.TZ : "Europe/Amsterdam";
}
applyTimeZone();
const timeZone = () => process.env.TZ;

// One household's files, loaded the first time it's used
const loaded = new Map();
function household(hid) {
  if (loaded.has(hid)) return loaded.get(hid);
  if (!householdsDb.data[hid]) return null;
  const legacy = hid === MAIN, dir = legacy ? DATA_DIR : path.join(DATA_DIR, "households", hid);
  fs.mkdirSync(dir, { recursive: true });
  const f = (name, key) => jsonFile(path.join(dir, name), key);
  const h = {
    id: hid, legacy, dir,
    get name() { return householdsDb.data[hid]?.name || "Household"; },
    items: f("items.json", "items"),          // label code -> item
    shopping: f("shopping.json", "list"),     // id -> {name, done, addedAt}
    products: f("products.json", "products"), // barcode -> {name, unit, place, source}
    meta: f("meta.json", "meta"),             // lastReminder, lastBackup, cover
    settings: f("settings.json", "settings"), // reminder and weekly summary settings edited in the app
    history: f("history.json", "history"),    // id -> {name, qty, unit, place, outcome, by, at}
    push: f("push.json", "subs"),             // id -> {sub, by, ua, createdAt}
    coverFile: path.join(dir, "cover.jpg"),
    version: Date.now(),
    bump() { h.version = Date.now(); },
  };
  h.all = [h.items, h.shopping, h.products, h.meta, h.settings, h.history, h.push];
  loaded.set(hid, h);
  return h;
}
const households = () => Object.keys(householdsDb.data).map(household).filter(Boolean);
const membersOf = (hid) => Object.entries(accountsDb.data).filter(([, u]) => (u.household || MAIN) === hid);

// First start after the update: everything that's there becomes the first household, and
// the people in it may manage the site (households, invite codes, the email account).
if (!householdsDb.data[MAIN]) {
  householdsDb.data[MAIN] = { name: env.HOUSEHOLD_NAME || "Our household", createdAt: Date.now() };
  for (const u of Object.values(accountsDb.data)) { u.household = MAIN; u.admin = true; }
  const old = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8")).settings || {}; } catch { return {}; } })();
  for (const k of ["smtpHost", "smtpPort", "smtpUser", "smtpPass", "mailFrom"]) if (old[k] !== undefined) siteDb.data[k] = old[k];
  householdsDb.save(); accountsDb.save(); siteDb.save();
  console.log("Set up households: the existing shelf is the first one.");
}
const AVATAR_DIR = path.join(DATA_DIR, "avatars"); // one small JPEG per person, named by their id
fs.mkdirSync(AVATAR_DIR, { recursive: true });
// Emoji someone can pick instead of a photo
const AVATAR_EMOJI = ["🍅", "🥕", "🧀", "🍞", "🥑", "🍋", "🍇", "🍓", "🥦", "🌶️", "🍄", "🥚", "🍌", "🍉", "🥥", "🍯", "🍪", "🧁", "☕", "🐱", "🐶", "🌻", "⭐", "🏠"];

// ---------- auth ----------
// Everyone logs in with their own name and password (names are unique on the whole site).
// The first household can also use the household password from .env.
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
function makeToken(user) { const v = `v2.${user.id}.${user.id === "h" ? 0 : user.gen || 0}.${Date.now()}`; return `${v}.${sign(v)}`; }
function tokenUser(t) {
  if (!t) return null;
  const i = t.lastIndexOf("."); if (i < 0) return null;
  const v = t.slice(0, i), s = t.slice(i + 1), want = sign(v);
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  const [ver, id, gen] = v.split(".");
  if (ver === "v1" || id === "h") return PASSWORD ? HOUSEHOLD : null; // version 1 logins count as the household
  const u = accountsDb.data[id];
  if (!u || String(u.gen || 0) !== gen) return null; // removed, or password changed since
  return { id, name: u.name, hid: u.household || MAIN, admin: isAdmin(u.name, u.admin) };
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) { const [k, ...v] = part.trim().split("="); if (k) out[k] = decodeURIComponent(v.join("=")); }
  return out;
}
const openMode = () => !PASSWORD && !Object.keys(accountsDb.data).length && Object.keys(householdsDb.data).length === 1;
const whoIs = (req) => (openMode() ? HOUSEHOLD : tokenUser(cookies(req)[COOKIE]));
const loginAttempts = new Map(); // ip -> {n, until}
const clientIp = (req) => req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
const blocked = (ip) => (loginAttempts.get(ip)?.until || 0) > Date.now();
function failedTry(ip) {
  const a = loginAttempts.get(ip) || { n: 0, until: 0 };
  a.n += 1; if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; }
  loginAttempts.set(ip, a);
}
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) { return { salt, hash: crypto.scryptSync(pw, salt, 32).toString("hex") }; }
function passwordMatches(pw, u) {
  const got = crypto.scryptSync(pw, u.salt, 32), want = Buffer.from(u.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sameText = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const findUser = (name) => Object.entries(accountsDb.data).find(([, u]) => u.name.toLowerCase() === String(name).trim().toLowerCase());
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
// Food needs a best-before date. Household supplies (toilet paper, detergent…) don't; they have
// a "running low" level instead, and go on the shopping list when they reach it.
const isSupply = (it) => it.kind === "supply";
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
  if (body.kind === "supply") {
    out.kind = "supply";
    const low = Number(body.lowAt);
    out.lowAt = Number.isFinite(low) && low >= 0 && low <= 1000 ? low : 1;
    if (!out.name || (out.expiry && !DATE_RE.test(out.expiry))) return null;
    return out;
  }
  // The same food with different best-before dates: batches [{qty, expiry}], oldest first.
  // qty and expiry stay on the item as the total and the earliest date.
  if (Array.isArray(body.batches) && body.batches.length) {
    const byDate = new Map();
    for (const b of body.batches.slice(0, 20)) {
      const e = str(b?.expiry, 10), q = Number(b?.qty);
      if (!DATE_RE.test(e)) return null;
      byDate.set(e, (byDate.get(e) || 0) + (Number.isFinite(q) && q >= 0 ? q : 1));
    }
    setBatches(out, [...byDate].map(([expiry, qty]) => ({ qty, expiry })));
  }
  if (!out.name || !DATE_RE.test(out.expiry)) return null;
  return out;
}
// Sorts the batches, drops empty ones (keeping at least one) and sets qty/expiry from them.
// A single batch is stored as a plain item.
function setBatches(it, batches) {
  let list = batches.map((b) => ({ qty: Math.round(b.qty * 1000) / 1000, expiry: b.expiry })).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const left = list.filter((b) => b.qty > 0);
  list = left.length ? left : list.slice(-1);
  it.qty = Math.round(list.reduce((n, b) => n + b.qty, 0) * 1000) / 1000;
  it.expiry = list[0].expiry;
  if (list.length > 1) it.batches = list; else delete it.batches;
  return it;
}
const batchesOf = (it) => (Array.isArray(it.batches) && it.batches.length ? it.batches : [{ qty: it.qty, expiry: it.expiry }]);
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
// Everything with a best-before date (food, and supplies that have one), soonest first.
// An item with several dates gives one row per date, with that date's amount.
const sortedItems = (h) => Object.entries(h.items.data).filter(([, it]) => it.expiry)
  .flatMap(([id, it]) => batchesOf(it).map((b) => ({ id, ...it, qty: b.qty, expiry: b.expiry, days: daysLeft(b.expiry) }))).sort((a, b) => a.days - b.days);
const isLow = (it) => isSupply(it) && +it.qty <= (Number.isFinite(+it.lowAt) ? +it.lowAt : 1);
const lowSupplies = (h) => Object.entries(h.items.data).map(([id, it]) => ({ id, ...it })).filter(isLow).sort((a, b) => a.name.localeCompare(b.name));
const supplyCount = (h) => Object.values(h.items.data).filter(isSupply).length;

// ---------- outbound http ----------
async function getJson(url, ms = 8000) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

// ---------- barcode lookup (own memory first, then Open Food Facts) ----------
const offCache = new Map(); // barcode -> {at, value}
async function lookupBarcode(h, code) {
  const own = h.products.data[code];
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
function rememberProduct(h, item) {
  if (!item.barcode) return;
  h.products.data[item.barcode] = { name: item.name, unit: item.unit, place: item.place, ...(isSupply(item) ? { kind: "supply" } : {}), updatedAt: Date.now() };
  h.products.save();
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
async function recipeIdeas(h) {
  const seen = new Set();
  const pool = sortedItems(h).filter((it) => !isSupply(it) && it.days >= -1 && !seen.has(it.id) && seen.add(it.id)).slice(0, 8);
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
function logEvent(h, item, outcome, qty, by) {
  const hist = h.history.data;
  hist[crypto.randomUUID()] = { name: item.name, qty, unit: item.unit || "", place: item.place || "Pantry", outcome, by: by.name, at: Date.now(), ...(isSupply(item) ? { kind: "supply" } : {}) };
  const keys = Object.keys(hist);
  if (keys.length > HISTORY_MAX) {
    keys.sort((a, b) => hist[a].at - hist[b].at);
    for (const k of keys.slice(0, keys.length - HISTORY_MAX)) delete hist[k];
  }
  return h.history.save();
}
// "3 cans" counts as 3; "0.5 kg" counts as one thing
const amount = (e) => (COUNTABLE.has(e.unit) && e.qty > 0 ? e.qty : 1);
const monthKey = (t) => isoDay(new Date(t)).slice(0, 7);
function historySummary(h) {
  const events = Object.entries(h.history.data).map(([id, e]) => ({ ...e, id })).sort((a, b) => b.at - a.at);
  const now = new Date(), months = [];
  for (let i = 5; i >= 0; i--) months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, used: 0, wasted: 0 }]));
  const wasted = new Map(), people = new Map(), thisMonth = months[months.length - 1];
  for (const e of events) {
    if (isSupply(e)) continue; // used vs. thrown away is about food
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
// Settings saved in the app win; .env only gives the starting values (for the first household).
// The email account that sends is the site's, set by an admin; each household picks who gets it.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function mailAccount() {
  const s = siteDb.data, pick = (k, d) => (s[k] !== undefined ? s[k] : d);
  return {
    smtpHost: pick("smtpHost", env.SMTP_HOST || "smtp.gmail.com"),
    smtpPort: pick("smtpPort", Number(env.SMTP_PORT) || 587),
    smtpUser: pick("smtpUser", env.SMTP_USER || ""),
    smtpPass: pick("smtpPass", env.SMTP_PASS || ""),
    mailFrom: pick("mailFrom", env.MAIL_FROM || ""),
  };
}
const mailAccountReady = (a = mailAccount()) => !!(a.smtpHost && a.smtpUser && a.smtpPass);
function reminderSettings(h) {
  const s = h.settings.data, pick = (k, d) => (s[k] !== undefined ? s[k] : d), first = h.legacy;
  return {
    enabled: pick("enabled", true),
    time: pick("time", first && TIME_RE.test(env.REMINDER_TIME || "") ? env.REMINDER_TIME : "08:00"),
    days: pick("days", (first && Number(env.REMINDER_DAYS)) || 7),
    // How often: every day, once a week on `weekday` (0 = Sunday), or once a month on `monthday`
    frequency: pick("frequency", first && ["weekly", "monthly"].includes(env.REMINDER_FREQUENCY) ? env.REMINDER_FREQUENCY : "daily"),
    weekday: pick("weekday", 1),
    monthday: pick("monthday", 1),
    mailTo: pick("mailTo", first ? env.MAIL_TO || "" : ""),
  };
}
const emailReady = (h) => !!reminderSettings(h).mailTo && mailAccountReady();
function channelsNow(h) {
  return {
    ntfy: h.legacy && !!env.NTFY_URL, // ntfy and Telegram are set in .env, for the first household
    telegram: h.legacy && !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    email: emailReady(h),
    push: Object.keys(h.push.data).length > 0,
  };
}
const activeChannels = (h) => { const c = channelsNow(h); return Object.keys(c).filter((k) => c[k]); };
// Returns a problem to show, or null. Only an admin may change the email account.
function saveReminderSettings(h, body, admin) {
  const cur = { ...reminderSettings(h), ...mailAccount() }, next = {};
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
  const acct = {};
  if (admin) {
    const problem = cleanMailAccount(cur, body, acct);
    if (problem) return problem;
  }
  h.settings.data = { ...h.settings.data, ...next };
  if (admin) { siteDb.data = { ...siteDb.data, ...acct }; mailer = null; } // reconnect with the new account on the next send
  return null;
}
function cleanMailAccount(cur, body, next) {
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
  return null;
}
function reminderText(h) {
  const list = sortedItems(h);
  const expired = list.filter((i) => i.days < 0);
  const DAYS = reminderSettings(h).days;
  const soon = list.filter((i) => i.days >= 0 && i.days <= DAYS);
  const when = (d) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
  const line = (i) => `- ${i.name} (${i.qty} ${i.unit || ""}`.trimEnd() + `, ${i.place || "Pantry"}): ${i.days < 0 ? `expired ${-i.days} day${i.days === -1 ? "" : "s"} ago` : when(i.days)}`;
  const low = lowSupplies(h);
  const parts = [];
  if (expired.length) parts.push(`Expired:\n${expired.map(line).join("\n")}`);
  if (soon.length) parts.push(`Use within ${DAYS} days:\n${soon.map(line).join("\n")}`);
  if (low.length) parts.push(`Running low:\n${low.map((i) => `- ${i.name} (${i.qty} ${i.unit || ""}`.trimEnd() + ` left, ${i.place || "Storage"})`).join("\n")}`);
  const count = expired.length + soon.length + low.length;
  const bits = [soon.length && `${soon.length} to use soon`, expired.length && `${expired.length} expired`, low.length && `${low.length} running low`].filter(Boolean);
  const title = count ? `Pantry: ${bits.join(", ")}` : "Pantry: nothing expiring soon";
  let body = parts.length ? parts.join("\n\n") : `Nothing expires in the next ${DAYS} days.`;
  if (APP_URL) body += `\n\nOpen the shelf: ${APP_URL}`;
  const first = [...expired, ...soon, ...low].map((i) => i.name);
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
async function sendEmail({ title, body, html, attachments }, h) {
  const r = mailAccount();
  if (!mailer) {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({ host: r.smtpHost, port: r.smtpPort, secure: r.smtpPort === 465, auth: { user: r.smtpUser, pass: r.smtpPass } });
  }
  const from = r.mailFrom || r.smtpUser;
  try {
    await mailer.sendMail({ from: `Pantry Shelf <${from}>`, to: reminderSettings(h).mailTo, subject: title, text: body, html, attachments });
  } catch (e) {
    if (e.code === "EAUTH") throw new Error("The site's mail account or app password was refused. An admin can check them in Settings.");
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
  const subject = /^https:\/\//.test(APP_URL) ? APP_URL : `mailto:${mailAccount().smtpUser || "pantry-shelf@example.com"}`;
  lib.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  lib.publicKey = keys.publicKey;
  return (webpush = lib);
}
async function sendPush({ title, short }, h, only) {
  const lib = pushLib(), payload = JSON.stringify({ title, body: short, url: "/" });
  const targets = Object.entries(h.push.data).filter(([id]) => !only || id === only);
  let ok = 0, lastErr = null, changed = false;
  for (const [id, s] of targets) {
    try { await lib.sendNotification(s.sub, payload, { TTL: 12 * 3600 }); ok++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { delete h.push.data[id]; changed = true; } // phone unsubscribed
      else lastErr = e;
    }
  }
  if (changed) await h.push.save();
  if (!ok && targets.length) throw new Error(lastErr ? `The push service refused it (${lastErr.statusCode || lastErr.message}).` : "This phone's notifications were switched off. Turn them on again.");
  return ok;
}
// The daily reminder by email: the same layout as the weekly report, with the PDF attached
async function sendReminderEmail(msg, h) {
  const { report, summary, day } = weeklyReport(h), opts = { day, appUrl: APP_URL, daily: true };
  await sendEmail({ title: msg.title, body: report.text(summary, opts), html: report.html(summary, opts),
    attachments: [{ filename: `pantry-report-${day}.pdf`, content: await report.pdf(summary, opts), contentType: "application/pdf" }] }, h);
}
async function sendReminder(h, { force = false } = {}) {
  const msg = reminderText(h);
  if (!force && !msg.count && REMINDER_SKIP_EMPTY) return { sent: [], skipped: "nothing expiring" };
  const sent = [], failed = [], channels = channelsNow(h);
  for (const [name, fn] of [["ntfy", sendNtfy], ["telegram", sendTelegram], ["email", sendReminderEmail], ["push", sendPush]]) {
    if (!channels[name]) continue;
    try { await fn(msg, h); sent.push(name); } catch (e) { console.error(`Reminder via ${name} failed (${h.id}):`, e.message); failed.push({ channel: name, error: e.message }); }
  }
  return { sent, failed };
}

// ---------- backups ----------
let backupDirOk = false;
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.accessSync(BACKUP_DIR, fs.constants.W_OK); backupDirOk = true; }
catch (e) { console.warn(`Backups are off: can't write to ${BACKUP_DIR} (${e.code}).`); }
const snapshot = (h) => ({ app: "pantry-shelf", version: 2, household: h.name, exportedAt: new Date().toISOString(), items: h.items.data, shopping: h.shopping.data, products: h.products.data, history: h.history.data });
const BACKUP_RE = /^pantry-[\w-]+\.json$/;
// The first household's backups keep their old names; the others' carry the household id
const OTHER_RE = /^pantry-h[0-9a-f]{8}-/;
const backupName = (h, what) => (h.legacy ? `pantry-${what}.json` : `pantry-${h.id}-${what}.json`);
const ownsBackup = (h, f) => BACKUP_RE.test(f) && (h.legacy ? !OTHER_RE.test(f) : f.startsWith(`pantry-${h.id}-`));
const stamp = (d = new Date()) => `${isoDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
async function writeBackup(h, what) {
  const file = path.join(BACKUP_DIR, backupName(h, what));
  await fsp.writeFile(file + ".tmp", JSON.stringify(snapshot(h), null, 1));
  await fsp.rename(file + ".tmp", file);
  return file;
}
async function runBackup() {
  const files = [];
  for (const h of households()) files.push(await writeBackup(h, isoDay(new Date())));
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400e3;
  for (const f of await fsp.readdir(BACKUP_DIR)) {
    if (!BACKUP_RE.test(f)) continue;
    const st = await fsp.stat(path.join(BACKUP_DIR, f));
    if (st.mtimeMs < cutoff) await fsp.unlink(path.join(BACKUP_DIR, f));
  }
  return files;
}
async function listBackups(h) {
  if (!backupDirOk) return [];
  const out = [];
  for (const f of await fsp.readdir(BACKUP_DIR)) {
    if (!ownsBackup(h, f)) continue;
    const st = await fsp.stat(path.join(BACKUP_DIR, f));
    out.push({ file: f, at: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.at - a.at);
}
// When the weekly summary goes out: a weekday (0 = Sunday) and a time, set in Settings > Backups
const summarySchedule = (h) => ({
  summaryDay: Number.isInteger(h.settings.data.summaryDay) ? h.settings.data.summaryDay : 0,
  summaryTime: TIME_RE.test(h.settings.data.summaryTime || "") ? h.settings.data.summaryTime : BACKUP_TIME,
});
// Everyone sees the weekly report settings; only an admin sees the backup files.
async function backupStatus(h, admin) {
  const sched = summarySchedule(h), emailCopy = !!h.settings.data.backupEmail;
  const report = { emailCopy, emailReady: emailReady(h), withBackup: reportHasBackup(h), lastEmailed: h.meta.data.lastBackupEmail || null, ...sched };
  if (!admin) return report;
  if (!backupDirOk) return { enabled: false, ...report };
  const files = await listBackups(h);
  return { enabled: true, time: BACKUP_TIME, keepDays: BACKUP_KEEP_DAYS, count: files.length, latest: files[0]?.file || null, files: files.slice(0, 40), ...report };
}
// Put a backup back. A copy of what's there now is saved first, so a restore can be undone.
async function restoreSnapshot(h, snap) {
  if (!snap || snap.app !== "pantry-shelf" || !snap.items || typeof snap.items !== "object") throw new Error("That isn't a Pantry Shelf backup.");
  const items = {};
  for (const [id, it] of Object.entries(snap.items)) {
    const clean = ID_RE.test(id) && it && cleanItem({ ...it, updatedAt: undefined });
    if (clean) items[id] = { ...clean, updatedAt: Number(it.updatedAt) || Date.now() };
  }
  let safety = null;
  if (backupDirOk) safety = path.basename(await writeBackup(h, `before-restore-${stamp()}`));
  h.items.data = items;
  if (snap.shopping && typeof snap.shopping === "object") h.shopping.data = snap.shopping;
  if (snap.products && typeof snap.products === "object") h.products.data = snap.products;
  if (snap.history && typeof snap.history === "object") h.history.data = snap.history;
  await Promise.all([h.items.save(), h.shopping.save(), h.products.save(), h.history.save()]);
  h.bump();
  return { items: Object.keys(items).length, safety };
}
// The weekly email: a summary to read and the same as a PDF report. The backup file only
// goes along for the first household (the admin's); friends' households get the report alone.
const reportHasBackup = (h) => h.id === MAIN;
function weeklyReport(h) {
  const report = require("./report");
  const day = isoDay(new Date());
  const summary = report.summarize({
    items: sortedItems(h), history: historySummary(h), days: reminderSettings(h).days,
    supplies: Object.values(h.items.data).filter(isSupply).map((it) => ({ ...it, low: isLow(it) })).sort((a, b) => a.name.localeCompare(b.name)),
    shopping: Object.values(h.shopping.data).filter((e) => !e.done).sort((a, b) => a.addedAt - b.addedAt),
  });
  return { report, summary, day };
}
async function emailBackup(h) {
  if (!mailAccountReady()) throw new Error("The site has no email account yet. An admin sets it up in Settings.");
  if (!emailReady(h)) throw new Error("Fill in who gets the reminder email first.");
  const { report, summary, day } = weeklyReport(h), opts = { day, appUrl: APP_URL, withBackup: reportHasBackup(h) };
  const bits = [summary.soon.length && `${summary.soon.length} to use soon`, summary.expired.length && `${summary.expired.length} expired`].filter(Boolean);
  await sendEmail({
    title: `Pantry this week: ${bits.length ? bits.join(", ") : `${summary.total} items, nothing urgent`}`,
    body: report.text(summary, opts),
    html: report.html(summary, opts),
    attachments: [
      { filename: `pantry-report-${day}.pdf`, content: await report.pdf(summary, opts), contentType: "application/pdf" },
      ...(reportHasBackup(h) ? [{ filename: `pantry-backup-${day}.json`, content: JSON.stringify(snapshot(h), null, 1), contentType: "application/json" }] : []),
    ],
  }, h);
  h.meta.data.lastBackupEmail = day; await h.meta.save();
}

// Is today a reminder day? A month without the chosen date (say the 31st) uses its last day.
function reminderDue(rs, now) {
  if (rs.frequency === "weekly") return now.getDay() === rs.weekday;
  if (rs.frequency === "monthly") return now.getDate() === Math.min(rs.monthday, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  return true;
}

// ---------- daily scheduler (checks once a minute) ----------
async function tick() {
  const now = new Date(), day = isoDay(now), t = hhmm(now), first = household(MAIN);
  for (const h of households()) {
    const meta = h.meta.data, rs = reminderSettings(h);
    if (rs.enabled && reminderDue(rs, now) && t >= rs.time && meta.lastReminder !== day && activeChannels(h).length) {
      meta.lastReminder = day; await h.meta.save();
      const r = await sendReminder(h);
      console.log(`Reminder for ${h.id}: ${r.skipped || `sent via ${r.sent.join(", ") || "nothing"}`}`);
    }
    // Weekly summary with the PDF report (and, for the first household, the backup file)
    const ws = summarySchedule(h);
    if (h.settings.data.backupEmail && now.getDay() === ws.summaryDay && t >= ws.summaryTime && meta.lastBackupEmail !== day && emailReady(h)) {
      meta.lastBackupEmail = day; await h.meta.save();
      try { await emailBackup(h); console.log(`Weekly summary emailed for ${h.id}.`); } catch (e) { console.error(`Emailing the weekly summary for ${h.id} failed:`, e.message); }
    }
  }
  // One nightly backup run for all households (remembered in the first one)
  if (t >= BACKUP_TIME && first.meta.data.lastBackup !== day && backupDirOk) {
    first.meta.data.lastBackup = day; await first.meta.save();
    try { console.log("Backups written:", (await runBackup()).length); } catch (e) { console.error("Backup failed:", e.message); }
  }
}
setInterval(() => tick().catch((e) => console.error(e)), 60_000);
setTimeout(() => tick().catch((e) => console.error(e)), 5_000);

// ---------- households and invite codes ----------
const CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function newCode() {
  const pick = () => Array.from(crypto.randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  return `${pick()}-${pick()}`;
}
// "k7mx q2pd" or "K7MXQ2PD" -> "K7MX-Q2PD"
const normCode = (v) => { const c = String(v || "").toUpperCase().replace(/[^0-9A-Z]/g, ""); return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : ""; };
function pruneInvites() {
  let changed = false;
  for (const [code, v] of Object.entries(invitesDb.data)) if (v.expires < Date.now()) { delete invitesDb.data[code]; changed = true; }
  if (changed) invitesDb.save();
}
const siteFull = () => Object.keys(householdsDb.data).length >= MAX_HOUSEHOLDS;
function adminState() {
  pruneInvites();
  return {
    limits: { households: MAX_HOUSEHOLDS, members: MAX_MEMBERS }, openSignup: OPEN_SIGNUP,
    households: households().map((x) => ({
      id: x.id, name: x.name, first: x.legacy, createdAt: householdsDb.data[x.id].createdAt,
      members: membersOf(x.id).map(([, u]) => u.name).sort((a, b) => a.localeCompare(b)), items: Object.keys(x.items.data).length,
    })).sort((a, b) => (b.first - a.first) || a.createdAt - b.createdAt),
    invites: Object.entries(invitesDb.data).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.createdAt - a.createdAt),
    timeZone: timeZone(), zones: [...ZONES].sort(),
  };
}
// Removes a household with its people and files. Its last state is kept as a backup until
// backups that old are cleaned up (BACKUP_KEEP_DAYS).
async function deleteHousehold(h, by) {
  if (backupDirOk) await writeBackup(h, `deleted-${stamp()}`);
  for (const [id] of membersOf(h.id)) {
    delete accountsDb.data[id];
    await fsp.unlink(path.join(AVATAR_DIR, `${id}.jpg`)).catch(() => {});
  }
  delete householdsDb.data[h.id];
  await Promise.all(h.all.map((d) => d.flushed()));
  loaded.delete(h.id);
  await fsp.rm(h.dir, { recursive: true, force: true });
  await Promise.all([accountsDb.save(), householdsDb.save()]);
  console.log(`Household ${h.id} deleted by ${by}.`);
}

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".json": "application/json" };
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
  const h = household(me.hid);
  if (!h) return send(res, 401, { error: "login" });
  let r;
  if (p === "/api/state" && req.method === "GET") return send(res, 200, { version: h.version, household: { id: h.id, name: h.name }, items: h.items.data, shopping: h.shopping.data, cover: h.meta.data.cover || null, coverPos: h.meta.data.coverPos || { x: 50, y: 50 } });

  // Which part of the cover photo shows: a focus point in percent, set by dragging in Settings
  if (p === "/api/cover/position" && req.method === "PUT") {
    const b = await readBody(req), clamp = (v) => Math.min(100, Math.max(0, Math.round(Number(v))));
    if (!Number.isFinite(Number(b.x)) || !Number.isFinite(Number(b.y))) return send(res, 400, { error: "Bad position." });
    h.meta.data.coverPos = { x: clamp(b.x), y: clamp(b.y) }; await h.meta.save(); h.bump();
    return send(res, 200, { ok: true, coverPos: h.meta.data.coverPos });
  }

  // Cover photo for the header, uploaded from Settings (the page sends a resized JPEG)
  if (p === "/api/cover" && req.method === "POST") {
    let img;
    try { img = await readRaw(req, 4 * 1024 * 1024); } catch (e) { return send(res, 413, { error: "That photo is too large. Try a smaller one." }); }
    if (!(img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff)) return send(res, 400, { error: "That file isn't a JPEG photo." });
    await fsp.writeFile(h.coverFile + ".tmp", img); await fsp.rename(h.coverFile + ".tmp", h.coverFile);
    h.meta.data.cover = Date.now(); h.meta.data.coverPos = { x: 50, y: 50 }; await h.meta.save(); h.bump();
    return send(res, 200, { ok: true, cover: h.meta.data.cover, coverPos: h.meta.data.coverPos });
  }
  if (p === "/api/cover" && req.method === "DELETE") {
    await fsp.unlink(h.coverFile).catch(() => {});
    delete h.meta.data.cover; await h.meta.save(); h.bump();
    return send(res, 200, { ok: true, cover: null });
  }
  if (p === "/api/items" && req.method === "GET") return send(res, 200, { version: h.version, items: h.items.data });

  if ((r = m(/^\/api\/items\/([^/]+)$/))) {
    const id = r[1];
    if (!ID_RE.test(id)) return send(res, 400, { error: "Bad label code." });
    if (req.method === "PUT") {
      const data = cleanItem(await readBody(req));
      if (!data) return send(res, 400, { error: "Name and best-before date are required (household supplies only need a name)." });
      const prev = h.items.data[id];
      if (!prev && Object.keys(h.items.data).length >= 5000) return send(res, 507, { error: "The shelf is full." });
      data.addedBy = prev?.addedBy || me.name;
      data.updatedBy = me.name;
      h.items.data[id] = data; h.bump(); await h.items.save(); rememberProduct(h, data);
      if (!prev) await logEvent(h, data, "added", data.qty, me);
      return send(res, 200, { ok: true, item: data, version: h.version });
    }
    if (req.method === "DELETE") {
      const body = await readBody(req).catch(() => ({}));
      const gone = h.items.data[id];
      delete h.items.data[id]; h.bump(); await h.items.save();
      // What happened to what was left: eaten ("used") or thrown away ("wasted")
      if (gone && ["used", "wasted"].includes(body.outcome) && gone.qty > 0) await logEvent(h, gone, body.outcome, gone.qty, me);
      let entry = null;
      if (gone && body.addToShopping) {
        const already = Object.values(h.shopping.data).some((e) => !e.done && e.name.toLowerCase() === gone.name.toLowerCase());
        if (!already) { entry = { name: gone.name, done: false, addedAt: Date.now(), updatedAt: Date.now() }; h.shopping.data[crypto.randomUUID()] = entry; await h.shopping.save(); }
      }
      return send(res, 200, { ok: true, version, addedToShopping: !!entry });
    }
  }

  // Took one out of a box of several: count it, keep the rest on the shelf
  if ((r = m(/^\/api\/items\/([^/]+)\/use$/)) && req.method === "POST") {
    const it = h.items.data[r[1]];
    if (!it) return send(res, 404, { error: "That item isn't on the shelf any more." });
    const body = await readBody(req).catch(() => ({}));
    const outcome = body.outcome === "wasted" ? "wasted" : "used";
    const take = Math.min(1, Math.max(0, +it.qty));
    if (it.batches) {
      // Take it from the batch that expires first
      const list = it.batches.map((b) => ({ ...b })), first = list.find((b) => b.qty > 0);
      if (first) first.qty = Math.max(0, first.qty - 1);
      setBatches(it, list);
    } else it.qty = Math.max(0, Math.round((+it.qty - 1) * 1000) / 1000);
    it.updatedAt = Date.now(); it.updatedBy = me.name;
    h.bump(); await h.items.save();
    if (take > 0) await logEvent(h, it, outcome, take, me);
    let addedToShopping = false;
    if (isLow(it) && !Object.values(h.shopping.data).some((e) => !e.done && e.name.toLowerCase() === it.name.toLowerCase())) {
      h.shopping.data[crypto.randomUUID()] = { name: it.name, done: false, addedAt: Date.now(), updatedAt: Date.now() }; await h.shopping.save(); h.bump(); addedToShopping = true;
    }
    return send(res, 200, { ok: true, item: it, addedToShopping, version: h.version });
  }

  if ((r = m(/^\/api\/shopping\/([^/]+)$/))) {
    const id = r[1];
    if (id === "clear-done" && req.method === "POST") {
      for (const [k, e] of Object.entries(h.shopping.data)) if (e.done) delete h.shopping.data[k];
      h.bump(); await h.shopping.save(); return send(res, 200, { ok: true, shopping: h.shopping.data });
    }
    if (!LIST_ID_RE.test(id)) return send(res, 400, { error: "Bad id." });
    if (req.method === "PUT") {
      const e = cleanEntry(await readBody(req));
      if (!e) return send(res, 400, { error: "Type what to buy." });
      if (!h.shopping.data[id] && Object.keys(h.shopping.data).length >= 1000) return send(res, 507, { error: "The list is full." });
      h.shopping.data[id] = e; h.bump(); await h.shopping.save(); return send(res, 200, { ok: true, entry: e });
    }
    if (req.method === "DELETE") { delete h.shopping.data[id]; h.bump(); await h.shopping.save(); return send(res, 200, { ok: true }); }
  }

  if ((r = m(/^\/api\/barcode\/([^/]+)$/)) && req.method === "GET") {
    if (!BARCODE_RE.test(r[1])) return send(res, 400, { error: "That isn't a product barcode." });
    try { const product = await lookupBarcode(h, r[1]); return send(res, 200, { product }); }
    catch (e) { console.error("Barcode lookup failed:", e.message); return send(res, 502, { error: "Couldn't reach Open Food Facts. Type the name instead." }); }
  }

  if (p === "/api/recipes" && req.method === "GET") return send(res, 200, await recipeIdeas(h));

  if (p === "/api/settings" && req.method === "GET") {
    return send(res, 200, {
      reminders: (() => {
        const r = reminderSettings(h), acct = mailAccount();
        return { channels: activeChannels(h), enabled: r.enabled, time: r.time, days: r.days, frequency: r.frequency, weekday: r.weekday, monthday: r.monthday, mailTo: r.mailTo,
          mailReady: mailAccountReady(acct), canEditMail: me.admin, lastSent: h.meta.data.lastReminder || null, tz: timeZone(),
          ...(me.admin ? { smtpUser: acct.smtpUser, smtpHost: acct.smtpHost, smtpPort: acct.smtpPort, hasPassword: !!acct.smtpPass } : {}) };
      })(),
      backups: await backupStatus(h, me.admin),
      push: { devices: Object.keys(h.push.data).length },
    });
  }
  if (p === "/api/settings/reminders" && req.method === "PUT") {
    const problem = saveReminderSettings(h, await readBody(req), me.admin);
    if (problem) return send(res, 400, { error: problem });
    await h.settings.save(); if (me.admin) await siteDb.save();
    console.log("Reminder settings changed in the app.");
    return send(res, 200, { ok: true });
  }
  if (p === "/api/reminders/test" && req.method === "POST") {
    if (!activeChannels(h).length) return send(res, 400, { error: "Fill in the email settings, or turn on phone notifications, first." });
    return send(res, 200, await sendReminder(h, { force: true }));
  }
  if (p === "/api/history" && req.method === "GET") return send(res, 200, historySummary(h));
  // Remove one entry, e.g. something logged while trying the app out
  const histMatch = p.match(/^\/api\/history\/([\w-]{1,64})$/);
  if (histMatch && req.method === "DELETE") {
    if (!h.history.data[histMatch[1]]) return send(res, 404, { error: "That entry is already gone." });
    delete h.history.data[histMatch[1]]; await h.history.save(); h.bump();
    return send(res, 200, { ok: true });
  }
  // Start the history over; a backup with the old history is saved first
  if (p === "/api/history" && req.method === "DELETE") {
    let safety = null;
    if (backupDirOk) safety = path.basename(await writeBackup(h, `before-clear-history-${stamp()}`));
    h.history.data = {}; await h.history.save(); h.bump();
    console.log(`History cleared by ${me.name}.`);
    return send(res, 200, { ok: true, safety });
  }

  // ---- people: a login for each person in the household
  if (p === "/api/people" && req.method === "GET") {
    const people = membersOf(h.id).map(([id, u]) => ({ id, name: u.name, createdAt: u.createdAt, avatar: u.avatar || null })).sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, { people, me, householdPassword: h.legacy && !!PASSWORD, emoji: AVATAR_EMOJI, maxMembers: MAX_MEMBERS });
  }
  if (p === "/api/people" && req.method === "POST") {
    const c = cleanPerson(await readBody(req));
    if (c.error) return send(res, 400, { error: c.error });
    if (findUser(c.name)) return send(res, 409, { error: `The name ${c.name} is already used on this site. Add a letter, like ${c.name} ${c.name[0]}.` });
    if (membersOf(h.id).length >= MAX_MEMBERS) return send(res, 507, { error: `A household can have up to ${MAX_MEMBERS} people.` });
    const id = crypto.randomBytes(6).toString("hex");
    accountsDb.data[id] = { name: c.name, ...hashPassword(c.password), gen: 1, household: h.id, createdAt: Date.now() };
    await accountsDb.save();
    return send(res, 200, { ok: true, id });
  }
  // Avatar: a photo (the page sends a small square JPEG) or one of the emoji
  if ((r = m(/^\/api\/people\/([a-f0-9]{12})\/avatar$/))) {
    const u = accountsDb.data[r[1]];
    if (!u || (u.household || MAIN) !== h.id) return send(res, 404, { error: "That person was removed." });
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
      await accountsDb.save();
      return send(res, 200, { ok: true, avatar: u.avatar });
    }
    if (req.method === "DELETE") {
      await fsp.unlink(file).catch(() => {});
      delete u.avatar; await accountsDb.save();
      return send(res, 200, { ok: true, avatar: null });
    }
  }
  if ((r = m(/^\/api\/people\/([a-f0-9]{12})$/))) {
    const u = accountsDb.data[r[1]];
    if (!u || (u.household || MAIN) !== h.id) return send(res, 404, { error: "That person was already removed." });
    if (req.method === "PUT") { // new password; logs that person out on their other phones
      const body = await readBody(req);
      const c = cleanPerson({ name: u.name, password: body.password });
      if (c.error) return send(res, 400, { error: c.error });
      Object.assign(u, hashPassword(c.password), { gen: (u.gen || 0) + 1 });
      await accountsDb.save();
      const headers = r[1] === me.id ? { "Set-Cookie": sessionCookie(req, { id: r[1], gen: u.gen }) } : {};
      return send(res, 200, { ok: true }, headers);
    }
    if (req.method === "DELETE") {
      if (r[1] === me.id) return send(res, 400, { error: "You can't remove yourself. Ask someone else, or log in with the household password." });
      if (!(h.legacy && PASSWORD) && membersOf(h.id).length === 1) return send(res, 400, { error: "Keep at least one person: nobody else could log in." });
      delete accountsDb.data[r[1]]; await accountsDb.save();
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
    if (Object.keys(h.push.data).length >= 50) return send(res, 507, { error: "Too many phones signed up. Turn notifications off on an old one first." });
    const id = crypto.createHash("sha256").update(ep).digest("hex").slice(0, 24);
    h.push.data[id] = { sub: { endpoint: ep, keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) } }, by: me.name, ua: str(req.headers["user-agent"] || "", 200), createdAt: Date.now() };
    await h.push.save();
    return send(res, 200, { ok: true, id });
  }
  if (p === "/api/push" && req.method === "DELETE") {
    const { endpoint } = await readBody(req);
    const id = typeof endpoint === "string" && crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
    if (id && h.push.data[id]) { delete h.push.data[id]; await h.push.save(); }
    return send(res, 200, { ok: true });
  }
  if (p === "/api/push/test" && req.method === "POST") {
    const { endpoint } = await readBody(req);
    const id = typeof endpoint === "string" && crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
    if (!id || !h.push.data[id]) return send(res, 400, { error: "This phone isn't signed up. Turn notifications on first." });
    const msg = reminderText(h);
    try { await sendPush(msg.count ? msg : { title: "Pantry Shelf", short: "Notifications work on this phone." }, h, id); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  // ---- the weekly report (everyone) and backups (admins only)
  if (p === "/api/settings/backups" && req.method === "PUT") {
    const body = await readBody(req);
    if (body.emailCopy && !emailReady(h)) return send(res, 400, { error: mailAccountReady() ? "Fill in who gets the reminder email first, then switch this on." : "The site has no email account yet. Ask an admin to set it up." });
    const next = { ...h.settings.data };
    if (body.emailCopy !== undefined) next.backupEmail = !!body.emailCopy;
    if (body.summaryDay !== undefined) {
      if (!Number.isInteger(body.summaryDay) || body.summaryDay < 0 || body.summaryDay > 6) return send(res, 400, { error: "Pick a day of the week." });
      next.summaryDay = body.summaryDay;
    }
    if (body.summaryTime !== undefined) {
      if (!TIME_RE.test(String(body.summaryTime))) return send(res, 400, { error: "Pick a time like 11:00." });
      next.summaryTime = String(body.summaryTime);
    }
    h.settings.data = next;
    await h.settings.save();
    return send(res, 200, { ok: true, backups: await backupStatus(h, me.admin) });
  }
  if (p === "/api/report.pdf" && req.method === "GET") {
    const { report, summary, day } = weeklyReport(h);
    return send(res, 200, await report.pdf(summary, { day, appUrl: APP_URL }), { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="pantry-report-${day}.pdf"` });
  }
  if ((p === "/api/report/email" || p === "/api/backup/email") && req.method === "POST") {
    try { await emailBackup(h); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p.startsWith("/api/backup") && !me.admin) return send(res, 403, { error: "Only an admin can do that." });
  if (p === "/api/backup/restore" && req.method === "POST") {
    let snap;
    if ((req.headers["x-restore-file"] || "") !== "") {
      const f = String(req.headers["x-restore-file"]);
      if (!backupDirOk || !ownsBackup(h, f)) return send(res, 400, { error: "Pick a backup from the list." });
      try { snap = JSON.parse(await fsp.readFile(path.join(BACKUP_DIR, f), "utf8")); } catch { return send(res, 404, { error: "That backup can't be read." }); }
    } else {
      let raw;
      try { raw = await readRaw(req, 20 * 1024 * 1024); } catch { return send(res, 413, { error: "That file is too large to be a pantry backup." }); }
      try { snap = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "That file isn't a Pantry Shelf backup." }); }
    }
    try {
      const out = await restoreSnapshot(h, snap);
      console.log(`Restored a backup (${out.items} items) for ${me.name} in ${h.id}.`);
      return send(res, 200, { ok: true, ...out });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/api/backup" && req.method === "GET") {
    return send(res, 200, JSON.stringify(snapshot(h), null, 1), { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="pantry-${isoDay(new Date())}.json"` });
  }
  if (p === "/api/backup/run" && req.method === "POST") {
    if (!backupDirOk) return send(res, 400, { error: "Backups are off: the backup folder isn't writable." });
    await writeBackup(h, isoDay(new Date())); return send(res, 200, { ok: true, backups: await backupStatus(h, true) });
  }

  // ---- this household: its name, or deleting it with everything in it
  if (p === "/api/household" && req.method === "PUT") {
    const name = str((await readBody(req)).name, 40);
    if (!name) return send(res, 400, { error: "Type a name for the household." });
    householdsDb.data[h.id].name = name; await householdsDb.save(); h.bump();
    return send(res, 200, { ok: true, name });
  }
  if (p === "/api/household" && req.method === "DELETE") {
    if (h.legacy) return send(res, 400, { error: "The first household can't be deleted." });
    const { confirm } = await readBody(req);
    if (str(confirm, 40).toLowerCase() !== h.name.toLowerCase()) return send(res, 400, { error: "Type the household's name exactly to confirm." });
    await deleteHousehold(h, me.name);
    return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
  }

  // ---- site admin: households, invite codes
  if (p === "/api/admin" || p.startsWith("/api/admin/")) {
    if (!me.admin) return send(res, 403, { error: "Only an admin can do that." });
    if (p === "/api/admin" && req.method === "GET") return send(res, 200, adminState());
    if (p === "/api/admin/timezone" && req.method === "PUT") {
      const tz = String((await readBody(req)).timeZone || "");
      if (!validZone(tz)) return send(res, 400, { error: "Pick a time zone from the list." });
      siteDb.data = { ...siteDb.data, tz }; await siteDb.save(); applyTimeZone();
      console.log(`Time zone set to ${tz} by ${me.name}.`);
      return send(res, 200, { ok: true, timeZone: timeZone() });
    }
    if (p === "/api/admin/invites" && req.method === "POST") {
      pruneInvites();
      if (Object.keys(invitesDb.data).length >= 20) return send(res, 507, { error: "There are 20 unused codes already. Remove some first." });
      let code; do code = newCode(); while (invitesDb.data[code]);
      invitesDb.data[code] = { createdAt: Date.now(), expires: Date.now() + INVITE_DAYS * 86400e3, by: me.name };
      await invitesDb.save();
      return send(res, 200, { ok: true, code, ...adminState() });
    }
    if ((r = m(/^\/api\/admin\/invites\/([A-Z0-9-]{9})$/)) && req.method === "DELETE") {
      delete invitesDb.data[r[1]]; await invitesDb.save();
      return send(res, 200, { ok: true, ...adminState() });
    }
    if ((r = m(/^\/api\/admin\/households\/(h[0-9a-f]{8})$/)) && req.method === "DELETE") {
      const t = household(r[1]);
      if (!t) return send(res, 404, { error: "That household is already gone." });
      if (t.id === h.id) return send(res, 400, { error: "Delete your own household from its settings instead." });
      await deleteHousehold(t, me.name);
      return send(res, 200, { ok: true, ...adminState() });
    }
  }
  return send(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  try {
    if (p === "/healthz") return send(res, 200, { ok: true });

    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, { error: "Too many tries. Wait a minute and try again." });
      const { name, password } = await readBody(req);
      let user = null;
      if (typeof password === "string" && password) {
        if (typeof name === "string" && name.trim()) {
          const hit = findUser(name);
          if (hit && passwordMatches(password, hit[1])) user = { id: hit[0], gen: hit[1].gen };
        } else if (PASSWORD && sameText(password, PASSWORD)) user = HOUSEHOLD;
      }
      if (!user) {
        failedTry(ip);
        return send(res, 401, { error: typeof name === "string" && name.trim() ? "That name and password don't match." : "That password isn't right." });
      }
      loginAttempts.delete(ip);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, user) });
    }
    // A new household, with an invite code from an admin (or without, when OPEN_SIGNUP=true)
    if (p === "/api/signup" && req.method === "POST") {
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, { error: "Too many tries. Wait a minute and try again." });
      const b = await readBody(req), code = normCode(b.code);
      pruneInvites();
      if (!OPEN_SIGNUP && !invitesDb.data[code]) { failedTry(ip); return send(res, 400, { error: "That invite code isn't valid or has expired. Ask for a new one." }); }
      if (siteFull()) return send(res, 507, { error: `The site is full: it has room for ${MAX_HOUSEHOLDS} households.` });
      const hname = str(b.household, 40);
      if (!hname) return send(res, 400, { error: "Give your household a name." });
      const c = cleanPerson(b);
      if (c.error) return send(res, 400, { error: c.error });
      if (findUser(c.name)) return send(res, 409, { error: `The name ${c.name} is already used on this site. Add a letter, like ${c.name} ${c.name[0]}.` });
      let hid; do hid = `h${crypto.randomBytes(4).toString("hex")}`; while (householdsDb.data[hid]);
      const id = crypto.randomBytes(6).toString("hex");
      householdsDb.data[hid] = { name: hname, createdAt: Date.now() };
      accountsDb.data[id] = { name: c.name, ...hashPassword(c.password), gen: 1, household: hid, createdAt: Date.now() };
      delete invitesDb.data[code];
      await Promise.all([householdsDb.save(), accountsDb.save(), invitesDb.save()]);
      household(hid);
      console.log(`New household ${hid} (${hname}) by ${c.name}.`);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, { id, gen: 1 }) });
    }
    if (p === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    }
    if (p === "/api/session") { // asked before logging in
      const me = whoIs(req);
      const h = me && household(me.hid);
      if (h) return send(res, 200, { ok: true, passwordProtected: !openMode(), me: { ...me, household: h.name } });
      return send(res, 401, { error: "login", hasPeople: Object.keys(accountsDb.data).length > 0, householdPassword: !!PASSWORD, signup: OPEN_SIGNUP ? "open" : "code", full: siteFull() });
    }
    if (p === "/cover.jpg" && req.method === "GET") {
      const me = whoIs(req), h = me && household(me.hid);
      if (!h) return send(res, 401, "Log in first");
      try { return send(res, 200, await fsp.readFile(h.coverFile), { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" }); }
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
  console.log(`Pantry Shelf ${require("./package.json").version} listening on :${PORT}, data in ${DATA_DIR}, time zone ${timeZone()}`);
  console.log(`Households: ${Object.keys(householdsDb.data).length} of ${MAX_HOUSEHOLDS}; email: ${mailAccountReady() ? "set up" : "not set up"}; backups: ${backupDirOk ? `${BACKUP_DIR} at ${BACKUP_TIME}, keep ${BACKUP_KEEP_DAYS} days` : "off"}`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  server.close();
  Promise.all([accountsDb, householdsDb, invitesDb, siteDb, ...[...loaded.values()].flatMap((h) => h.all)].map((d) => d.flushed())).finally(() => process.exit(0));
});
