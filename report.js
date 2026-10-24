// The pantry report: an HTML email with a summary, and the same summary as a PDF. The weekly
// report and the daily reminder email (daily: true, a shorter email) both use it.
const PDFDocument = require("pdfkit");

const COLORS = { ink: "#1b2216", muted: "#5f6857", line: "#d7ddcf", soft: "#f6f8f3", accent: "#2f5d22", hero: "#234a1a",
  expired: "#b3261e", expiredBg: "#fbe4e1", soon: "#9a5200", soonBg: "#fdebd0", ok: "#2f6b3a", okBg: "#dfeedd", low: "#2f5a8a", lowBg: "#e2ebf5" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const niceDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const qty = (it) => `${Number.isFinite(+it.qty) ? +it.qty : 1} ${it.unit || ""}`.trim();
function when(days) {
  if (days < -1) return `expired ${-days} days ago`;
  if (days === -1) return "expired yesterday";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 60) return `in ${days} days`;
  return `in ${Math.round(days / 30)} months`;
}
const monthLabel = (k) => { const [y, m] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };

// items: sorted list with .days (everything with a best-before date); supplies: household
// supplies with .low; shopping: open entries; history: historySummary() output
function summarize({ items, supplies = [], shopping, history, days = 7 }) {
  const expired = items.filter((i) => i.days < 0);
  const soon = items.filter((i) => i.days >= 0 && i.days <= days);
  const later = items.filter((i) => i.days > days);
  const food = items.filter((i) => i.kind !== "supply");
  const places = new Map();
  for (const it of food) { const p = it.place || "Pantry"; if (!places.has(p)) places.set(p, []); places.get(p).push(it); }
  const month = history.months[history.months.length - 1];
  return { expired, soon, later, places: [...places.entries()].sort((a, b) => b[1].length - a[1].length), month, history, shopping, days, total: food.length,
    supplies, low: supplies.filter((i) => i.low) };
}
const countLine = (s) => `${s.total} food item${s.total === 1 ? "" : "s"}${s.supplies.length ? ` · ${s.supplies.length} household suppl${s.supplies.length === 1 ? "y" : "ies"}` : ""}`;
const lowText = (i) => `${qty(i)} left`;

// ---------- email ----------
function html(s, { day, appUrl, withBackup, daily }) {
  const C = COLORS;
  const box = (n, label, color, bg) => `<td width="33%" valign="top" style="padding:4px"><div style="background:${bg};border-radius:12px;padding:14px 12px 12px;height:62px">
    <div style="font:800 28px/1 Arial,sans-serif;color:${color}">${n}</div><div style="font:700 12px/1.3 Arial,sans-serif;color:${color};margin-top:6px">${label}</div></div></td>`;
  const row = (it) => `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};font:700 15px Arial,sans-serif;color:${C.ink}">${esc(it.name)}
      <div style="font:400 13px Arial,sans-serif;color:${C.muted}">${esc(qty(it))} · ${esc(it.place || "Pantry")}</div></td>
    <td align="right" style="padding:9px 0;border-top:1px solid ${C.line};font:700 13px Arial,sans-serif;color:${it.days < 0 ? C.expired : C.soon};white-space:nowrap">${esc(when(it.days))}</td></tr>`;
  const section = (title, body) => `<tr><td style="padding:22px 24px 0"><div style="font:700 12px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};margin-bottom:6px">${title}</div>${body}</td></tr>`;
  const useFirst = [...s.expired, ...s.soon];
  const m = s.month, gone = m.used + m.wasted;
  const parts = [];
  parts.push(section("Use first", useFirst.length
    ? `<table width="100%" cellpadding="0" cellspacing="0">${useFirst.slice(0, 15).map(row).join("")}</table>${useFirst.length > 15 ? `<p style="font:13px Arial,sans-serif;color:${C.muted}">And ${useFirst.length - 15} more in the attached report.</p>` : ""}`
    : `<p style="font:15px Arial,sans-serif;color:${C.ink};margin:6px 0">Nothing expires in the next ${s.days} days.</p>`));
  if (s.low.length) parts.push(section("Running low", `<table width="100%" cellpadding="0" cellspacing="0">${s.low.map((it) => `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};font:700 15px Arial,sans-serif;color:${C.ink}">${esc(it.name)}
      <div style="font:400 13px Arial,sans-serif;color:${C.muted}">${esc(it.place || "Storage")}</div></td>
    <td align="right" style="padding:9px 0;border-top:1px solid ${C.line};font:700 13px Arial,sans-serif;color:${C.low};white-space:nowrap">${esc(lowText(it))}</td></tr>`).join("")}</table>`));
  if (!daily) parts.push(section("This month", `<p style="font:15px/1.5 Arial,sans-serif;color:${C.ink};margin:6px 0"><b style="color:${C.ok}">${m.used} used</b> and <b style="color:${C.expired}">${m.wasted} thrown away</b>${gone ? ` (${Math.round(m.wasted / gone * 100)}% thrown away)` : ""}.</p>`
    + (s.history.topWasted.length ? `<p style="font:13px/1.5 Arial,sans-serif;color:${C.muted};margin:4px 0">Thrown away most lately: ${s.history.topWasted.slice(0, 3).map((w) => esc(w.name)).join(", ")}.</p>` : "")));
  if (!daily) parts.push(section("On the shelf", `<p style="font:15px/1.6 Arial,sans-serif;color:${C.ink};margin:6px 0">${s.places.map(([p, list]) => `${esc(p)}: <b>${list.length}</b>`).join(" &nbsp;·&nbsp; ") || "The shelf is empty."}</p>`));
  if (s.shopping.length) parts.push(section("Shopping list", `<p style="font:15px/1.6 Arial,sans-serif;color:${C.ink};margin:6px 0">${s.shopping.slice(0, 20).map((e) => esc(e.name)).join(", ")}${s.shopping.length > 20 ? ` and ${s.shopping.length - 20} more` : ""}</p>`));
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef1ea">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ea"><tr><td align="center" style="padding:20px 12px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:${C.hero};padding:24px">
  <div style="font:800 24px Arial,sans-serif;color:#f1f6ea">${daily ? "Your pantry today" : "Your pantry this week"}</div>
  <div style="font:14px Arial,sans-serif;color:#c3d6b5;margin-top:4px">${esc(niceDate(day))} · ${countLine(s)}</div>
</td></tr>
<tr><td style="padding:16px 20px 0"><table width="100%" cellpadding="0" cellspacing="0"><tr>
  ${box(s.expired.length, "Expired", C.expired, C.expiredBg)}${box(s.soon.length, s.days === 7 ? "Use this week" : `Use within ${s.days} days`, C.soon, C.soonBg)}${daily || s.low.length ? box(s.low.length, "Running low", C.low, C.lowBg) : box(s.later.length, "Fine for now", C.ok, C.okBg)}
</tr></table></td></tr>
${parts.join("\n")}
${appUrl ? `<tr><td style="padding:24px"><a href="${esc(appUrl)}" style="display:inline-block;background:${C.accent};color:#fff;font:700 15px Arial,sans-serif;text-decoration:none;padding:12px 20px;border-radius:12px">Open the shelf</a></td></tr>` : ""}
<tr><td style="padding:${appUrl ? "0" : "24px"} 24px 24px;font:13px/1.5 Arial,sans-serif;color:${C.muted}">
  ${daily
    ? `Attached: <b>pantry-report-${day}.pdf</b>, the full list to read or print. You get this email on your reminder days; change it in Settings &gt; Daily reminders.`
    : withBackup
    ? `Attached: <b>pantry-report-${day}.pdf</b>, the full list to read or print, and <b>pantry-backup-${day}.json</b>, your backup. Keep this email: to put the backup back, open Settings &gt; Backups &gt; Restore a backup &gt; Restore from a file.`
    : `Attached: <b>pantry-report-${day}.pdf</b>, the full list to read or print.`}
</td></tr>
</table></td></tr></table></body></html>`;
}

function text(s, { day, appUrl, withBackup, daily }) {
  const line = (i) => `- ${i.name} (${qty(i)}, ${i.place || "Pantry"}): ${when(i.days)}`;
  const useFirst = [...s.expired, ...s.soon];
  const m = s.month;
  return [
    `Your pantry ${daily ? "today" : "this week"}, ${niceDate(day)}`,
    `${s.expired.length} expired, ${s.soon.length} to use within ${s.days} days, ${daily ? `${s.low.length} running low` : `${s.later.length} fine for now`}.`,
    useFirst.length ? `Use first:\n${useFirst.map(line).join("\n")}` : `Nothing expires in the next ${s.days} days.`,
    s.low.length ? `Running low:\n${s.low.map((i) => `- ${i.name} (${lowText(i)}, ${i.place || "Storage"})`).join("\n")}` : "",
    daily ? "" : `This month: ${m.used} used, ${m.wasted} thrown away.`,
    s.shopping.length ? `Shopping list: ${s.shopping.map((e) => e.name).join(", ")}` : "",
    daily ? "Attached: the full report (PDF)." : withBackup ? "Attached: the full report (PDF) and your backup (JSON). To put the backup back: Settings > Backups > Restore a backup > Restore from a file." : "Attached: the full report (PDF).",
    appUrl ? `Open the shelf: ${appUrl}` : "",
  ].filter(Boolean).join("\n\n");
}

// ---------- PDF ----------
// The built-in PDF fonts only cover Western European letters; anything else becomes "?"
const pdfText = (v) => String(v).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

function pdf(s, { day }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `Pantry report ${day}`, Author: "Pantry Shelf" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const C = COLORS, L = 48, W = doc.page.width - 96, bottom = () => doc.page.height - 60;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

    // header band
    doc.rect(0, 0, doc.page.width, 110).fill(C.hero);
    doc.fill("#f1f6ea").font("Helvetica-Bold").fontSize(24).text("Pantry report", L, 36);
    doc.fill("#c3d6b5").font("Helvetica").fontSize(11).text(`${niceDate(day)}  ·  ${countLine(s).replace(" · ", "  ·  ")}`, L, 68);
    doc.y = 130;

    // three summary boxes
    const bw = (W - 20) / 3;
    [[s.expired.length, "Expired", C.expired, C.expiredBg], [s.soon.length, `Use within ${s.days} days`, C.soon, C.soonBg], s.low.length ? [s.low.length, "Running low", C.low, C.lowBg] : [s.later.length, "Fine for now", C.ok, C.okBg]]
      .forEach(([n, label, fg, bg], i) => {
        const x = L + i * (bw + 10);
        doc.roundedRect(x, 130, bw, 64, 8).fill(bg);
        doc.fill(fg).font("Helvetica-Bold").fontSize(24).text(String(n), x + 12, 140, { width: bw - 24 });
        doc.fontSize(9).text(label, x + 12, 172, { width: bw - 24 });
      });
    doc.y = 214;

    const heading = (t) => { ensure(60); doc.moveDown(0.6); doc.fill(C.muted).font("Helvetica-Bold").fontSize(9).text(t.toUpperCase(), L, doc.y, { characterSpacing: 1 }); doc.moveDown(0.4); };
    const para = (t, color = C.ink) => { ensure(20); doc.fill(color).font("Helvetica").fontSize(10.5).text(pdfText(t), L, doc.y, { width: W }); doc.moveDown(0.3); };
    // a simple table: cols = [{title, width, align, get, color?}]
    function table(cols, rows) {
      const head = () => {
        let x = L; const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(8.5).fill(C.muted);
        for (const c of cols) { doc.text(c.title, x, y, { width: c.width, align: c.align || "left" }); x += c.width; }
        doc.y = y + 14; doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.6).stroke(C.line); doc.y += 5;
      };
      ensure(40); head();
      rows.forEach((r, i) => {
        doc.font("Helvetica").fontSize(10);
        const h = Math.max(...cols.map((c) => doc.heightOfString(pdfText(c.get(r)), { width: c.width - 6 }))) + 8;
        if (doc.y + h > bottom()) { doc.addPage(); head(); }
        const y = doc.y; let x = L;
        if (i % 2) doc.rect(L, y - 3, W, h).fill(C.soft);
        for (const c of cols) {
          doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fill(c.color ? c.color(r) : C.ink)
            .text(pdfText(c.get(r)), x, y, { width: c.width - 6, align: c.align || "left" });
          x += c.width;
        }
        doc.y = y + h;
      });
      doc.x = L;
    }
    const daysColor = (it) => (it.days < 0 ? C.expired : it.days <= s.days ? C.soon : C.ok);
    const itemCols = [
      { title: "ITEM", width: W * 0.42, get: (i) => i.name, bold: true },
      { title: "AMOUNT", width: W * 0.16, get: qty },
      { title: "BEST BEFORE", width: W * 0.2, get: (i) => niceDate(i.expiry) },
      { title: "", width: W * 0.22, align: "right", get: (i) => when(i.days), color: daysColor },
    ];

    heading("Use first");
    const useFirst = [...s.expired, ...s.soon];
    const useCols = [itemCols[0], { title: "WHERE", width: W * 0.16, get: (i) => i.place || "Pantry" }, itemCols[2], itemCols[3]];
    if (useFirst.length) table(useCols, useFirst);
    else para(`Nothing expires in the next ${s.days} days.`);

    if (s.low.length) {
      heading("Running low");
      table([itemCols[0], { title: "WHERE", width: W * 0.36, get: (i) => i.place || "Storage" }, { title: "", width: W * 0.22, align: "right", get: lowText, color: () => C.low }], s.low);
    }

    heading("This month");
    const m = s.month, gone = m.used + m.wasted;
    para(`${m.used} used and ${m.wasted} thrown away${gone ? ` (${Math.round(m.wasted / gone * 100)}% thrown away)` : ""}.`);
    // six-month bars
    ensure(6 * 18 + 10);
    const max = Math.max(1, ...s.history.months.map((x) => x.used + x.wasted)), barW = W - 150;
    for (const mo of s.history.months) {
      const y = doc.y;
      doc.fill(C.muted).font("Helvetica").fontSize(9).text(monthLabel(mo.month), L, y + 1, { width: 60 });
      doc.rect(L + 64, y + 2, barW, 9).fill(C.soft);
      const u = barW * mo.used / max, w = barW * mo.wasted / max;
      if (u) doc.rect(L + 64, y + 2, u, 9).fill(C.ok);
      if (w) doc.rect(L + 64 + u, y + 2, w, 9).fill(C.expired);
      doc.fill(C.muted).text(`${mo.used} used / ${mo.wasted} thrown`, L + 70 + barW, y + 1, { width: 80, align: "right" });
      doc.y = y + 17;
    }
    if (s.history.topWasted.length) para(`Thrown away most lately: ${s.history.topWasted.map((w) => `${w.name} (${w.count})`).join(", ")}.`, C.muted);
    if (s.history.people.length > 1) para(`This month: ${s.history.people.map((p) => `${p.name} used ${p.used || 0}, threw away ${p.wasted || 0}`).join("; ")}.`, C.muted);

    for (const [place, list] of s.places) {
      heading(`${place} (${list.length})`);
      table(itemCols, list);
    }
    if (!s.places.length) { heading("On the shelf"); para("No food on the shelf."); }

    if (s.supplies.length) {
      heading(`Household supplies (${s.supplies.length})`);
      table([itemCols[0], itemCols[1], { title: "WHERE", width: W * 0.2, get: (i) => i.place || "Storage" },
        { title: "", width: W * 0.22, align: "right", get: (i) => (i.low ? "running low" : "in stock"), color: (i) => (i.low ? C.low : C.ok) }], s.supplies);
    }

    if (s.shopping.length) {
      heading("Shopping list");
      for (const e of s.shopping) {
        ensure(18); const y = doc.y;
        doc.rect(L, y + 1, 9, 9).lineWidth(0.8).stroke(C.muted);
        doc.fill(C.ink).font("Helvetica").fontSize(10.5).text(pdfText(e.name), L + 16, y, { width: W - 16 });
        doc.y = Math.max(doc.y, y + 16);
      }
    }

    // page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // the footer sits below the normal margin
      doc.fill(C.muted).font("Helvetica").fontSize(8).text(`Pantry Shelf · ${niceDate(day)} · page ${i + 1} of ${range.count}`, L, doc.page.height - 36, { width: W, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { summarize, html, text, pdf };
