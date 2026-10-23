(() => {
  const $ = (s) => document.querySelector(s);
  const DAY = 86400000;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const ALPH = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I to keep codes readable
  let items = new Map();
  let shopping = new Map();
  let currentId = null;
  let editingId = null;
  let pendingCode = null;
  let editBarcode = null;
  let loaded = false;
  let lastSync = 0;
  let tab = "shelf";
  let recipesFor = null; // items fingerprint the recipe list was built for
  let me = null;           // who is logged in on this phone
  let people = [];         // everyone with their own login, with avatars
  let emojiChoices = [];
  let passwordProtected = true;
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  let place = store.get("pantry.place") || "All";

  // ---------- api ----------
  async function api(method, url, body) {
    let res;
    try { res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" }); }
    catch { throw new Error("No connection right now. Try again when you're back online."); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== "/api/login") { showLogin(data); throw Object.assign(new Error("login"), { status: 401 }); }
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
    return data;
  }
  async function refresh() {
    try {
      const data = await api("GET", "/api/state");
      items = new Map(Object.entries(data.items || {}));
      shopping = new Map(Object.entries(data.shopping || {}));
      applyCover(data.cover, data.coverPos);
      loaded = true;
      if (data.offline) {
        const when = data.savedAt ? new Date(data.savedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "earlier";
        setStatus(`You're offline. This is the shelf as it was ${when}. Changes need a connection.`);
      } else { lastSync = Date.now(); setStatus(""); }
      render();
    } catch (e) {
      if (e.status !== 401) setStatus(loaded ? "Can't reach the server right now. Showing the last list loaded." : "Can't reach the server. Check your connection and reload.");
    }
  }

  // ---------- dates ----------
  const todayStart = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
  const parseDate = (s) => { const [y,m,d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const nice = (d, withYear) => `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`;
  const daysLeft = (exp) => Math.round((parseDate(exp) - todayStart()) / DAY);
  function urgency(n) {
    if (n < 0) return { band: "expired", cls: "s-exp" };
    if (n <= 7) return { band: "soon", cls: "s-soon" };
    if (n <= 30) return { band: "month", cls: "s-month" };
    return { band: "later", cls: "s-ok" };
  }
  function leftText(n) {
    if (n < -1) return `${-n} days ago`;
    if (n === -1) return "Yesterday";
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n < 60) return `${n} days`;
    return `${Math.round(n / 30)} months`;
  }

  // ---------- codes ----------
  function newCode() {
    const a = new Uint8Array(6); crypto.getRandomValues(a);
    return Array.from(a, (b) => ALPH[b % ALPH.length]).join("");
  }
  // Accepts a bare code, "PANTRY:CODE", or a label URL ending in "#item=CODE"
  function codeFrom(text) {
    const t = String(text || "").trim();
    const m = t.match(/(?:#item=|^PANTRY:|^)([2-9A-HJ-NP-Z]{6})$/i);
    return m ? m[1].toUpperCase() : null;
  }
  const barcodeFrom = (text) => { const t = String(text || "").replace(/\s+/g, ""); return /^\d{8,14}$/.test(t) ? t : null; };
  const labelUrl = (code) => `${location.origin}/#item=${code}`;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  // ---------- UI helpers ----------
  let toastT;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, Math.max(2800, msg.length * 60)); }
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const PLACE_ICON = { Fridge: "fridge", Freezer: "snow" };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use"); use.setAttribute("href", "#i-" + name); svg.append(use);
    return svg;
  }
  function pill(exp) {
    const n = daysLeft(exp), u = urgency(n), d = parseDate(exp);
    return el("span", { class: "pill " + u.cls }, el("strong", {}, leftText(n)), el("em", {}, nice(d, d.getFullYear() !== new Date().getFullYear())));
  }
  const qtyText = (it) => `${Number.isFinite(+it.qty) ? +it.qty : 1} ${it.unit || ""}`.trim();
  function setStatus(msg) { const s = $("#status"); s.textContent = msg || ""; s.hidden = !msg; }

  // ---------- views ----------
  function showLogin(info = {}) {
    $("#appView").hidden = true; $("#dock").hidden = true; $("#loginView").hidden = false;
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    // With people added in Settings, ask for a name too (empty = household password)
    if (info.hasPeople !== undefined) {
      $("#nameField").hidden = !info.hasPeople;
      $("#nameField .small").hidden = !info.householdPassword;
      $("#pwLabel").textContent = info.hasPeople ? "Password" : "Household password";
    }
    ($("#nameField").hidden ? $("#pw") : $("#who")).focus();
  }
  function showApp(session) {
    $("#loginView").hidden = true; $("#appView").hidden = false; $("#dock").hidden = false;
    me = session.me || null;
    passwordProtected = !!session.passwordProtected;
    renderMeChip();
    $("#logout").hidden = !session.passwordProtected;
    $("#myPass").hidden = !me || me.id === "h";
    $("#meNote").textContent = session.offline ? "Offline right now." : me && session.passwordProtected ? `Logged in as ${me.name}${me.id === "h" ? " (the shared household password)" : ""}.` : "";
  }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginError").textContent = "";
    try {
      await api("POST", "/api/login", { name: $("#nameField").hidden ? "" : $("#who").value.trim(), password: $("#pw").value });
      $("#pw").value = "";
      start();
    } catch (err) { $("#loginError").textContent = err.message; }
  });
  $("#logout").addEventListener("click", async () => {
    await api("POST", "/api/logout").catch(() => {});
    if ("caches" in window) caches.delete("pantry-data").catch(() => {}); // don't keep the shelf on a logged-out phone
    items = new Map(); shopping = new Map(); render();
    start();
  });

  function showTab(name) {
    tab = name;
    document.querySelectorAll(".tabs button").forEach((b) => b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
    document.querySelectorAll(".view").forEach((v) => v.hidden = v.id !== "view-" + name);
    if (name === "recipes") loadRecipes(false);
    if (name === "settings") { loadSettings(); requestAnimationFrame(fitPreview); }
    if (name === "stats") loadHistory();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- render ----------
  const BANDS = [
    ["expired", "Expired", "Check before using or throw away"],
    ["soon", "Use this week", "7 days or less"],
    ["month", "Use this month", "8 to 30 days"],
    ["later", "Later", "More than a month"],
  ];
  function render() {
    $("#today").textContent = `Today is ${todayStart().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}. Use what expires first.`;
    const all = [...items.entries()].map(([id, it]) => ({ id, ...it })).filter((it) => it.expiry)
      .sort((a, b) => a.expiry.localeCompare(b.expiry) || String(a.name).localeCompare(String(b.name)));
    renderPlaces(all);
    const list = place === "All" ? all : all.filter((it) => (it.place || "Pantry") === place);
    const groups = { expired: [], soon: [], month: [], later: [] };
    for (const it of list) groups[urgency(daysLeft(it.expiry)).band].push(it);
    $("#n-exp").textContent = groups.expired.length;
    $("#n-soon").textContent = groups.soon.length;
    $("#n-ok").textContent = groups.month.length + groups.later.length;
    const host = $("#bands"); host.replaceChildren();
    for (const [key, title, sub] of BANDS) {
      const g = groups[key]; if (!g.length) continue;
      const ul = el("ul", { class: "list" });
      for (const it of g) {
        ul.append(el("li", {}, el("button", { class: "item u-" + urgency(daysLeft(it.expiry)).cls.slice(2), onclick: () => openItem(it.id) },
          el("span", { class: "name" }, it.name || "Unnamed item"),
          el("span", { class: "meta" }, icon(PLACE_ICON[it.place] || "jar"), `${it.place || "Pantry"} · ${qtyText(it)}`),
          pill(it.expiry))));
      }
      host.append(el("section", { class: "band", id: "band-" + key },
        el("div", { class: "band-head" }, el("h2", {}, title), el("small", {}, `${g.length} · ${sub}`)), ul));
    }
    $("#empty").hidden = !loaded || all.length > 0;
    $("#placeEmpty").hidden = !(all.length && !list.length);
    $("#placeEmpty").textContent = `Nothing in the ${place.toLowerCase()} right now.`;
    const names = new Set([...all.map((i) => i.name), ...[...shopping.values()].map((e) => e.name)].filter(Boolean));
    $("#nameHints").replaceChildren(...[...names].map((n) => el("option", { value: n })));
    $("#syncNote").textContent = lastSync ? `Updated ${new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    if (currentId && $("#itemDlg").open) { if (items.has(currentId)) fillItem(currentId); else $("#itemDlg").close(); }
    renderShopping();
    if (tab === "recipes") loadRecipes(false);
  }
  // Filter by where things are kept: All · Pantry 7 · Fridge 3 …
  function renderPlaces(all) {
    const counts = new Map();
    for (const it of all) counts.set(it.place || "Pantry", (counts.get(it.place || "Pantry") || 0) + 1);
    if (place !== "All" && !counts.has(place)) place = "All";
    const host = $("#places");
    host.hidden = counts.size < 2 && place === "All";
    const chip = (name, n, iconName) => el("button", { type: "button", "aria-pressed": String(place === name), onclick: () => { place = name; store.set("pantry.place", name); render(); } },
      iconName ? icon(iconName) : null, name, el("span", { class: "n" }, String(n)));
    host.replaceChildren(chip("All", all.length),
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => chip(name, n, PLACE_ICON[name] || "jar")));
  }
  document.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.jump; const t = $("#band-" + k) || (k === "later" ? $("#band-month") : null);
    if (t) t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }));

  // ---------- dialogs ----------
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
  });

  // ---------- add / edit ----------
  function openEdit(id, presetCode, presetBarcode) {
    editingId = id || null;
    pendingCode = presetCode || null;
    const it = id ? items.get(id) : null;
    editBarcode = it?.barcode || null;
    $("#edit-h").textContent = it ? "Edit or refill" : "Add item";
    $("#editCode").textContent = presetCode ? `New item for label ${presetCode}` : it ? `Label ${id}` : "A QR label is made when you save.";
    $("#f-name").value = it?.name || "";
    $("#f-qty").value = it ? it.qty : 1;
    $("#f-unit").value = it?.unit || "pcs";
    $("#f-place").value = it?.place || "Pantry";
    $("#f-exp").value = it?.expiry || "";
    setBarcodeNote(editBarcode ? `Barcode ${editBarcode}` : "");
    if (!$("#editDlg").open) $("#editDlg").showModal();
    if (presetBarcode) applyBarcode(presetBarcode);
    else if (!it) $("#f-name").focus();
  }
  function setBarcodeNote(text) { const n = $("#barcodeNote"); n.textContent = text; n.hidden = !text; }
  async function applyBarcode(code) {
    editBarcode = code;
    setBarcodeNote(`Barcode ${code}: looking it up…`);
    try {
      const { product } = await api("GET", `/api/barcode/${code}`);
      if (editBarcode !== code) return;
      if (product) {
        $("#f-name").value = product.name;
        if (product.unit) $("#f-unit").value = product.unit;
        if (product.place) $("#f-place").value = product.place;
        setBarcodeNote(`Barcode ${code}: ${product.source === "pantry" ? "filled in from your earlier items" : "found on Open Food Facts"}${product.quantity ? ` · ${product.quantity}` : ""}.`);
        $("#f-exp").focus();
      } else {
        setBarcodeNote(`Barcode ${code}: not found. Type the name and it'll be filled in next time.`);
        $("#f-name").focus();
      }
    } catch (err) {
      if (err.status !== 401) setBarcodeNote(`Barcode ${code}: ${err.message}`);
    }
  }
  $("#barcodeBtn").addEventListener("click", () => openScanner("barcode"));
  $("#quick").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const d = todayStart();
    if (b.dataset.days) d.setDate(d.getDate() + Number(b.dataset.days));
    if (b.dataset.months) d.setMonth(d.getMonth() + Number(b.dataset.months));
    $("#f-exp").value = iso(d);
  });
  async function saveItem(id, data) {
    const res = await api("PUT", `/api/items/${id}`, data);
    items.set(id, res.item);
    render();
    return res.item;
  }
  $("#editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = editingId || pendingCode || newCode();
    const prev = items.get(id);
    const qty = parseFloat($("#f-qty").value);
    const data = {
      name: $("#f-name").value.trim(), qty: Number.isFinite(qty) ? qty : 1, unit: $("#f-unit").value,
      place: $("#f-place").value, expiry: $("#f-exp").value, addedAt: prev?.addedAt || Date.now(),
      barcode: editBarcode || undefined,
    };
    if (!data.name || !data.expiry) return;
    $("#saveBtn").disabled = true;
    try {
      await saveItem(id, data);
      $("#editDlg").close();
      toast(prev ? "Saved" : "Added. Download the label and stick it on.");
      openItem(id);
    } catch (err) {
      if (err.status !== 401) toast(err.message || "Couldn't save. Check your connection and try again.");
    } finally { $("#saveBtn").disabled = false; }
  });
  $("#addBtn").addEventListener("click", () => openEdit());
  $("#emptyAdd").addEventListener("click", () => openEdit());

  // ---------- item detail ----------
  function fillItem(id) {
    const it = items.get(id); if (!it) return;
    $("#item-h").textContent = it.name;
    $("#itemPill").replaceChildren(pill(it.expiry));
    const d = parseDate(it.expiry);
    const f = $("#itemFacts"); f.replaceChildren();
    const rows = [["Quantity", qtyText(it)], ["Where", it.place || "Pantry"], ["Best before", nice(d, true)], ["Label code", id]];
    if (it.barcode) rows.push(["Barcode", it.barcode]);
    if (it.addedBy && it.addedBy !== "Household") rows.push(["Added by", it.addedBy]);
    for (const [k, v] of rows) f.append(el("dt", {}, k), el("dd", { class: k === "Label code" || k === "Barcode" ? "code" : "" }, v));
    $("#useOne").disabled = !(it.qty > 0);
    drawItemLabel($("#labelCanvas"), id, it);
  }
  function openItem(id) {
    currentId = id;
    $("#confirmBox").hidden = true;
    fillItem(id);
    if (!$("#itemDlg").open) $("#itemDlg").showModal();
  }
  $("#editItem").addEventListener("click", () => { $("#itemDlg").close(); openEdit(currentId); });
  function askFinished(lastOne) {
    const it = items.get(currentId);
    $("#confirmText").textContent = lastOne ? `That was the last one. Remove ${it?.name || "it"} from the shelf? You can reuse its label for something new.`
      : `Remove ${it?.name || "this item"} from the shelf? You can reuse its label for something new.`;
    document.querySelector('input[name="outcome"][value="used"]').checked = true;
    $("#outcomeSet").hidden = !(it?.qty > 0);
    $("#toShopping").checked = true;
    $("#confirmBox").hidden = false;
  }
  $("#useOne").addEventListener("click", async () => {
    const it = items.get(currentId); if (!it) return;
    try {
      const r = await api("POST", `/api/items/${currentId}/use`, { outcome: "used" });
      items.set(currentId, r.item); render(); fillItem(currentId);
      if (r.item.qty > 0) toast(`${r.item.qty} ${it.unit} left`); else askFinished(true);
    } catch (err) { if (err.status !== 401) toast(err.message || "Couldn't save. Try again."); }
  });
  $("#useAll").addEventListener("click", () => askFinished(false));
  $("#confirmNo").addEventListener("click", () => $("#confirmBox").hidden = true);
  $("#confirmYes").addEventListener("click", async () => {
    try {
      const outcome = document.querySelector('input[name="outcome"]:checked')?.value || "used";
      const r = await api("DELETE", `/api/items/${currentId}`, { addToShopping: $("#toShopping").checked, outcome });
      items.delete(currentId); $("#itemDlg").close();
      toast(r.addedToShopping ? "Removed and added to the shopping list" : "Removed from the shelf");
      refresh();
    } catch (err) { if (err.status !== 401) toast("Couldn't remove it. Try again."); }
  });

  // ---------- shopping list ----------
  function renderShopping() {
    const entries = [...shopping.entries()].map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => (a.done - b.done) || (a.addedAt - b.addedAt));
    const open = entries.filter((e) => !e.done).length;
    const c = $("#shopCount"); c.textContent = open; c.hidden = !open;
    $("#shopList").replaceChildren(...entries.map((e) => el("li", {},
      el("div", { class: "shop-row" + (e.done ? " done" : "") },
        el("label", {}, el("input", { type: "checkbox", checked: e.done, onchange: (ev) => toggleEntry(e.id, ev.target.checked) }), el("span", {}, e.name)),
        el("button", { class: "x", "aria-label": `Remove ${e.name}`, onclick: () => removeEntry(e.id) }, "×")))));
    $("#shopList").hidden = !entries.length;
    $("#shopEmpty").hidden = !!entries.length;
    $("#shopClear").hidden = !entries.some((e) => e.done);
  }
  async function putEntry(id, entry) {
    const r = await api("PUT", `/api/shopping/${id}`, entry);
    shopping.set(id, r.entry); renderShopping();
  }
  async function toggleEntry(id, done) {
    const e = shopping.get(id); if (!e) return;
    try { await putEntry(id, { ...e, done }); } catch (err) { if (err.status !== 401) { toast("Couldn't update the list."); renderShopping(); } }
  }
  async function removeEntry(id) {
    try { await api("DELETE", `/api/shopping/${id}`); shopping.delete(id); renderShopping(); } catch (err) { if (err.status !== 401) toast("Couldn't update the list."); }
  }
  $("#shopForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#shopInput").value.trim(); if (!name) return;
    try { await putEntry(newId(), { name, done: false, addedAt: Date.now() }); $("#shopInput").value = ""; $("#shopInput").focus(); }
    catch (err) { if (err.status !== 401) toast(err.message); }
  });
  $("#shopClear").addEventListener("click", async () => {
    try { const r = await api("POST", "/api/shopping/clear-done"); shopping = new Map(Object.entries(r.shopping)); renderShopping(); } catch (err) { if (err.status !== 401) toast("Couldn't update the list."); }
  });

  // ---------- recipes ----------
  let recipesLoading = false;
  async function loadRecipes(force) {
    const fp = [...items.values()].map((i) => i.name + i.expiry).sort().join("|");
    if (!force && (recipesLoading || recipesFor === fp)) return;
    recipesLoading = true; recipesFor = fp;
    $("#recipeNote").textContent = "Looking for recipes…";
    try {
      const r = await api("GET", "/api/recipes");
      const list = $("#recipeList");
      list.replaceChildren(...r.ideas.map((m) => el("a", { class: "recipe", href: m.url, target: "_blank", rel: "noopener" },
        el("img", { src: m.thumb + "/preview", alt: "", loading: "lazy" }),
        el("div", {}, el("strong", {}, m.name), el("span", {}, `Uses ${m.uses.join(", ")}`)))));
      if (r.error) $("#recipeNote").textContent = r.error;
      else if (!items.size) $("#recipeNote").textContent = "Add items to the shelf to get recipe ideas.";
      else if (!r.ideas.length) $("#recipeNote").textContent = `No recipes found for ${r.checked.slice(0, 4).join(", ")}. Recipes match on simple English names, like "rice" or "coconut milk".`;
      else $("#recipeNote").textContent = `Recipes using ${r.matched.map((x) => x.item).join(", ")}.`;
    } catch (err) {
      recipesFor = null;
      if (err.status !== 401) $("#recipeNote").textContent = "Couldn't load recipes. Try again later.";
    } finally { recipesLoading = false; }
  }
  $("#recipeRefresh").addEventListener("click", () => loadRecipes(true));

  // ---------- settings ----------
  const NAMES = { ntfy: "ntfy", telegram: "Telegram", email: "email", push: "phone notification" };
  let remLoaded = false;
  function describeReminders(r) {
    if (!r.channels.length) return "Not set up yet. Fill in the email below, or turn on phone notifications further down.";
    if (!r.enabled) return "Switched off. Nothing is sent until you switch it back on.";
    const how = r.channels.map((c) => NAMES[c] || c).join(" and ");
    return `Every day at ${r.time} (${r.tz}) by ${how}, when something expires within ${r.days} days or has expired.${r.lastSent ? ` Last checked ${r.lastSent}.` : ""}`;
  }
  async function loadSettings() {
    try {
      const s = await api("GET", "/api/settings");
      const r = s.reminders;
      $("#remStatus").textContent = describeReminders(r);
      if (!remLoaded) { // don't overwrite what someone is typing on a later refresh
        remLoaded = true;
        $("#r-enabled").checked = r.enabled;
        $("#r-time").value = r.time;
        const days = $("#r-days");
        if (![...days.options].some((o) => +o.value === r.days)) days.append(el("option", { value: r.days }, `${r.days} days`));
        days.value = String(r.days);
        $("#r-to").value = r.mailTo;
        $("#r-user").value = r.smtpUser;
        $("#r-pass").value = "";
        $("#r-pass").placeholder = r.hasPassword ? "Saved. Leave empty to keep it" : "16 letters from Google";
        $("#r-host").value = r.smtpHost;
        $("#r-port").value = String(r.smtpPort);
      }
      renderBackups(s.backups);
      renderPush(s.push);
      loadPeople();
    } catch (err) { if (err.status !== 401) $("#remStatus").textContent = "Couldn't load the settings."; }
  }
  async function saveReminders() {
    await api("PUT", "/api/settings/reminders", {
      enabled: $("#r-enabled").checked, time: $("#r-time").value, days: Number($("#r-days").value), mailTo: $("#r-to").value,
      smtpUser: $("#r-user").value.trim(), smtpPass: $("#r-pass").value, smtpHost: $("#r-host").value.trim() || "smtp.gmail.com", smtpPort: Number($("#r-port").value),
    });
    remLoaded = false;
    await loadSettings();
  }
  $("#remForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#remSave").disabled = true;
    try { await saveReminders(); toast("Reminder settings saved"); }
    catch (err) { if (err.status !== 401) toast(err.message); }
    finally { $("#remSave").disabled = false; }
  });
  $("#remTest").addEventListener("click", async () => {
    $("#remTest").disabled = true;
    try {
      await saveReminders(); // test exactly what's on screen
      const r = await api("POST", "/api/reminders/test");
      if (r.failed?.length) toast(`Not sent. ${r.failed.map((f) => f.error).join(" ")}`);
      else toast(`Test sent by ${r.sent.map((c) => NAMES[c]).join(" and ")}. Check your inbox.`);
    } catch (err) { if (err.status !== 401) toast(err.message); }
    finally { $("#remTest").disabled = false; }
  });
  $("#bakRun").addEventListener("click", async () => {
    try { await api("POST", "/api/backup/run"); toast("Backup saved"); loadSettings(); } catch (err) { if (err.status !== 401) toast(err.message); }
  });

  // ---------- backups: weekly email copy and restore ----------
  const fileDate = (f) => f.replace(/^pantry-|\.json$/g, "").replace(/^before-restore-(\d{4}-\d{2}-\d{2})-(\d\d)(\d\d)\d\d$/, "$1 $2:$3 (before a restore)");
  function renderBackups(b) {
    $("#bakStatus").textContent = b.enabled
      ? `Every night at ${b.time}, kept for ${b.keepDays} days. ${b.count ? `${b.count} saved, latest ${fileDate(b.latest)}.` : "None saved yet."}`
      : "Off: the server can't write to its backup folder. See the setup guide.";
    $("#bakRun").hidden = !b.enabled;
    $("#bakEmail").checked = b.emailCopy;
    $("#bakEmail").disabled = !b.emailReady && !b.emailCopy;
    $("#bakEmailNote").textContent = !b.emailReady ? "Set up the reminder email above first; the copy goes to the same addresses."
      : `A summary of the shelf with a PDF report, plus the backup file, so a copy is kept in your inbox in case the server's disk fails. It goes to the reminder email addresses.${b.lastEmailed ? ` Last sent ${b.lastEmailed}.` : ""}`;
    const pick = $("#bakPick"), files = b.files || [];
    pick.replaceChildren(...files.map((f) => el("option", { value: f.file }, fileDate(f.file))));
    pick.closest(".field").hidden = !files.length;
    $("#bakRestore").hidden = !files.length;
  }
  $("#bakEmail").addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      const r = await api("PUT", "/api/settings/backups", { emailCopy: on });
      renderBackups(r.backups);
      if (on) { toast("Sending the first copy now…"); await api("POST", "/api/backup/email"); toast("Backup emailed. Check your inbox."); loadSettings(); }
      else toast("Weekly email copy switched off");
    } catch (err) { if (err.status !== 401) { toast(err.message); loadSettings(); } }
  });
  async function restore(headers, body, label) {
    if (!confirm(`Put back ${label}? This replaces the shelf, shopping list and history for everyone. What's there now is saved first.`)) return;
    try {
      const res = await fetch("/api/backup/restore", { method: "POST", headers, body, credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error(data.error || "Couldn't restore it.");
      toast(`Restored: ${data.items} item${data.items === 1 ? "" : "s"} on the shelf.`);
      recipesFor = null; await refresh(); loadSettings();
    } catch (err) { toast(err.message); }
  }
  $("#bakRestore").addEventListener("click", () => { const f = $("#bakPick").value; if (f) restore({ "X-Restore-File": f }, null, `the backup from ${fileDate(f)}`); });
  $("#bakFile").addEventListener("change", (e) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
    restore({ "Content-Type": "application/json" }, file, `"${file.name}"`);
  });

  // ---------- avatars ----------
  const personByName = (name) => people.find((p) => p.name === name);
  // A round avatar: their photo, their emoji, or the first letter of their name
  function avatarEl(p, cls = "avatar") {
    const a = p?.avatar;
    if (p?.id === "h") return el("span", { class: cls + " emoji", "aria-hidden": "true" }, "🏠");
    if (a?.photo) return el("span", { class: cls, "aria-hidden": "true" }, el("img", { src: `/api/people/${p.id}/avatar?v=${a.photo}`, alt: "", loading: "lazy" }));
    if (a?.emoji) return el("span", { class: cls + " emoji", "aria-hidden": "true" }, a.emoji);
    return el("span", { class: cls, "aria-hidden": "true" }, (p?.name || "?").slice(0, 1).toUpperCase());
  }
  const avatarFor = (name, cls) => avatarEl(personByName(name) || (name === "Household" ? { id: "h", name } : { name }), cls);
  async function loadPeopleData() {
    try { const r = await api("GET", "/api/people"); people = r.people; emojiChoices = r.emoji || []; renderMeChip(); return r; }
    catch (err) { if (err.status !== 401) console.warn("Couldn't load people", err); return null; }
  }
  function renderMeChip() {
    const chip = $("#meChip");
    chip.hidden = !me || !passwordProtected;
    if (chip.hidden) return;
    const p = me.id === "h" ? { id: "h", name: "Household" } : personByName(me.name) || me;
    chip.replaceChildren(avatarEl(p, "avatar sm"), el("span", {}, p.name));
    chip.setAttribute("aria-label", `Logged in as ${p.name}. Open settings`);
  }
  $("#meChip").addEventListener("click", () => { showTab("settings"); });

  let avatarFor_ = null; // person the avatar dialog is for
  function openAvatar(p) {
    avatarFor_ = p;
    $("#avatar-h").textContent = p.id === me?.id ? "Your photo" : `Photo for ${p.name}`;
    $("#avatarPreview").replaceChildren(avatarEl(p, "avatar xl"));
    $("#avatarRemove").hidden = !p.avatar;
    $("#emojiGrid").replaceChildren(...emojiChoices.map((e) => el("button", { type: "button", "aria-pressed": String(p.avatar?.emoji === e), "aria-label": `Avatar ${e}`, onclick: () => setAvatar({ emoji: e }) }, e)));
    if (!$("#avatarDlg").open) $("#avatarDlg").showModal();
  }
  async function afterAvatar(avatar) {
    await loadPeopleData(); loadPeople();
    const p = people.find((x) => x.id === avatarFor_?.id);
    if (p) openAvatar(p);
    if (tab === "stats") loadHistory();
    toast(avatar ? "Photo updated" : "Photo removed");
  }
  async function setAvatar(body) {
    try { const r = await api("PUT", `/api/people/${avatarFor_.id}/avatar`, body); await afterAvatar(r.avatar); }
    catch (err) { if (err.status !== 401) toast(err.message); }
  }
  // Square-crop the photo from its middle and shrink it to 256 x 256 before upload
  async function squareAvatar(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const side = Math.min(img.naturalWidth, img.naturalHeight), cv = document.createElement("canvas");
      cv.width = cv.height = 256;
      cv.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      return await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85));
    } finally { URL.revokeObjectURL(url); }
  }
  $("#avatarInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file || !avatarFor_) return;
    try {
      const blob = await squareAvatar(file);
      const res = await fetch(`/api/people/${avatarFor_.id}/avatar`, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob, credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error(data.error || "Couldn't upload the photo.");
      await afterAvatar(data.avatar);
    } catch (err) { toast(err.message || "Couldn't upload the photo. Try again."); }
  });
  $("#avatarRemove").addEventListener("click", async () => {
    try { await api("DELETE", `/api/people/${avatarFor_.id}/avatar`); await afterAvatar(null); } catch (err) { if (err.status !== 401) toast(err.message); }
  });

  // ---------- people ----------
  let passFor = null; // person id the password dialog is for
  async function loadPeople() {
    try {
      const r = await loadPeopleData();
      if (!r) throw new Error("people");
      $("#hhNote").textContent = r.householdPassword ? "The household password keeps working too." : "";
      $("#peopleList").replaceChildren(...r.people.map((p) => el("li", {},
        el("span", { class: "who" },
          el("button", { class: "avatar-btn", type: "button", "aria-label": `Change the photo for ${p.name}`, onclick: () => openAvatar(p) }, avatarEl(p, "avatar md"), el("span", { class: "cam", "aria-hidden": "true" }, icon("image"))),
          p.name, p.id === r.me?.id ? el("em", {}, " (you)") : null),
        el("span", { class: "tools" },
          el("button", { class: "linkish", type: "button", onclick: () => openAvatar(p) }, "Photo"),
          el("button", { class: "linkish", type: "button", onclick: () => openPass(p) }, "New password"),
          p.id === r.me?.id ? null : el("button", { class: "linkish danger", type: "button", onclick: () => removePerson(p) }, "Remove")))));
      $("#peopleList").hidden = !r.people.length;
    } catch (err) { if (err.status !== 401) $("#hhNote").textContent = "Couldn't load the people list."; }
  }
  $("#personForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/people", { name: $("#p-name").value, password: $("#p-pass").value });
      toast(`${$("#p-name").value.trim()} can now log in with their own password`);
      $("#p-name").value = ""; $("#p-pass").value = ""; loadPeople();
    } catch (err) { if (err.status !== 401) toast(err.message); }
  });
  async function removePerson(p) {
    if (!confirm(`Remove ${p.name}? They'll be logged out. What they did stays in the history.`)) return;
    try { await api("DELETE", `/api/people/${p.id}`); toast(`${p.name} removed`); loadPeople(); } catch (err) { if (err.status !== 401) toast(err.message); }
  }
  function openPass(p) {
    passFor = p.id;
    $("#pass-h").textContent = p.id === me?.id ? "Change my password" : `New password for ${p.name}`;
    $("#passNote").textContent = p.id === me?.id ? "Your other phones will need the new password." : `${p.name} will need to log in again with it.`;
    $("#newPass").value = ""; $("#passDlg").showModal(); $("#newPass").focus();
  }
  $("#myPass").addEventListener("click", () => me && openPass(me));
  $("#passForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("PUT", `/api/people/${passFor}`, { password: $("#newPass").value }); $("#passDlg").close(); toast("Password changed"); }
    catch (err) { if (err.status !== 401) toast(err.message); }
  });

  // ---------- history ----------
  const OUT = { added: "added", used: "used", wasted: "threw away" };
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); return d < 7 ? `${d} day${d === 1 ? "" : "s"} ago` : nice(new Date(t), new Date(t).getFullYear() !== new Date().getFullYear());
  }
  const monthName = (k) => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short" }); };
  async function loadHistory() {
    try {
      const h = await api("GET", "/api/history");
      const cur = h.months[h.months.length - 1], total = cur.used + cur.wasted;
      $("#st-used").textContent = cur.used; $("#st-wasted").textContent = cur.wasted;
      $("#st-note").textContent = !total ? "Nothing used or thrown away yet this month. Use \"Used one\" and \"Finished\" on an item to count it."
        : cur.wasted ? `${Math.round(cur.wasted / total * 100)}% of what left the shelf this month was thrown away.` : "Nothing thrown away this month. Nice.";
      const max = Math.max(1, ...h.months.map((m) => m.used + m.wasted));
      $("#st-months").replaceChildren(...h.months.map((m) => {
        const bar = el("span", { class: "bar" }, el("span", { class: "seg ok" }), el("span", { class: "seg bad" }));
        bar.children[0].style.setProperty("--w", `${m.used / max * 100}%`);
        bar.children[1].style.setProperty("--w", `${m.wasted / max * 100}%`);
        return el("li", {}, el("span", { class: "m" }, monthName(m.month)), bar, el("span", { class: "v" }, `${m.used} / ${m.wasted}`));
      }));
      $("#st-top-card").hidden = !h.topWasted.length;
      $("#st-top").replaceChildren(...h.topWasted.map((w) => el("li", {}, el("span", {}, w.name), el("b", {}, String(w.count)))));
      $("#st-people-card").hidden = !h.people.length;
      if (!people.length) await loadPeopleData();
      $("#st-people").replaceChildren(...h.people.map((p) => el("tr", {}, el("th", { scope: "row" }, el("span", { class: "who" }, avatarFor(p.name, "avatar sm"), p.name)), el("td", {}, String(p.added || 0)), el("td", {}, String(p.used || 0)), el("td", {}, String(p.wasted || 0)))));
      $("#st-recent").replaceChildren(...(h.recent.length ? h.recent.map((e) => el("li", { class: "a-" + e.outcome },
        avatarFor(e.by, "avatar sm"),
        el("span", {}, el("b", {}, e.by), ` ${OUT[e.outcome] || e.outcome} `, (+e.qty === 1 && (!e.unit || e.unit === "pcs")) || !+e.qty ? "" : `${+e.qty} ${e.unit || ""} of `.replace(" of", e.unit ? " of" : ""), el("b", {}, e.name)),
        el("small", {}, ago(e.at)))) : [el("li", { class: "muted" }, "Nothing yet.")]));
    } catch (err) { if (err.status !== 401) $("#st-note").textContent = "Couldn't load the history."; }
  }

  // ---------- phone notifications ----------
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function renderPush(info) {
    const st = $("#pushStatus"), on = $("#pushOn"), off = $("#pushOff"), test = $("#pushTest");
    on.hidden = off.hidden = test.hidden = true;
    const others = info?.devices || 0;
    if (!pushSupported()) {
      st.textContent = isIOS && !standalone()
        ? "On iPhone, add Pantry Shelf to the home screen first (the steps are under This device, below), open it from the new icon, and come back here."
        : "This browser can't show notifications from websites. Try Chrome on Android, or Safari from the home screen on iPhone.";
      return;
    }
    if (Notification.permission === "denied") { st.textContent = "Notifications are blocked for this site. Allow them in the browser or phone settings, then reload."; return; }
    const sub = await currentSub().catch(() => null);
    if (sub) {
      st.textContent = `On for this phone. The daily reminder pops up here.${others > 1 ? ` ${others} phones get it in total.` : ""}`;
      off.hidden = test.hidden = false;
    } else {
      st.textContent = `Get the daily reminder as a notification on this phone, at the reminder time above.${others ? ` ${others} other phone${others === 1 ? " has" : "s have"} it on.` : ""}`;
      on.hidden = false;
    }
  }
  function keyBytes(b64) {
    const s = atob((b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  $("#pushOn").addEventListener("click", async () => {
    try {
      if (await Notification.requestPermission() !== "granted") { toast("Notifications weren't allowed."); return loadSettings(); }
      const { key } = await api("GET", "/api/push/key");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await api("POST", "/api/push", { subscription: sub.toJSON() });
      toast("Notifications on for this phone");
      loadSettings();
    } catch (err) { if (err.status !== 401) toast(err.message || "Couldn't turn notifications on."); }
  });
  $("#pushOff").addEventListener("click", async () => {
    try {
      const sub = await currentSub();
      if (sub) { await api("DELETE", "/api/push", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      toast("Notifications off for this phone"); loadSettings();
    } catch (err) { if (err.status !== 401) toast(err.message); }
  });
  $("#pushTest").addEventListener("click", async () => {
    try {
      const sub = await currentSub(); if (!sub) return loadSettings();
      await api("POST", "/api/push/test", { endpoint: sub.endpoint });
      toast("Sent. It should pop up in a few seconds.");
    } catch (err) { if (err.status !== 401) toast(err.message); }
  });

  // ---------- install on the home screen ----------
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; renderInstall(); });
  window.addEventListener("appinstalled", () => { installEvt = null; renderInstall(); });
  // Which phone and browser, so the home-screen steps match what's on screen
  function browserKind() {
    const ua = navigator.userAgent;
    if (isIOS) {
      if (/CriOS/.test(ua)) return "ios-chrome";
      if (/FxiOS|EdgiOS/.test(ua)) return "ios-other";
      if (!/Safari\//.test(ua) || /FBAN|FBAV|Instagram|GSA\/|Line\/|Messenger|GoogleMail/.test(ua)) return "ios-inapp"; // opened inside Gmail, Messenger…
      return "ios-safari";
    }
    if (/SamsungBrowser/.test(ua)) return "samsung";
    if (/Android/.test(ua)) return /; wv\)/.test(ua) ? "android-inapp" : "android";
    return "desktop";
  }
  const ICON_STEP = (iconName, text) => [icon(iconName), " ", text];
  const INSTALL_STEPS = {
    "ios-safari": [
      ["Tap the ", ...ICON_STEP("dots", "button"), " at the bottom right, next to the address. On older iPhones, tap the ", ...ICON_STEP("share", "Share"), " button in the bottom bar instead and skip the next step."],
      ["Tap ", ...ICON_STEP("share", "Share"), "."],
      ["Scroll down the list and tap ", ...ICON_STEP("addsq", "Add to Home Screen"), ". Don't see it? Tap ", el("b", {}, "View More"), " first."],
      ["Tap ", el("b", {}, "Add"), ", then open Pantry Shelf from the new icon on your home screen."],
    ],
    "ios-chrome": [
      ["Tap ", ...ICON_STEP("share", "Share"), " at the top right, inside the address bar."],
      ["Scroll down and tap ", ...ICON_STEP("addsq", "Add to Home Screen"), "."],
      ["Tap ", el("b", {}, "Add"), ", then open Pantry Shelf from the new icon."],
    ],
    "ios-other": [
      ["Open the browser menu and tap ", ...ICON_STEP("share", "Share"), "."],
      ["Tap ", ...ICON_STEP("addsq", "Add to Home Screen"), ", then ", el("b", {}, "Add"), "."],
    ],
    "ios-inapp": [
      ["This page is open inside another app, which can't add it to the home screen. Open it in Safari first: tap ", ...ICON_STEP("dots", ""), " or the compass icon and choose ", el("b", {}, "Open in Safari"), ", or copy the address into Safari."],
      ["In Safari, come back to Settings > This device for the next steps."],
    ],
    android: [
      ["Tap the ", el("b", {}, "⋮"), " menu at the top right of Chrome."],
      ["Tap ", el("b", {}, "Add to Home screen"), " or ", el("b", {}, "Install app"), ", then ", el("b", {}, "Install"), "."],
    ],
    "android-inapp": [
      ["This page is open inside another app. Tap its ", el("b", {}, "⋮"), " menu and choose ", el("b", {}, "Open in Chrome"), ", then come back here."],
    ],
    samsung: [
      ["Tap the ", el("b", {}, "≡"), " menu at the bottom right."],
      ["Tap ", el("b", {}, "Add page to"), ", then ", el("b", {}, "Home screen"), "."],
    ],
    desktop: [
      ["In Chrome or Edge, click the install icon at the right end of the address bar, or open the menu and choose ", el("b", {}, "Install Pantry Shelf"), "."],
    ],
  };
  function renderInstall() {
    const kind = browserKind(), steps = $("#installSteps");
    $("#installBtn").hidden = !installEvt;
    steps.hidden = standalone() || !!installEvt;
    if (standalone()) $("#installNote").textContent = "Opened from the home screen. The shelf still shows when you're offline.";
    else if (installEvt) $("#installNote").textContent = "Add Pantry Shelf to the home screen to open it like an app, even offline.";
    else {
      $("#installNote").textContent = "To open it like an app, add it to your home screen:";
      steps.replaceChildren(...INSTALL_STEPS[kind].map((parts) => el("li", {}, ...parts)));
    }
  }
  $("#installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderInstall(); });
  renderInstall();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Offline support unavailable:", e));

  // ---------- cover photo ----------
  let coverShown, coverPos = { x: 50, y: 50 }, coverImg = null, posDirty = false;
  function applyCover(v, pos) {
    if (pos && !posDirty) coverPos = pos;
    const where = `${coverPos.x}% ${coverPos.y}%`;
    for (const node of [document.querySelector(".hero"), $("#coverPreview")]) node.style.setProperty("--cover-pos", where);
    $("#coverX").value = coverPos.x; $("#coverY").value = coverPos.y;
    if (v === coverShown) return;
    coverShown = v;
    for (const node of [document.querySelector(".hero"), $("#coverPreview")]) {
      if (v) node.style.setProperty("--cover", `url("/cover.jpg?v=${encodeURIComponent(v)}")`); else node.style.removeProperty("--cover");
      node.classList.toggle("has-cover", !!v);
    }
    $("#coverEmpty").hidden = !!v;
    $("#coverRemove").hidden = !v;
    $("#coverHint").hidden = $("#coverSliders").hidden = !v;
    coverImg = null;
    if (v) { const img = new Image(); img.src = `/cover.jpg?v=${encodeURIComponent(v)}`; img.decode().then(() => { coverImg = img; fitPreview(); }).catch(() => {}); }
  }
  // Make the preview the same shape as the header, so what you see there is what the header shows
  function fitPreview() {
    const hero = document.querySelector(".hero"), pv = $("#coverPreview");
    if (hero.offsetWidth && hero.offsetHeight) pv.style.setProperty("--ratio", `${hero.offsetWidth} / ${hero.offsetHeight}`);
    if (!coverImg) return;
    // A slider does nothing when the photo already fits that way
    const box = pv.getBoundingClientRect(), o = overflow(box);
    $("#coverX").disabled = o.x < 1; $("#coverY").disabled = o.y < 1;
  }
  function overflow(box) {
    if (!coverImg) return { x: 0, y: 0 };
    const sc = Math.max(box.width / coverImg.naturalWidth, box.height / coverImg.naturalHeight);
    return { x: coverImg.naturalWidth * sc - box.width, y: coverImg.naturalHeight * sc - box.height };
  }
  window.addEventListener("resize", fitPreview);
  let posTimer;
  function setPos(x, y) {
    coverPos = { x: Math.round(Math.min(100, Math.max(0, x))), y: Math.round(Math.min(100, Math.max(0, y))) };
    posDirty = true; applyCover(coverShown);
    clearTimeout(posTimer);
    posTimer = setTimeout(async () => {
      try { await api("PUT", "/api/cover/position", coverPos); } catch (err) { if (err.status !== 401) toast("Couldn't save the position."); }
      posDirty = false;
    }, 500);
  }
  $("#coverX").addEventListener("input", (e) => setPos(+e.target.value, coverPos.y));
  $("#coverY").addEventListener("input", (e) => setPos(coverPos.x, +e.target.value));
  // Drag the photo: moving it down shows more of its top
  let drag = null;
  $("#coverPreview").addEventListener("pointerdown", (e) => {
    if (!coverShown || !coverImg) return;
    drag = { x: e.clientX, y: e.clientY, pos: { ...coverPos }, o: overflow($("#coverPreview").getBoundingClientRect()) };
    $("#coverPreview").setPointerCapture(e.pointerId); $("#coverPreview").classList.add("dragging");
  });
  $("#coverPreview").addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = drag.o.x ? (e.clientX - drag.x) / drag.o.x * 100 : 0, dy = drag.o.y ? (e.clientY - drag.y) / drag.o.y * 100 : 0;
    setPos(drag.pos.x - dx, drag.pos.y - dy);
  });
  const endDrag = () => { drag = null; $("#coverPreview").classList.remove("dragging"); };
  $("#coverPreview").addEventListener("pointerup", endDrag);
  $("#coverPreview").addEventListener("pointercancel", endDrag);

  // Shrink the photo on the phone before upload: 1800px wide JPEG is plenty for a header
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const scale = Math.min(1, 1800 / img.naturalWidth);
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      return await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.82));
    } finally { URL.revokeObjectURL(url); }
  }
  $("#coverInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
    toast("Uploading the photo…");
    try {
      const blob = await shrink(file);
      const res = await fetch("/api/cover", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob, credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return showLogin();
      if (!res.ok) throw new Error(data.error || "Couldn't upload the photo. Try again.");
      posDirty = false; applyCover(data.cover, data.coverPos); toast("Cover photo updated. Drag it to choose which part shows.");
    } catch (err) { toast(err.message || "Couldn't upload the photo. Try again."); }
  });
  $("#coverRemove").addEventListener("click", async () => {
    try { const r = await api("DELETE", "/api/cover"); applyCover(r.cover); toast("Cover photo removed"); } catch (err) { if (err.status !== 401) toast("Couldn't remove it. Try again."); }
  });

  // ---------- QR drawing ----------
  function drawQR(ctx, text, x, y, size) {
    ctx.fillStyle = "#fff"; ctx.fillRect(x, y, size, size);
    if (typeof qrcode !== "function") { ctx.fillStyle = "#000"; ctx.font = "16px sans-serif"; ctx.fillText("QR unavailable", x + 10, y + size / 2); return; }
    const q = qrcode(0, "M"); q.addData(text); q.make();
    const n = q.getModuleCount(), quiet = 2, cell = Math.floor(size / (n + quiet * 2)), off = Math.floor((size - cell * n) / 2);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
  }
  function fitFont(ctx, text, maxW, size, weight) {
    let s = size; do { ctx.font = `${weight} ${s}px "Bricolage Grotesque", system-ui, sans-serif`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 14);
  }
  function drawItemLabel(cv, id, it) {
    const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1e2419"; ctx.lineWidth = 3; ctx.strokeRect(6, 6, W - 12, H - 12);
    drawQR(ctx, labelUrl(id), 20, 20, H - 40);
    const tx = H, maxW = W - tx - 24;
    ctx.fillStyle = "#1e2419"; ctx.textBaseline = "top";
    fitFont(ctx, it.name, maxW, 44, 800); ctx.fillText(it.name, tx, 40, maxW);
    ctx.font = `500 22px "Atkinson Hyperlegible", system-ui, sans-serif`; ctx.fillStyle = "#646b5c";
    ctx.fillText("BEST BEFORE", tx, 120);
    ctx.font = `800 40px "Bricolage Grotesque", system-ui, sans-serif`; ctx.fillStyle = "#1e2419";
    ctx.fillText(nice(parseDate(it.expiry), true), tx, 148, maxW);
    ctx.font = `500 22px "IBM Plex Mono", ui-monospace, monospace`; ctx.fillStyle = "#646b5c";
    ctx.fillText(id, tx, 228);
  }
  async function downloadCanvas(cv, filename) {
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const file = new File([blob], filename, { type: "image/png" });
    // On phones, the share sheet lets people print or save to Photos directly
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $("#saveLabel").addEventListener("click", () => {
    const it = items.get(currentId); if (!it) return;
    downloadCanvas($("#labelCanvas"), `pantry-label-${(it.name || "item").replace(/[^\w-]+/g, "-").toLowerCase()}-${currentId}.png`);
  });
  $("#blankSheet").addEventListener("click", () => {
    // A4 at 150 dpi: 3 x 8 labels with QR, code and write-in lines
    const cv = document.createElement("canvas"); cv.width = 1240; cv.height = 1754;
    const ctx = cv.getContext("2d"), cols = 3, rows = 8, mx = 40, my = 60, w = (cv.width - mx * 2) / cols, h = (cv.height - my * 2) / rows;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = mx + c * w, y = my + r * h, code = newCode(), q = h - 30;
      ctx.strokeStyle = "#c8ccbf"; ctx.lineWidth = 1; ctx.setLineDash([6, 6]); ctx.strokeRect(x + 4, y + 4, w - 8, h - 8); ctx.setLineDash([]);
      drawQR(ctx, labelUrl(code), x + 14, y + 15, q);
      const tx = x + q + 26, lw = w - q - 44;
      ctx.fillStyle = "#1e2419"; ctx.font = `500 20px "IBM Plex Mono", monospace`; ctx.textBaseline = "top"; ctx.fillText(code, tx, y + 22);
      ctx.strokeStyle = "#1e2419"; ctx.lineWidth = 1.5;
      ctx.font = `14px "Atkinson Hyperlegible", sans-serif`; ctx.fillStyle = "#646b5c";
      ctx.fillText("Item", tx, y + 70); ctx.beginPath(); ctx.moveTo(tx, y + 106); ctx.lineTo(tx + lw, y + 106); ctx.stroke();
      ctx.fillText("Best before", tx, y + 118); ctx.beginPath(); ctx.moveTo(tx, y + 160); ctx.lineTo(tx + lw, y + 160); ctx.stroke();
    }
    downloadCanvas(cv, `pantry-blank-labels-${iso(new Date())}.png`);
  });

  // ---------- scanning: QR labels and product barcodes ----------
  let stream = null, scanning = false, detector = null, scanMode = "any";
  (async () => {
    try {
      if (!("BarcodeDetector" in window)) return;
      const want = ["qr_code", "ean_13", "ean_8", "upc_a", "upc_e"];
      const have = await BarcodeDetector.getSupportedFormats();
      const formats = want.filter((f) => have.includes(f));
      if (formats.length) detector = new BarcodeDetector({ formats });
    } catch {}
  })();
  let zxReader = null;
  function zxing() {
    if (zxReader || typeof ZXing === "undefined") return zxReader;
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxReader = new ZXing.MultiFormatReader(); zxReader.setHints(hints);
    return zxReader;
  }
  const work = document.createElement("canvas");
  async function decode(source, w, h) {
    if (detector) { try { const r = await detector.detect(source); if (r[0]) return r[0].rawValue; } catch {} }
    const scale = Math.min(1, 1000 / Math.max(w, h));
    work.width = Math.round(w * scale); work.height = Math.round(h * scale);
    const ctx = work.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, work.width, work.height);
    if (scanMode !== "barcode" && typeof jsQR === "function") {
      const img = ctx.getImageData(0, 0, work.width, work.height);
      const res = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
      if (res) return res.data;
    }
    const reader = zxing();
    if (reader) {
      try {
        const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(work)));
        return reader.decodeWithState(bmp).getText();
      } catch {} finally { reader.reset(); }
    }
    return null;
  }
  const usable = (r) => (scanMode === "barcode" ? !!barcodeFrom(r) : !!(codeFrom(r) || barcodeFrom(r)));
  function openCode(code) {
    if (items.has(code)) openItem(code);
    else openEdit(null, code);
  }
  function openBarcode(code) {
    const matches = [...items.entries()].filter(([, it]) => it.barcode === code).sort((a, b) => a[1].expiry.localeCompare(b[1].expiry));
    if (matches.length) { openItem(matches[0][0]); if (matches.length > 1) toast(`${matches.length} of these on the shelf. Showing the one that expires first.`); }
    else openEdit(null, null, code);
  }
  function handleCode(raw) {
    const label = codeFrom(raw), barcode = barcodeFrom(raw);
    stopCamera(); $("#scanDlg").close();
    if (scanMode === "barcode") {
      if (barcode) applyBarcode(barcode); else toast("That isn't a product barcode.");
      return;
    }
    if (label) openCode(label);
    else if (barcode) openBarcode(barcode);
    else toast("That code isn't a pantry label or a product barcode.");
  }
  async function startCamera() {
    $("#vf").hidden = true; $("#scanHint").textContent = "Starting the camera…";
    if (!navigator.mediaDevices?.getUserMedia) { $("#scanHint").textContent = "Take a photo instead, or type the code."; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch { stream = null; $("#scanHint").textContent = "The camera isn't available. Take a photo instead, or type the code."; return; }
    if (!$("#scanDlg").open) { stopCamera(); return; }
    const v = $("#video"); v.srcObject = stream; await v.play().catch(() => {});
    $("#vf").hidden = false;
    $("#scanHint").textContent = scanMode === "barcode" ? "Point the camera at the product's barcode. Hold it level and fill the frame." : "Point the camera at a pantry label or a product barcode.";
    scanning = true;
    const tickScan = async () => {
      if (!scanning) return;
      if (v.readyState >= 2) { const r = await decode(v, v.videoWidth, v.videoHeight); if (r && usable(r)) { handleCode(r); return; } }
      setTimeout(() => requestAnimationFrame(tickScan), 200);
    };
    tickScan();
  }
  function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } $("#vf").hidden = true; }
  function openScanner(mode) {
    scanMode = mode;
    $("#scan-h").textContent = mode === "barcode" ? "Scan the product barcode" : "Scan a label or barcode";
    $("#manualLabel").textContent = mode === "barcode" ? "Or type the number under the barcode" : "Or type the code under the QR, or the barcode number";
    $("#manualCode").placeholder = mode === "barcode" ? "8712345678906" : "K7M2QX or 8712345678906";
    $("#manualCode").value = "";
    $("#scanDlg").showModal();
    startCamera();
  }
  $("#scanDlg").addEventListener("close", stopCamera);
  $("#scanBtn").addEventListener("click", () => openScanner("any"));
  $("#photo").addEventListener("change", async (e) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
    $("#scanHint").textContent = "Reading the photo…";
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const r = await decode(img, img.naturalWidth, img.naturalHeight);
      if (r && usable(r)) handleCode(r); else $("#scanHint").textContent = "No code found. Try again closer, with the code flat and well lit.";
    } catch { $("#scanHint").textContent = "Couldn't open that photo. Try again."; }
    finally { URL.revokeObjectURL(url); }
  });
  $("#manualForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#manualCode").value;
    if (!usable(v)) { $("#scanHint").textContent = scanMode === "barcode" ? "Barcodes are 8 to 14 digits." : "Label codes are 6 letters and numbers, like K7M2QX. Barcodes are 8 to 14 digits."; return; }
    handleCode(v);
  });

  // A label scanned with the phone's own camera app opens /#item=CODE
  function openFromHash() {
    const code = codeFrom(location.hash);
    if (!code || !loaded) return;
    history.replaceState(null, "", location.pathname);
    openCode(code);
  }
  window.addEventListener("hashchange", openFromHash);

  // ---------- start ----------
  let pollTimer = null;
  async function start() {
    let session;
    try { session = await api("GET", "/api/session"); } catch (e) { if (e.status !== 401) setStatus("Can't reach the server. Check your connection and reload."); return; }
    showApp(session);
    await refresh();
    loadPeopleData();
    openFromHash();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("#appView").hidden) refresh(); });
  start();
})();
