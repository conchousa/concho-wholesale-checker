// Concho Wholesale Checker
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STORE_PHRASE = {
  BDPT: "boutiques", CAMP: "campus and local shops", GLFS: "golf shops", RRET: "retail stores",
  SGSS: "sporting goods and team stores", SMT: "specialty stores",
};
const STATUS_LABEL = {
  needs_code: "Waiting on CLC code", ready: "Ready to invoice", partial: "Partly covered",
  not_licensed: "Not licensed", review: "Needs review", invoiced: "Invoiced", draft: "Draft",
};
const LEAD_FIELDS = ["store_name", "contact_name", "email", "phone", "location", "notes"];

const app = {
  config: null,
  schools: [],
  lead: blankLead(),
  result: null,
};

function blankLead() {
  return { id: null, retailer_code: "", retailer_name: "", channel: "", noCode: false, schools: [], status: "" };
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}

function listJoin(arr) {
  if (arr.length <= 1) return arr.join("");
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")}, and ${arr[arr.length - 1]}`;
}
const firstName = () => ($("#f_contact_name").value.trim().split(/\s+/)[0] || "there");
const storeName = () => $("#f_store_name").value.trim() || "the store";
const channelLabel = (c) => (app.config.channels[c] || c);
const storePhrase = (c) => STORE_PHRASE[c] || `${channelLabel(c).toLowerCase()} stores`;

// ------------------------------------------------------------ tabs
$$(".tab").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view))
);
function showView(v) {
  $$(".tab").forEach((x) => x.classList.toggle("is-active", x.dataset.view === v));
  $$(".view").forEach((x) => x.classList.toggle("is-active", x.id === `view-${v}`));
  if (v === "log") loadLog();
  if (v === "demand") loadDemand();
  if (v === "data") renderData();
}

// ------------------------------------------------------------ step 1: retailer search
let searchTimer, searchSeq = 0;
$("#retailerQuery").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchRetailers(e.target.value), 220);
});
$("#f_store_name").addEventListener("input", (e) => {
  // keep the search box in step with the store name until someone picks a code
  if (!app.lead.retailer_code && !app.lead.noCode) {
    $("#retailerQuery").value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchRetailers(e.target.value), 300);
  }
  renderOutcome();
});
LEAD_FIELDS.forEach((f) => $(`#f_${f}`).addEventListener("input", () => renderDrafts()));

async function searchRetailers(q) {
  const box = $("#retailerResults");
  q = q.trim();
  if (q.length < 2) { box.innerHTML = ""; return; }
  const seq = ++searchSeq;
  const data = await api(`/api/retailers/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq) return;
  if (!data.results.length) {
    box.innerHTML = `<div class="empty-note">Nothing close to "${esc(q)}" in the CLC list. Try a shorter version of the name, or mark them as not in the list.</div>`;
    return;
  }
  box.innerHTML = data.results
    .map(
      (r) => `<div class="result">
        <div class="result-name">${esc(r.name)}${r.score >= 100 ? "" : `<span class="result-score">${r.score}% match</span>`}</div>
        <div class="codes">${r.codes
          .map(
            (c) => `<button class="code-btn" data-code="${esc(c.code)}" data-type="${esc(c.type)}" data-name="${esc(r.name)}">
              <b>${esc(c.code)}</b> <span>${esc(c.type_label)} (${esc(c.type)})</span></button>`
          )
          .join("")}</div></div>`
    )
    .join("");
}
$("#retailerResults").addEventListener("click", (e) => {
  const b = e.target.closest(".code-btn");
  if (!b) return;
  selectRetailer(b.dataset.code, b.dataset.name, b.dataset.type);
});

function selectRetailer(code, name, type) {
  Object.assign(app.lead, { retailer_code: code, retailer_name: name, channel: type, noCode: false });
  if (!$("#f_store_name").value.trim()) $("#f_store_name").value = name;
  $("#retailerResults").innerHTML = "";
  renderStep1();
  refresh();
}

$("#markNoCode").addEventListener("click", () => {
  Object.assign(app.lead, { retailer_code: "", retailer_name: "", noCode: true });
  app.lead.channel = $("#previewChannel").value;
  $("#retailerResults").innerHTML = "";
  renderStep1();
  refresh();
});
$("#previewChannel").addEventListener("change", (e) => { app.lead.channel = e.target.value; refresh(); });

function renderStep1() {
  const sel = $("#selectedRetailer"), nc = $("#noCodePanel");
  const L = app.lead;
  sel.hidden = !L.retailer_code;
  nc.hidden = !L.noCode;
  $("#markNoCode").hidden = L.noCode || !!L.retailer_code;
  if (L.retailer_code) {
    const tracked = app.config.tracked.includes(L.channel);
    sel.innerHTML = `<div>
        <div class="big">${esc(L.retailer_code)}</div>
        <div class="small">${esc(L.retailer_name)}. Store type: ${esc(channelLabel(L.channel))} (${esc(L.channel)})${tracked ? "" : ". Not one of our six tracked channels."}</div>
      </div>
      <button class="btn-small" id="changeRetailer">Change</button>`;
    $("#changeRetailer").onclick = () => {
      Object.assign(app.lead, { retailer_code: "", retailer_name: "", channel: "" });
      renderStep1(); refresh();
      $("#retailerQuery").focus();
      searchRetailers($("#retailerQuery").value);
    };
  }
  if (L.noCode) $("#previewChannel").value = L.channel || app.config.tracked[0];
  $("#step1").classList.toggle("is-done", !!(L.retailer_code || L.noCode));
}

// ------------------------------------------------------------ step 2: schools
$("#schoolFilter").addEventListener("input", renderSchools);
$("#schoolChips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  const id = c.dataset.id, s = app.lead.schools;
  const i = s.indexOf(id);
  i >= 0 ? s.splice(i, 1) : s.push(id);
  renderSchools();
  refresh();
});

function renderSchools() {
  const f = $("#schoolFilter").value.trim().toLowerCase();
  const ch = app.lead.channel;
  const tracked = app.config.tracked.includes(ch);
  $("#schoolHint").textContent = !ch
    ? "Pick a retailer first to see what we can sell into their store type."
    : tracked
    ? `Colors show what we can sell into ${storePhrase(ch)} (${ch}).`
    : `${channelLabel(ch)} (${ch}) isn't on our licensing sheet, so every school needs a check with CLC.`;
  $("#schoolChips").innerHTML = app.schools
    .filter((s) => !f || s.name.toLowerCase().includes(f) || app.lead.schools.includes(s.id))
    .map((s) => {
      const on = app.lead.schools.includes(s.id);
      const ok = tracked ? s.channels[ch] : null;
      const dot = ok === true ? "ok" : ok === false ? "no" : "";
      return `<button class="chip ${ok === false ? "is-no" : ""}" data-id="${esc(s.id)}" aria-pressed="${on}">
        <span class="dot ${dot}"></span>${esc(s.name)}</button>`;
    })
    .join("");
  $("#step2").classList.toggle("is-done", app.lead.schools.length > 0);
}

// ------------------------------------------------------------ step 3: outcome
async function refresh() {
  renderSchools();
  const L = app.lead;
  if (L.channel && L.schools.length) {
    app.result = await api("/api/check", { method: "POST", body: JSON.stringify({ channel: L.channel, schools: L.schools }) });
  } else {
    app.result = null;
  }
  renderOutcome();
}

function currentStatus() {
  const L = app.lead;
  if (L.status === "invoiced") return "invoiced";
  if (L.noCode) return "needs_code";
  if (!app.result) return "draft";
  return app.result.overall;
}

function renderOutcome() {
  const L = app.lead, R = app.result;
  const v = $("#verdict");
  const st = currentStatus();
  if (!L.retailer_code && !L.noCode) {
    v.innerHTML = `<div class="verdict idle"><h3>Find the retailer to get started.</h3></div>`;
  } else if (!L.schools.length) {
    v.innerHTML = L.noCode
      ? `<div class="verdict needs_code"><h3>Request a CLC retailer code</h3><p>Pick their schools so we can tell them what we'll be able to ship once the code comes through.</p></div>`
      : `<div class="verdict idle"><h3>Now pick the schools they asked for.</h3></div>`;
  } else {
    const c = R.counts;
    const lic = R.rows.filter((r) => r.status === "licensed").map((r) => r.name);
    const blk = R.rows.filter((r) => r.status === "not_licensed").map((r) => r.name);
    const anyWarn = R.rows.some((r) => r.warnings.length);
    const map = {
      ready: [`Ready to invoice`, `We're licensed for all ${c.total} school${c.total > 1 ? "s" : ""} in ${storePhrase(R.channel)}.${anyWarn ? " Check the flagged notes below first." : ""}`],
      partial: [`Partly covered: ${c.licensed} of ${c.total}`, `Invoice ${listJoin(lic)}. Let them know about ${listJoin(blk)}.`],
      not_licensed: [`Not licensed for these yet`, `None of these schools are open to ${storePhrase(R.channel)} for us. Let them know, and the request gets logged as demand when you save.`],
      review: [`Check with CLC first`, `${channelLabel(R.channel)} (${R.channel}) isn't one of the six channels on our licensing sheet, so the sheet can't say yes or no.`],
      invoiced: [`Invoiced`, `This lead is marked invoiced.`],
    };
    let [h, p] = map[R.overall] || ["", ""];
    if (st === "invoiced") [h, p] = map.invoiced;
    let cls = st === "invoiced" ? "ready" : R.overall;
    if (L.noCode) {
      cls = "needs_code";
      h = "Request a CLC retailer code";
      p = `Nothing ships until the code comes through. Preview as ${storePhrase(R.channel)}: ${c.licensed} of ${c.total} school${c.total > 1 ? "s" : ""} covered.`;
    }
    v.innerHTML = `<div class="verdict ${cls}"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`;
  }
  renderTable();
  renderDrafts();
  $("#step3").classList.toggle("is-done", st === "ready" || st === "invoiced");
}

function renderTable() {
  const R = app.result, box = $("#resultTable");
  if (!R || !R.rows.length) { box.innerHTML = ""; return; }
  const label = { licensed: "Licensed", not_licensed: "Not licensed", review: "Check with CLC" };
  box.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>School</th><th>${esc(R.channel)}</th><th>Royalty</th><th>Licensor</th></tr></thead>
    <tbody>${R.rows
      .map(
        (r) => `<tr>
        <td><strong>${esc(r.name)}</strong>
          ${r.status === "not_licensed" && r.other_channels.length ? `<div class="muted">Licensed for ${esc(r.other_channels.join(", "))}</div>` : ""}
          ${r.status === "not_licensed" && !r.other_channels.length ? `<div class="muted">Not licensed in any tracked channel</div>` : ""}
          ${r.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
          ${r.notes ? `<details class="notes"><summary>License notes</summary>${esc(r.notes)}</details>` : ""}
        </td>
        <td><span class="stamp ${r.status}">${label[r.status]}</span></td>
        <td>${esc(r.rate || "None on file")}</td>
        <td>${esc(r.licensor)}<div class="muted">${esc(r.agreement)}</div></td>
      </tr>`
      )
      .join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------ drafts
function sign() { return `${app.config.sender_name}\nConcho`; }

function clcDraft() {
  const ch = app.lead.channel;
  const body = `Hi,

We have a new wholesale account that needs a CLC retailer code. Details are below.

Store name: ${storeName()}
Location: ${$("#f_location").value.trim() || "[city, state]"}
Contact name: ${$("#f_contact_name").value.trim() || "[buyer name]"}
Contact email: ${$("#f_email").value.trim() || "[buyer email]"}${$("#f_phone").value.trim() ? `\nPhone: ${$("#f_phone").value.trim()}` : ""}
Store type: ${channelLabel(ch)} (${ch})

Let me know if you need anything else from us.

Thanks,
${sign()}`;
  return { subject: `Retailer code request: ${storeName()}`, body };
}

function clientDraft() {
  const R = app.result, L = app.lead;
  if (!R || !R.rows.length) return null;
  const lic = R.rows.filter((r) => r.status === "licensed").map((r) => r.name);
  const blk = R.rows.filter((r) => r.status === "not_licensed").map((r) => r.name);
  const phrase = storePhrase(R.channel);
  const hi = `Hey ${firstName()},\n\n`;
  const bye = `\n\n${sign()}`;
  let subject = `Concho order for ${storeName()}`, body;

  if (L.noCode) {
    body = `${hi}Thanks for reaching out. Before we can ship licensed college product, every store needs a retailer code from CLC, the licensing company. I didn't find one for ${storeName()}, so I'm requesting it for you now. Nothing you need to do on your end.\n\n${
      lic.length ? `Once it comes through we're set up to do ${listJoin(lic)} for you.` : ""
    }${blk.length ? `${lic.length ? " " : ""}${listJoin(blk)} ${blk.length > 1 ? "aren't" : "isn't"} something we can sell into ${phrase} yet, but I'm keeping track of it.` : ""}\n\nI'll reach back out as soon as the code is in hand.${bye}`;
  } else if (R.overall === "ready") {
    body = `${hi}Good news. We're licensed for ${listJoin(lic)} for your store, so we're good to go. I'll put the invoice together and get it over to you.\n\nIf you want to change up styles or quantities before then, just let me know.${bye}`;
  } else if (R.overall === "partial") {
    body = `${hi}Thanks for sending this over. We can do ${listJoin(lic)} for you, so I'll get an invoice started on those.\n\n${listJoin(blk)} ${blk.length > 1 ? "aren't" : "isn't"} something we're licensed to sell into ${phrase} yet. We keep a running list of these requests, and when enough stores ask for a school we go after the license. Yours is on the list and I'll let you know if that changes.${bye}`;
  } else if (R.overall === "not_licensed") {
    const alts = app.schools.filter((s) => s.channels[R.channel] && !s.is_variant).map((s) => s.name);
    body = `${hi}Thanks for reaching out. Right now we aren't licensed to sell ${listJoin(blk)} into ${phrase}. I hate that answer, but I'd rather be straight with you up front.\n\nWe track every request like this and it drives which licenses we go after next, so this one counts.${
      alts.length ? ` In the meantime, we do carry ${alts.length} schools for ${phrase}. Happy to send that list over if any of them fit your customers.` : ""
    }${bye}`;
  } else {
    body = `${hi}Thanks for reaching out. I'm double-checking our licensing for your type of store before I quote anything. I'll get back to you shortly with what we can do.${bye}`;
  }
  return { subject, body };
}

function draftBlock(title, d, to) {
  const id = "d" + Math.random().toString(36).slice(2, 8);
  const mail = `mailto:${encodeURIComponent(to || "")}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
  return `<div class="draft">
    <div class="draft-head"><h4>${esc(title)}</h4>
      <div class="draft-actions">
        <button class="btn-small" data-copy="${id}">Copy</button>
        <a class="btn-small" href="${mail}">Open in email</a>
      </div></div>
    <p class="muted">Subject: ${esc(d.subject)}${to ? `. To: ${esc(to)}` : ""}</p>
    <textarea id="${id}">${esc(d.body)}</textarea></div>`;
}

function renderDrafts() {
  const box = $("#drafts");
  const L = app.lead;
  let html = "";
  if (L.noCode && L.channel) html += draftBlock("Email to CLC", clcDraft(), app.config.clc_email);
  const c = clientDraft();
  if (c) html += draftBlock(L.noCode ? "Note to the buyer" : "Message to the buyer", c, $("#f_email").value.trim());
  box.innerHTML = html;
}
$("#drafts").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  await navigator.clipboard.writeText($(`#${b.dataset.copy}`).value);
  toast("Copied");
});

// ------------------------------------------------------------ save / load lead
$("#saveLead").addEventListener("click", saveLead);
async function saveLead() {
  const msg = $("#saveMsg");
  msg.classList.remove("err");
  const payload = {
    id: app.lead.id,
    retailer_code: app.lead.retailer_code,
    retailer_name: app.lead.retailer_name,
    channel: app.lead.channel,
    schools: app.lead.schools,
    result: app.result,
    status: currentStatus(),
  };
  LEAD_FIELDS.forEach((f) => (payload[f] = $(`#f_${f}`).value));
  try {
    const saved = await api("/api/leads", { method: "POST", body: JSON.stringify(payload) });
    app.lead.id = saved.id;
    app.lead.status = saved.status;
    $("#leadState").textContent = `Saved as ${STATUS_LABEL[saved.status] || saved.status}`;
    msg.textContent = "Saved.";
    updatePendingCount();
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add("err");
  }
}

$("#newLead").addEventListener("click", () => resetLead());
function resetLead() {
  app.lead = blankLead();
  app.result = null;
  LEAD_FIELDS.forEach((f) => ($(`#f_${f}`).value = ""));
  $("#retailerQuery").value = "";
  $("#retailerResults").innerHTML = "";
  $("#schoolFilter").value = "";
  $("#leadState").textContent = "New lead";
  $("#saveMsg").textContent = "";
  renderStep1();
  refresh();
}

function openLead(lead) {
  app.lead = {
    id: lead.id,
    retailer_code: lead.retailer_code,
    retailer_name: lead.retailer_name,
    channel: lead.channel,
    noCode: lead.status === "needs_code" || (!lead.retailer_code && !!lead.channel),
    schools: lead.schools || [],
    status: lead.status,
  };
  LEAD_FIELDS.forEach((f) => ($(`#f_${f}`).value = lead[f] || ""));
  $("#retailerQuery").value = lead.retailer_code ? "" : lead.store_name;
  $("#leadState").textContent = `Saved as ${STATUS_LABEL[lead.status] || lead.status}`;
  $("#saveMsg").textContent = "";
  showView("check");
  renderStep1();
  refresh();
  if (app.lead.noCode) toast("Got the code from CLC? Search it in step 1 and pick it.");
}

// ------------------------------------------------------------ lead log
let logFilter = "";
$("#logFilters").addEventListener("click", (e) => {
  const b = e.target.closest(".filter");
  if (!b) return;
  logFilter = b.dataset.status;
  $$(".filter").forEach((x) => x.classList.toggle("is-active", x === b));
  loadLog();
});

async function loadLog() {
  const leads = await api(`/api/leads${logFilter ? `?status=${logFilter}` : ""}`);
  const box = $("#logTable");
  if (!leads.length) {
    box.innerHTML = `<p class="hint">No leads here yet. Saved leads from "Check a lead" show up in this list.</p>`;
    return;
  }
  const byId = Object.fromEntries(app.schools.map((s) => [s.id, s.name]));
  box.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Store</th><th>Buyer</th><th>Code</th><th>Schools</th><th>Status</th><th>Updated</th><th></th></tr></thead>
    <tbody>${leads
      .map(
        (l) => `<tr class="clickable" data-id="${l.id}">
        <td><strong>${esc(l.store_name)}</strong><div class="muted">${esc(l.location)}</div></td>
        <td>${esc(l.contact_name)}<div class="muted">${esc(l.email)}</div></td>
        <td>${l.retailer_code ? esc(l.retailer_code) : `<span class="muted">None yet</span>`}<div class="muted">${esc(l.channel)}</div></td>
        <td>${esc((l.schools || []).map((s) => byId[s] || s).join(", "))}</td>
        <td><span class="stamp ${esc(l.status)}">${esc(STATUS_LABEL[l.status] || l.status)}</span></td>
        <td class="muted">${new Date(l.updated_at).toLocaleDateString()}</td>
        <td>
          ${["ready", "partial"].includes(l.status) ? `<button class="btn-small" data-invoice="${l.id}">Mark invoiced</button>` : ""}
          <button class="btn-small" data-del="${l.id}">Delete</button>
        </td></tr>`
      )
      .join("")}</tbody></table></div>`;
  box._leads = leads;
}
$("#logTable").addEventListener("click", async (e) => {
  const box = $("#logTable");
  const inv = e.target.closest("[data-invoice]");
  const del = e.target.closest("[data-del]");
  if (inv) {
    e.stopPropagation();
    const l = box._leads.find((x) => x.id == inv.dataset.invoice);
    await api("/api/leads", { method: "POST", body: JSON.stringify({ ...l, status: "invoiced" }) });
    toast("Marked invoiced");
    loadLog(); updatePendingCount();
    return;
  }
  if (del) {
    e.stopPropagation();
    if (!confirm("Delete this lead?")) return;
    await api(`/api/leads/${del.dataset.del}`, { method: "DELETE" });
    loadLog(); updatePendingCount();
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openLead(box._leads.find((x) => x.id == row.dataset.id));
});

async function updatePendingCount() {
  const pending = await api("/api/leads?status=needs_code");
  const el = $("#pendingCount");
  el.hidden = !pending.length;
  el.textContent = pending.length;
  el.title = `${pending.length} waiting on a CLC code`;
}

// ------------------------------------------------------------ demand
async function loadDemand() {
  const rows = await api("/api/demand");
  const box = $("#demandTable");
  if (!rows.length) {
    box.innerHTML = `<p class="hint">No unlicensed requests logged yet.</p>`;
    return;
  }
  box.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Requests</th><th>School</th><th>Store type</th><th>Stores asking</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
        <td class="count-big">${r.count}</td>
        <td><strong>${esc(r.school)}</strong></td>
        <td>${esc(r.channel_label)} (${esc(r.channel)})</td>
        <td>${r.stores.map((s) => esc(s.name)).join(", ")}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------ data
function fmtDate(iso) { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function renderData() {
  const m = app.config.meta;
  $("#meta-retailers").textContent = `${m.retailers.rows.toLocaleString()} retailers. ${m.retailers.source === "uploaded" ? "Uploaded" : "Bundled with the app"}, ${fmtDate(m.retailers.updated)}.`;
  $("#meta-channels").textContent = `${m.channels.rows} schools and marks. ${m.channels.source === "uploaded" ? "Uploaded" : "Bundled with the app"}, ${fmtDate(m.channels.updated)}.`;
  const types = m.retailers.types || {};
  $("#channelLegend").innerHTML = `<table><thead><tr><th>Code</th><th>Store type</th><th>Retailers</th><th>On licensing sheet</th></tr></thead><tbody>${Object.entries(app.config.channels)
    .map(([k, v]) => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td><td>${(types[k] || 0).toLocaleString()}</td><td>${app.config.tracked.includes(k) ? "Yes" : "No"}</td></tr>`)
    .join("")}</tbody></table>`;
}
$$(".upload").forEach((form) =>
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".save-msg", form);
    msg.classList.remove("err");
    msg.textContent = "Uploading and checking the file...";
    const fd = new FormData();
    fd.append("kind", form.dataset.kind);
    fd.append("file", $("input[type=file]", form).files[0]);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      msg.textContent = `Done. ${data.rows.toLocaleString()} rows loaded.`;
      await boot(true);
      renderData();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add("err");
    }
  })
);

// ------------------------------------------------------------ boot
async function boot(reload) {
  [app.config, app.schools] = await Promise.all([api("/api/config"), api("/api/schools")]);
  $("#previewChannel").innerHTML = app.config.tracked
    .map((c) => `<option value="${c}">${esc(channelLabel(c))} (${c})</option>`)
    .join("");
  if (!reload) { renderStep1(); updatePendingCount(); }
  refresh();
}
boot();
