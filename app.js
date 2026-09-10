// Liora — Voice & Physical Memory Assistant
const STORAGE_KEY = "liora_items_v1";
const $ = id => document.getElementById(id);

// SVG icons
const iconPaths = {
  nest: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10v9h11v-9"/><path d="M9 15c1.7-2 4.3-2 6 0-1.7 2-4.3 2-6 0Z"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  box: '<path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/>',
  'arrow-up-right': '<path d="M7 17 17 7M8 7h9v9"/>',
  'arrow-down-left': '<path d="m17 7-10 10m9 0H7V8"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4V5ZM16 10l5 5m0-5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
  map: '<path d="M9 18 3 21V6l6-3 6 3 6-3v15l-6 3-6-3Z"/><path d="M9 3v15M15 6v15"/>'
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.box}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(node => {
    node.innerHTML = icon(node.dataset.icon);
    node.removeAttribute("data-icon");
  });
}
hydrateIcons();

// Status copy mappings
const statusCopy = {
  stored: { label: "At home", prefix: "Kept in", icon: "map" },
  packed: { label: "Packed", prefix: "Packed in", icon: "box" },
  lent: { label: "Lent out", prefix: "With", icon: "arrow-up-right" },
  borrowed: { label: "Borrowed", prefix: "Borrowed from", icon: "arrow-down-left" },
  returned: { label: "Returned", prefix: "Returned to", icon: "check" }
};

const viewCopy = {
  all: ["Good to have you back.", "Everything you care about, right where you expect it."],
  stored: ["Your things, organized.", "Everything currently with you or packed."],
  packed: ["Packed & ready.", "Items packed into bags, boxes, or travel luggage."],
  lent: ["Know who has what.", "Keep every handoff clear until it comes back."],
  borrowed: ["Return things on time.", "Remember what belongs to someone else."],
  history: ["A reliable trail.", "Every confirmed move and handoff in one place."]
};

// Application state
let data = loadData();
let currentView = "all";
let draft = null;
let soundsEnabled = true;
let chat = [
  { role: "assistant", text: "Hi, I'm Liora. Tell me where you put something, or ask me to find it.", at: new Date().toISOString() }
];

// Audio & WebSocket session state
let socket = null;
let micStream = null;
let inputContext = null;
let sourceNode = null;
let workletNode = null;
let outputContext = null;
let nextPlayTime = 0;
let pendingTools = [];
let muted = false;
let sessionReady = false;
let wantsMic = false;
let sessionWaiter = null;
let sessionIdleTimer = null;
let manualStop = false;
let chatBusy = false;
const playingSources = new Set();

// Storage helpers with migration from previous versions
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("nestly-data-v2");
    const saved = JSON.parse(raw);
    if (saved?.items && saved?.events) {
      const now = new Date().toISOString();
      saved.items.forEach(item => {
        if (!item.createdAt) item.createdAt = item.updatedAt || now;
      });
      return saved;
    }
    return { items: [], events: [] };
  } catch {
    return { items: [], events: [] };
  }
}

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try { return crypto.randomUUID(); } catch {}
  }
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn("Could not save to localStorage:", err);
  }
  render();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function norm(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/[?.!]$/g, "");
}

function describe(item) {
  return `${statusCopy[item.status]?.prefix || "With"} ${item.detail}`;
}

function activeItems() {
  return data.items.filter(item => item.status !== "returned");
}

function findItem(name) {
  const query = norm(name);
  const items = activeItems();
  const exact = [...items].reverse().find(i => norm(i.name) === query);
  if (exact) return exact;
  return [...items].reverse().find(i => norm(i.name).includes(query) || query.includes(norm(i.name)));
}

function eventTitle(type, name) {
  const titles = {
    stored: `Placed ${name}`,
    packed: `Packed ${name}`,
    lent: `Lent ${name}`,
    borrowed: `Borrowed ${name}`,
    moved: `Moved ${name}`,
    received: `Received ${name} back`,
    returned: `Returned ${name}`,
    deleted: `Removed ${name}`
  };
  return titles[type] || `Updated ${name}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

// Sound effects generator
async function ensureOutputContext() {
  outputContext ||= new AudioContext();
  if (outputContext.state === "suspended") await outputContext.resume();
  return outputContext;
}

function playSound(kind = "tap") {
  if (!soundsEnabled) return;
  try {
    const ctx = outputContext || new AudioContext();
    outputContext = ctx;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const tones = {
      tap: [520, 0.035, 0.025],
      send: [620, 0.06, 0.035],
      success: [760, 0.12, 0.05],
      connect: [440, 0.16, 0.04],
      end: [280, 0.12, 0.035]
    };
    const [freq, dur, vol] = tones[kind] || tones.tap;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch {}
}

function showToast(message) {
  const toast = $("toast");
  if (!toast) return;
  toast.querySelector("span:last-child").textContent = message;
  toast.classList.add("show");
  playSound("success");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// Chat rendering & message history
function addMessage(role, text) {
  if (!text) return;
  const previous = chat.at(-1);
  if (previous?.role === role && previous.text === text) return;
  chat.push({ role, text, at: new Date().toISOString() });
  if (chat.length > 50) chat = chat.slice(-50);
  renderMessages();
  if (role === "assistant") playSound("send");
}

function showTypingIndicator() {
  const root = $("messages");
  if (!root || root.querySelector(".message-typing")) return;
  const el = document.createElement("div");
  el.className = "flex flex-col items-start gap-1 message-typing";
  el.innerHTML = `
    <div class="flex items-center gap-1.5">
      <div class="w-5 h-5 rounded-full bg-gradient-to-tr from-primary to-primary-container text-white flex items-center justify-center text-[11px] font-bold">L</div>
      <span class="font-label-mono-sm text-[10px] text-outline">Liora</span>
    </div>
    <div class="max-w-[90%] bg-surface-container-low px-3.5 py-2.5 rounded-2xl rounded-tl-xs flex flex-col gap-1 text-on-surface shadow-sm border border-slate-200/50">
      <div class="flex gap-1 h-4 items-center">
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-ping"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-ping [animation-delay:0.2s]"></span>
        <span class="w-1.5 h-1.5 rounded-full bg-primary animate-ping [animation-delay:0.4s]"></span>
      </div>
    </div>`;
  root.appendChild(el);
  root.scrollTop = root.scrollHeight;
}

function hideTypingIndicator() {
  $("messages")?.querySelector(".message-typing")?.remove();
}

function renderMessages() {
  const root = $("messages");
  if (!root) return;
  root.innerHTML = chat.map(m => {
    const time = m.at ? new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Now";
    if (m.role === "user") {
      return `
        <div class="flex flex-col items-end gap-1">
          <div class="max-w-[85%] bg-surface-container px-3.5 py-2.5 rounded-2xl rounded-tr-xs text-on-surface text-[13px] shadow-sm">
            ${esc(m.text)}
          </div>
          <span class="font-label-mono-sm text-[10px] text-outline">${time}</span>
        </div>`;
    } else {
      return `
        <div class="flex flex-col items-start gap-1">
          <div class="flex items-center gap-1.5">
            <div class="w-5 h-5 rounded-full bg-gradient-to-tr from-primary to-primary-container text-white flex items-center justify-center text-[11px] font-bold">L</div>
            <span class="font-label-mono-sm text-[10px] text-outline">Liora</span>
          </div>
          <div class="max-w-[90%] bg-surface-container-low px-3.5 py-2.5 rounded-2xl rounded-tl-xs flex flex-col gap-1 text-on-surface shadow-sm border border-slate-200/50">
            <p class="text-[13px] leading-relaxed">${esc(m.text)}</p>
          </div>
        </div>`;
    }
  }).join("");
  root.scrollTop = root.scrollHeight;
}

// Place filter and filter pills UI helpers
function updatePlaceFilterOptions() {
  const select = $("placeFilter");
  if (!select) return;
  const currentVal = select.value;
  const places = Array.from(new Set(activeItems().map(i => i.detail?.trim()).filter(Boolean))).sort();
  
  select.innerHTML = `<option value="all">📍 All Places</option>` +
    places.map(p => `<option value="${esc(norm(p))}">${esc(p)}</option>`).join("");
  
  if (places.map(p => norm(p)).includes(currentVal)) {
    select.value = currentVal;
  } else {
    select.value = "all";
  }
}

function updateSidebarNavUi() {
  const activeClassStr = $("sidebarNav")?.dataset.activeClasses || "bg-surface-container text-primary font-semibold";
  const activeClasses = activeClassStr.split(" ");
  const inactiveClassStr = "text-on-surface-variant";

  document.querySelectorAll("#sidebarNav a").forEach(a => {
    const path = a.dataset.path;
    const isActive = (path === currentView) || (path === "stored" && currentView === "packed");
    if (isActive) {
      a.classList.remove(inactiveClassStr);
      activeClasses.forEach(c => a.classList.add(c));
    } else {
      activeClasses.forEach(c => a.classList.remove(c));
      a.classList.add(inactiveClassStr);
    }
  });
}

function updateFilterPillsUi() {
  const pills = document.querySelectorAll("#filterPills .filter-pill");
  pills.forEach(pill => {
    const match = (pill.dataset.filter === currentView) || (currentView === "all" && pill.dataset.filter === "all");
    if (match) {
      pill.className = "filter-pill px-3 py-1.5 rounded-full text-[12px] font-semibold transition-all bg-primary text-white shadow-xs";
    } else {
      pill.className = "filter-pill px-3 py-1.5 rounded-full text-[12px] font-medium text-slate-600 hover:bg-slate-100 transition-all";
    }
  });
}

// Main UI render
function render() {
  const counts = {
    all: activeItems().length,
    stored: data.items.filter(i => ["stored", "packed"].includes(i.status)).length,
    lent: data.items.filter(i => i.status === "lent").length,
    borrowed: data.items.filter(i => i.status === "borrowed").length
  };

  if ($("metricTracked")) $("metricTracked").textContent = counts.all;
  if ($("metricLent")) $("metricLent").textContent = counts.lent;
  if ($("metricBorrowed")) $("metricBorrowed").textContent = counts.borrowed;
  if ($("metricStored")) $("metricStored").textContent = counts.stored;

  const copy = viewCopy[currentView] || viewCopy.all;
  if ($("viewTitle")) $("viewTitle").textContent = copy[0];
  const descEl = $("viewDesc") || $("viewDescription");
  if (descEl) descEl.textContent = copy[1];

  updateSidebarNavUi();
  updateFilterPillsUi();
  updatePlaceFilterOptions();

  if (currentView === "history") {
    renderHistory();
  } else {
    renderItems();
  }
  renderMessages();
}

function visibleItems() {
  const query = norm($("searchInput")?.value || "");
  const place = norm($("placeFilter")?.value || "all");
  const sort = $("sortSelect")?.value || "newest";

  let items = activeItems().filter(item => {
    const statusMatch = (currentView === "all") ||
      (currentView === "stored" ? ["stored", "packed"].includes(item.status) : item.status === currentView);
    if (!statusMatch) return false;

    if (place !== "all" && norm(item.detail) !== place) {
      return false;
    }

    if (query) {
      const matchText = norm(`${item.name} ${item.detail} ${statusCopy[item.status]?.label || ""}`);
      if (!matchText.includes(query)) return false;
    }

    return true;
  });

  if (sort === "newest") {
    items.sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0));
  } else if (sort === "updated") {
    items.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  } else if (sort === "alpha") {
    items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  return items;
}

function renderItems() {
  const items = visibleItems();
  const root = $("list");
  if (!root) return;

  if (!items.length) {
    root.innerHTML = "";
    $("emptyState")?.classList.remove("hidden");
    return;
  }
  $("emptyState")?.classList.add("hidden");

  root.innerHTML = items.map(item => {
    const loan = ["lent", "borrowed"].includes(item.status);
    const actions = item.status === "lent"
      ? `<button class="px-2.5 py-1 rounded-full bg-surface-container text-on-surface font-label-mono-sm text-[11px] hover:bg-slate-200 transition-colors" data-action="receive" data-id="${esc(item.id)}">Mark returned</button>`
      : item.status === "borrowed"
        ? `<button class="px-2.5 py-1 rounded-full bg-surface-container text-on-surface font-label-mono-sm text-[11px] hover:bg-slate-200 transition-colors" data-action="return" data-id="${esc(item.id)}">Return</button>`
        : `<button class="px-2.5 py-1 rounded-full bg-surface-container-low text-on-surface-variant font-label-mono-sm text-[11px] hover:bg-surface-container transition-colors" data-action="move" data-id="${esc(item.id)}">Move</button>
           <button class="px-2.5 py-1 rounded-full bg-surface-container-low text-on-surface-variant font-label-mono-sm text-[11px] hover:bg-surface-container transition-colors" data-action="lend" data-id="${esc(item.id)}">Lend</button>`;

    const matIcons = { stored: 'inventory_2', packed: 'inventory_2', lent: 'arrow_outward', borrowed: 'call_received', returned: 'check' };
    const matIcon = matIcons[item.status] || 'inventory_2';
    const addedDateStr = formatDate(item.createdAt || item.updatedAt || new Date());
    const statusLabel = statusCopy[item.status]?.label || "Stored";

    return `
      <div class="bg-surface-container-lowest rounded-xl p-space-md shadow-[0_1px_3px_rgba(15,23,42,0.03)] border border-slate-200/70 transition-all hover:border-slate-300 flex flex-col justify-between">
        <div class="flex items-start justify-between gap-space-sm">
          <div class="flex items-start gap-space-sm">
            <div class="w-10 h-10 rounded-lg bg-surface-container-low flex items-center justify-center text-primary shrink-0">
              <span class="material-symbols-outlined text-[20px]">${matIcon}</span>
            </div>
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-space-xs flex-wrap">
                <span class="text-[15px] font-bold text-on-surface">${esc(item.name)}</span>
                <span class="px-2 py-0.5 rounded-full bg-surface-container text-primary font-label-mono-sm text-[10px] uppercase font-semibold">${esc(statusLabel)}</span>
              </div>
              <p class="text-body-sm text-on-surface-variant">${esc(describe(item))}</p>
              <div class="flex items-center gap-1.5 mt-1 text-slate-400">
                <span class="material-symbols-outlined text-[13px]">calendar_today</span>
                <span class="font-label-mono-sm text-[11px]">Added ${esc(addedDateStr)}</span>
              </div>
            </div>
          </div>
          <div class="flex flex-col items-end shrink-0">
            ${loan && item.dueDate ? `<span class="font-label-mono-sm text-[10px] text-error font-medium uppercase">Due ${esc(formatDate(item.dueDate + "T12:00:00"))}</span>` : ""}
          </div>
        </div>
        <div class="mt-space-sm pt-space-xs flex items-center justify-between border-t border-slate-100 flex-wrap gap-2">
          <div class="flex items-center gap-1.5">
            ${actions}
          </div>
          <button class="w-7 h-7 rounded-full bg-surface-container-low text-slate-400 hover:text-error hover:bg-red-50 flex items-center justify-center transition-colors" data-action="delete" data-id="${esc(item.id)}" aria-label="Delete item">
            <span class="material-symbols-outlined text-[15px] pointer-events-none">delete</span>
          </button>
        </div>
      </div>`;
  }).join("");
}

function renderHistory() {
  const query = norm($("searchInput")?.value || "");
  const events = [...data.events]
    .filter(e => !query || norm(`${e.itemName} ${e.title} ${e.detail}`).includes(query))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
  const root = $("list");
  if (!root) return;

  if (!events.length) {
    root.innerHTML = "";
    $("emptyState")?.classList.remove("hidden");
    return;
  }
  $("emptyState")?.classList.add("hidden");

  root.innerHTML = events.map(e => {
    const matIcons = { deleted: 'delete', returned: 'sync', received: 'sync' };
    const matIcon = matIcons[e.type] || 'history';
    return `
      <div class="bg-surface-container-lowest rounded-xl p-space-md shadow-sm border border-slate-200/70 flex items-center justify-between gap-4 w-full">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full bg-surface-container-low flex items-center justify-center text-on-surface-variant shrink-0">
            <span class="material-symbols-outlined text-[18px]">${matIcon}</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <strong class="text-[14px] font-semibold text-on-surface">${esc(e.title)}</strong>
            <p class="text-body-sm text-on-surface-variant">${esc(e.detail)}</p>
          </div>
        </div>
        <span class="font-label-mono-sm text-[11px] text-outline shrink-0">${esc(formatTime(e.at))}</span>
      </div>`;
  }).join("");
}

// Action Dialog (Add / Edit)
function updateActionFields() {
  const action = $("actionInput")?.value || "stored";
  const map = {
    stored: ["Where is it?", "e.g. Top desk drawer"],
    packed: ["Which bag or container?", "e.g. Blue travel bag"],
    lent: ["Who did you lend it to?", "e.g. Rafi"],
    borrowed: ["Who did you borrow it from?", "e.g. Sarah"]
  };
  const [label, placeholder] = map[action] || map.stored;
  if ($("detailLabel")) $("detailLabel").textContent = label;
  if ($("detailInput")) $("detailInput").placeholder = placeholder;
  if ($("dueField")) $("dueField").classList.toggle("hidden", !["lent", "borrowed"].includes(action));
}

function openAction(mode = "stored", item = null) {
  $("actionForm")?.reset();
  if ($("editingId")) $("editingId").value = item?.id || "";
  if ($("itemInput")) {
    $("itemInput").value = item?.name || "";
    $("itemInput").readOnly = Boolean(item);
  }
  if ($("dialogTitle")) $("dialogTitle").textContent = item ? `Update ${item.name}` : "Add a thing";
  const action = mode === "move" ? "stored" : mode === "lend" ? "lent" : mode;
  if ($("actionInput")) {
    $("actionInput").value = action;
    $("actionInput").disabled = Boolean(item);
  }
  updateActionFields();
  if ($("currentContext")) {
    $("currentContext").classList.toggle("hidden", !item);
    if (item) $("currentContext").textContent = `Currently: ${describe(item)}`;
  }
  $("actionDialog")?.showModal();
  setTimeout(() => $(item ? "detailInput" : "itemInput")?.focus(), 40);
}

function prepareDraft(next, returnTo = "action") {
  draft = { ...next, returnTo };
  if ($("confirmSummary")) {
    $("confirmSummary").innerHTML = `
      <strong>${esc(next.name)}</strong><br>
      <span>${esc(statusCopy[next.status]?.prefix || "Returned to")} ${esc(next.detail)}</span>
      ${next.dueDate ? `<br><small>Return by ${esc(formatDate(next.dueDate + "T12:00:00"))}</small>` : ""}`;
  }
  if ($("confirmTitle")) {
    $("confirmTitle").textContent = next.eventType === "received" ? "Confirm item received" : next.eventType === "returned" ? "Confirm item returned" : "Is this correct?";
  }
  ["actionDialog", "resolveDialog"].forEach(id => {
    if ($(id)?.open) $(id).close();
  });
  $("confirmDialog")?.showModal();
}

function commitDraft() {
  if (!draft) return;
  const now = new Date().toISOString();
  let item = draft.id ? data.items.find(i => i.id === draft.id) : findItem(draft.name);
  if (!item) {
    item = { id: generateId(), name: draft.name, createdAt: now };
    data.items.push(item);
  }
  Object.assign(item, {
    name: draft.name,
    status: draft.status,
    detail: draft.detail,
    dueDate: draft.dueDate || "",
    createdAt: item.createdAt || now,
    updatedAt: now
  });
  data.events.push({
    id: generateId(),
    itemId: item.id,
    itemName: item.name,
    type: draft.eventType,
    title: eventTitle(draft.eventType, item.name),
    detail: describe(item),
    at: now
  });
  $("confirmDialog")?.close();
  persist();
  updatePlaceFilterOptions();
  addMessage("assistant", `${item.name} is now recorded: ${describe(item)}.`);
  showToast(`${item.name} updated`);
  draft = null;
}

function openResolve(item, type) {
  if (!item) return;
  $("resolveForm")?.reset();
  if ($("resolveId")) $("resolveId").value = item.id;
  if ($("resolveForm")) $("resolveForm").dataset.type = type;
  const received = type === "receive";
  if ($("resolveTitle")) $("resolveTitle").textContent = received ? `Receive ${item.name} back` : `Return ${item.name}`;
  if ($("resolveCopy")) {
    $("resolveCopy").textContent = received
      ? `${item.name} is recorded with ${item.detail}. Choose where you put it after receiving it.`
      : `This marks ${item.name} as returned to ${item.detail} and clears it from active items.`;
  }
  if ($("returnedLocationField")) $("returnedLocationField").classList.toggle("hidden", !received);
  if ($("returnedLocation")) $("returnedLocation").required = received;
  $("resolveDialog")?.showModal();
}

// Delete confirmation handling
let pendingDeleteId = null;
function openDeleteConfirm(item) {
  if (!item) return;
  pendingDeleteId = item.id;
  if ($("deleteConfirmTitle")) $("deleteConfirmTitle").textContent = `Remove "${item.name}"?`;
  if ($("deleteConfirmBody")) $("deleteConfirmBody").textContent = `This will remove ${item.name} from your active records. Its activity history will remain visible in the History tab.`;
  $("deleteConfirmDialog")?.showModal();
}

if ($("deleteCancelBtn")) $("deleteCancelBtn").onclick = () => $("deleteConfirmDialog")?.close();
if ($("deleteConfirmBtn")) {
  $("deleteConfirmBtn").onclick = () => {
    const item = data.items.find(i => i.id === pendingDeleteId);
    if (!item) { $("deleteConfirmDialog")?.close(); return; }
    data.items = data.items.filter(i => i.id !== item.id);
    data.events.push({
      id: generateId(),
      itemId: item.id,
      itemName: item.name,
      type: "deleted",
      title: eventTitle("deleted", item.name),
      detail: "Active record deleted",
      at: new Date().toISOString()
    });
    persist();
    addMessage("assistant", `I've removed ${item.name} from your records.`);
    showToast(`${item.name} removed`);
    $("deleteConfirmDialog")?.close();
    pendingDeleteId = null;
  };
}

// Local text intent parser & conversational intelligence engine
function answerText(raw) {
  const text = raw.trim();
  const lower = norm(text);
  if (!text) return;

  // 1a. Bulk delete prevention (Chatbot cannot delete all items at once)
  if (
    /^(?:delete|remove|clear|forget|wipe|erase) (?:all|everything|all items|all my items|all the items|every item)$/i.test(lower) ||
    /^(?:can you |please )?(?:delete|remove|clear|wipe) (?:all|everything|all items|all my items|all the items)/i.test(lower) ||
    /(?:delete|remove|clear) all items at once/i.test(lower) ||
    /delete (?:all|everything)/i.test(lower)
  ) {
    return "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?";
  }

  // 1b. Single item delete / remove commands
  let match = lower.match(/^(?:delete|remove|forget) (?:my )?(.+)$/);
  if (match) {
    const target = match[1].trim();
    if (/^(?:all|everything|all items|all my items|all the items|every item)$/i.test(target)) {
      return "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?";
    }
    const item = findItem(target);
    if (item) { openDeleteConfirm(item); return `I've opened a confirmation to remove ${item.name}.`; }
    return `I don't have a record for ${target}.`;
  }

  // 2. Where is my item / find query
  match = lower.match(/^(?:where (?:is|are)|where did i (?:put|keep)) (?:my )?(.+)$/);
  if (match) {
    const item = findItem(match[1]);
    return item ? `${item.name} is ${describe(item).toLowerCase()}.` : `I don't have a record for ${match[1]}. Would you like me to remember where you put it?`;
  }

  // 3. Who has my item
  match = lower.match(/^who has (?:my )?(.+)$/);
  if (match) {
    const item = findItem(match[1]);
    return item?.status === "lent"
      ? `${item.detail} has your ${item.name}.`
      : item ? `Your ${item.name} is not marked as lent.` : `I don't have a record for ${match[1]}.`;
  }

  // 4. Lent queries
  if (/what (?:did i|have i) lend|what is lent|what's lent/.test(lower)) {
    const items = data.items.filter(i => i.status === "lent");
    return items.length ? `You lent ${items.map(i => `${i.name} to ${i.detail}`).join(", ")}.` : "You don't have any items currently marked as lent.";
  }

  // 5. Borrowed queries
  if (/what (?:did i|have i) borrow|what is borrowed|what's borrowed/.test(lower)) {
    const items = data.items.filter(i => i.status === "borrowed");
    return items.length ? `You borrowed ${items.map(i => `${i.name} from ${i.detail}`).join(", ")}.` : "You don't have any items marked as borrowed.";
  }

  // 6. Packed container queries
  match = lower.match(/^what(?:'s| is) in (?:my |the )?(.+)$/);
  if (match) {
    const items = data.items.filter(i => i.status === "packed" && norm(i.detail).includes(norm(match[1])));
    return items.length ? `${match[1]} contains ${items.map(i => i.name).join(", ")}.` : `I don't have anything recorded in ${match[1]}.`;
  }

  // 7. Conversational: How are you?
  if (/^(?:how are (?:you|u)|how r (?:you|u)|how're you|how are you doing|how are u doing|how's it going|hows it going|how do you feel|how are things|how are you today|how do you do)/i.test(lower)) {
    return "I'm doing great, thank you for asking! I'm here and ready to help you track your belongings, remember where you put things, or check on loans. How are you doing today?";
  }

  // 8. Conversational: How can you help me? / Capabilities / What can you do?
  if (/^(?:how can (?:you|she|liora) help(?: me)?|how (?:do|can) you help|what can (?:you|u) do|what do you do|what are your (?:features|capabilities)|help(?: me)?|how does (?:this|liora) work|how to use|what is liora|guide me)/i.test(lower)) {
    return "I'm Liora, your physical memory assistant! Here are key ways I can help:\n• Store & Find: Tell me where you put something (e.g. 'I put my keys in the drawer') or ask 'Where are my keys?'\n• Travel & Packing: Tell me what's packed in your bags or ask 'What is in my backpack?'\n• Lent & Borrowed: Track items you lend or borrow with return dates.\n• Voice or Typing: Use the floating bar at the bottom to type or tap the mic for live voice!";
  }

  // 9. Conversational: General Greetings (hi, hello, hey)
  if (/^(?:hi|hello|hey|hey there|greetings|good (?:morning|afternoon|evening|day)|yo|hola)(?: liora)?$/i.test(lower)) {
    return "Hello! Great to have you here. Tell me what you'd like to store or find, or tap the mic anytime to talk.";
  }

  // 10a. Conversational: About Faysal Iqbal / Creator Bio ("tell me about him" / "tellme about him" / "who is he")
  const isFollowUpAboutCreator = (
    /^(?:who (?:is he|he is|is that|that is|is him|he was)|tell ?(?:me|be)? (?:more )?about (?:him|that|faysal|the developer|your developer|the creator|your creator)|what does he do|more about him|tell me more|who's that|who's he|who is this guy|what is his background|where does he study|tell me about his background|about (?:him|faysal|the developer|your developer|the creator|your creator))$/i.test(lower) ||
    (/\b(?:he|him|his)\b/i.test(lower) && /^(?:who|what|tell|about|where|know)/i.test(lower))
  );

  if (
    /\bfaysal\b/i.test(lower) ||
    /^(?:tell ?(?:me|be)? (?:more )?about (?:the |your )?(?:developer|creator|maker|author|founder|him)|about (?:the |your )?(?:developer|creator|author|him)|who is he|who he is|what about him)/i.test(lower) ||
    isFollowUpAboutCreator
  ) {
    return "Faysal Iqbal is a Computer Science and Engineering student at Ahsanullah University of Science and Technology, passionate about cybersecurity, AI/ML, programming, and robotics. He enjoys building projects, exploring technology, and continuously learning. Outside tech, he loves music, gaming, fitness, gardening, and meaningful conversations.";
  }

  // 10d. Conversational: About the user ("tell me about me" / "who am I")
  if (/^(?:tell ?(?:me|be)? (?:more )?about me|about me|who (?:am i|is me)|know about me|do you know (?:who i am|about me|me)|what do you know about me|what about me)/i.test(lower)) {
    const active = activeItems();
    return `You're the user of Liora! I'm here to track and remember all your physical belongings, packed items, and loans. You currently have ${active.length} active item${active.length === 1 ? '' : 's'} tracked.`;
  }

  // 10b. Conversational: Who made you / Developer Identification
  if (
    /^(?:who(?:'s| is| are)? (?:the |your |liora's )?(?:developer|creator|maker|author|founder|programmer|builder)|who (?:made|created|built|developed|programmed|coded|designed) (?:you|liora|this|this app|the app|the software)|who (?:wrote|did) this)$/i.test(lower) ||
    /^(?:developer|creator|who made you|who made liora|who created you|who developed you|who is developer|who is creator)$/i.test(lower)
  ) {
    return "Faysal Iqbal";
  }

  // 10c. Conversational: Who are you / Identity
  if (/^(?:who are (?:you|u)|what(?:'s| is) your name|what are you|are you (?:an ai|human|a bot)|tell me about yourself)/i.test(lower)) {
    return "I'm Liora, your personal physical memory and voice assistant. I keep track of all your belongings, packed bags, and loaned items so you never misplace anything.";
  }

  // 11. Conversational: Thanks & Gratitude
  if (/^(?:thank (?:you|u)|thanks(?: a lot| so much)?|thx|appreciate it|good job|great job|awesome|perfect|you(?:'re| are) great)$/i.test(lower)) {
    return "You're very welcome! I'm always here whenever you need to find or store anything.";
  }

  // 12. Conversational: Inventory / What items do I have?
  if (/^(?:what do i have|what (?:items|things) (?:are|do i have) (?:saved|tracked|stored)|list (?:all |my )?(?:items|things|belongings)|show (?:my )?(?:items|things)|inventory|summary)/i.test(lower)) {
    const active = activeItems();
    if (!active.length) {
      return "You don't have any items tracked yet. Try saying: 'I put my passport in the desk drawer' or use the 'Add item' button above!";
    }
    const sample = active.slice(0, 5).map(i => `• ${i.name} (${statusCopy[i.status]?.label || 'Stored'}: ${i.detail})`).join("\n");
    const extra = active.length > 5 ? `\n...and ${active.length - 5} more.` : "";
    return `You have ${active.length} active item(s) tracked:\n${sample}${extra}`;
  }

  // 13. Conversational: How to add an item
  if (/^(?:how (?:do i|to) (?:add|save|store|record) (?:an? )?(?:item|thing|something))/i.test(lower)) {
    return "To add an item, you can either:\n1. Click the 'Add item' button in the top right.\n2. Type directly in the bar below: 'I put my keys on the entryway table' or 'I packed my charger in the black bag'.\n3. Tap the mic and tell me out loud!";
  }

  // 14. Conversational: Privacy
  if (/^(?:is (?:my data|this) (?:safe|private)|where is (?:my )?data stored|privacy|who can see (?:my )?data)/i.test(lower)) {
    return "Your belongings and records are stored locally in your browser session for maximum privacy. No public tracking or accounts are involved. You can click 'View privacy details' in the sidebar anytime for full transparency or to clear your data.";
  }

  // 15. Conversational: Goodbyes
  if (/^(?:bye|goodbye|see (?:you|ya)|talk to you later|good night|goodnight|cya)/i.test(lower)) {
    return "Goodbye! Have a wonderful day, and rest assured your belongings are safely remembered.";
  }

  // 16. Conversational: Jokes & Fun
  if (/^(?:tell me a joke|joke|make me laugh)/i.test(lower)) {
    return "Why did the key go to school? To improve its memory! But don't worry, with me around, you'll never lose your keys again.";
  }

  // 17. Storage intent regexes
  match = text.match(/^I (?:put|kept) (?:my )?(.+?) in (?:the )?(.+)[.!]?$/i) || text.match(/^(?:My )?(.+?) (?:is|are) in (?:the )?(.+)[.!]?$/i);
  if (match) {
    prepareDraft({ name: match[1].trim(), status: "stored", detail: match[2].replace(/[.!]$/, ""), eventType: "stored" }, "chat");
    return "I've prepared that location. Please confirm to save.";
  }

  match = text.match(/^I packed (?:my )?(.+?) in(?:to)? (?:my |the )?(.+)[.!]?$/i);
  if (match) {
    prepareDraft({ name: match[1].trim(), status: "packed", detail: match[2].replace(/[.!]$/, ""), eventType: "packed" }, "chat");
    return "I've prepared that packing record. Please confirm to save.";
  }

  match = text.match(/^I lent (?:my )?(.+?) to (.+)[.!]?$/i);
  if (match) {
    prepareDraft({ name: match[1].trim(), status: "lent", detail: match[2].replace(/[.!]$/, ""), eventType: "lent" }, "chat");
    return "I've prepared that loan record. Please confirm to save.";
  }

  match = text.match(/^I borrowed (?:a |an |the )?(.+?) from (.+)[.!]?$/i);
  if (match) {
    prepareDraft({ name: match[1].trim(), status: "borrowed", detail: match[2].replace(/[.!]$/, ""), eventType: "borrowed" }, "chat");
    return "I've prepared that borrowed item record. Please confirm to save.";
  }

  return "I can save an item's location, pack it in a container, record a loan, find your belongings, or answer questions. Try: 'Where are my keys?' or 'I put my passport in the desk drawer.'";
}

// Text chat handler via AssemblyAI LLM endpoint
async function sendText(text) {
  if (!text?.trim() || chatBusy) return;
  chatBusy = true;
  const input = $("chatInput");
  const prevValue = input ? input.value : "";
  if (input) {
    input.value = "";
    input.disabled = true;
  }
  addMessage("user", text.trim());
  showTypingIndicator();
  if ($("connectionLabel")) $("connectionLabel").textContent = "Thinking...";
  playSound("send");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: chat.slice(-12).map(m => ({ role: m.role, content: m.text })),
        items: activeItems()
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "AI response failed");

    hideTypingIndicator();
    addMessage("assistant", result.assistant_reply);
    if ($("connectionLabel")) $("connectionLabel").textContent = "Active";

    if (result.action && result.action !== "none" && result.item) {
      if (result.action === "deleted") {
        const target = String(result.item || "").trim().toLowerCase();
        if (/^(?:all|everything|all items|all my items|all the items|every item)$/i.test(target)) {
          addMessage("assistant", "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?");
          return;
        }
        const found = findItem(result.item);
        if (found) setTimeout(() => openDeleteConfirm(found), 80);
      } else {
        setTimeout(() => runVoiceTool("draft_change", {
          item: result.item,
          action: result.action,
          detail: result.detail,
          due_date: result.due_date
        }), 80);
      }
    }
  } catch (error) {
    hideTypingIndicator();
    console.warn("Using local fallback:", error.message);
    const answer = answerText(text);
    if (input) input.value = prevValue;
    setTimeout(() => {
      addMessage("assistant", answer || "Sorry, I couldn't reach the server right now.");
      if ($("connectionLabel")) $("connectionLabel").textContent = "Local";
    }, 160);
  } finally {
    chatBusy = false;
    if (input) {
      input.disabled = false;
      input.focus();
    }
  }
}

function handleChatSubmit() {
  if (chatBusy) return;
  const text = $("chatInput")?.value.trim();
  if (text) {
    if ($("chatInput")) $("chatInput").value = "";
    sendText(text);
  }
}

if ($("sendBtn")) $("sendBtn").onclick = handleChatSubmit;
if ($("chatInput")) {
  $("chatInput").onkeydown = e => {
    if (e.key === "Enter") handleChatSubmit();
  };
}

document.querySelectorAll("#suggestions button").forEach(b => {
  b.onclick = () => { if (!chatBusy) sendText(b.textContent); };
});

// Form and dialog event bindings
if ($("actionInput")) $("actionInput").onchange = updateActionFields;
document.querySelectorAll("[data-close]").forEach(b => {
  b.onclick = () => b.closest("dialog")?.close();
});
if ($("actionForm")) {
  $("actionForm").onsubmit = e => {
    e.preventDefault();
    const id = $("editingId")?.value;
    const status = $("actionInput")?.value;
    const existing = id ? data.items.find(i => i.id === id) : null;
    prepareDraft({
      id: id || undefined,
      name: $("itemInput")?.value.trim(),
      status,
      detail: $("detailInput")?.value.trim(),
      dueDate: $("dueInput")?.value,
      eventType: existing ? (status === "lent" ? "lent" : "moved") : status
    });
  };
}

if ($("resolveForm")) {
  $("resolveForm").onsubmit = e => {
    e.preventDefault();
    const item = data.items.find(i => i.id === $("resolveId")?.value);
    const type = e.currentTarget.dataset.type;
    if (!item) return;
    prepareDraft({
      id: item.id,
      name: item.name,
      status: type === "receive" ? "stored" : "returned",
      detail: type === "receive" ? $("returnedLocation")?.value.trim() : item.detail,
      dueDate: "",
      eventType: type === "receive" ? "received" : "returned"
    }, "resolve");
  };
}

if ($("editDraft")) {
  $("editDraft").onclick = () => {
    const returnTo = draft?.returnTo;
    $("confirmDialog")?.close();
    if (returnTo === "resolve") {
      $("resolveDialog")?.showModal();
    } else if (draft) {
      openAction(draft.status, draft.id ? data.items.find(i => i.id === draft.id) : null);
      if ($("detailInput")) $("detailInput").value = draft.detail;
      if ($("dueInput")) $("dueInput").value = draft.dueDate || "";
    }
  };
}
if ($("saveDraft")) $("saveDraft").onclick = commitDraft;

// Card button delegation
if ($("list")) {
  $("list").onclick = e => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    const item = data.items.find(i => i.id === button.dataset.id);
    const action = button.dataset.action;
    if (["move", "lend"].includes(action)) openAction(action, item);
    if (["receive", "return"].includes(action)) openResolve(item, action);
    if (action === "delete") openDeleteConfirm(item);
  };
}

function switchView(view) {
  currentView = view;
  closeMobileSidebar();
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  render();
}

// Mobile sidebar drawer controllers
function openMobileSidebar() {
  $("appSidebar")?.classList.add("is-open");
  $("sidebarBackdrop")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeMobileSidebar() {
  $("appSidebar")?.classList.remove("is-open");
  $("sidebarBackdrop")?.classList.add("hidden");
  document.body.style.overflow = "";
}

if ($("mobileMenuBtn")) $("mobileMenuBtn").onclick = openMobileSidebar;
if ($("sidebarCloseBtn")) $("sidebarCloseBtn").onclick = closeMobileSidebar;
if ($("sidebarBackdrop")) $("sidebarBackdrop").onclick = closeMobileSidebar;

window.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeMobileSidebar();
  }
});

// Sidebar view switching
document.querySelectorAll("#sidebarNav a").forEach(b => {
  b.onclick = e => {
    e.preventDefault();
    if (b.id === "howItWorksNavBtn") {
      closeMobileSidebar();
      showOverlay("howItWorksOverlay");
      return;
    }
    switchView(b.dataset.path);
  };
});

if ($("searchInput")) $("searchInput").oninput = render;

// Filter pills & place/sort event handling
document.querySelectorAll("#filterPills .filter-pill").forEach(btn => {
  btn.onclick = () => {
    switchView(btn.dataset.filter);
  };
});

if ($("placeFilter")) $("placeFilter").onchange = render;
if ($("sortSelect")) $("sortSelect").onchange = render;

// AssemblyAI Voice Agent Tool Definitions
function voiceTools() {
  return [
    {
      type: "function",
      name: "get_creator_info",
      description: "Get verified information about Liora's creator and developer Faysal Iqbal. Use when asked who made or created you, who your developer is, or for Faysal Iqbal's bio.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", enum: ["creator", "bio"], description: "Use 'creator' for creator name Faysal Iqbal, or 'bio' for Faysal's background." }
        },
        required: ["topic"]
      }
    },
    {
      type: "function",
      name: "draft_change",
      description: "Prepare an on-screen confirmation for saving, moving, packing, lending, borrowing, returning, or deleting a single item. Actions: stored, packed, lent, borrowed, received, returned, deleted. Note: Deleting all items at once is strictly disallowed.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "Name of the single item (cannot be 'all' or 'everything')." },
          action: { type: "string", enum: ["stored", "packed", "lent", "borrowed", "received", "returned", "deleted"] },
          detail: { type: "string", description: "Location, container, or person name." },
          due_date: { type: "string" }
        },
        required: ["item", "action"]
      }
    },
    {
      type: "function",
      name: "find_item",
      description: "Find an existing item record by name.",
      parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] }
    },
    {
      type: "function",
      name: "list_items",
      description: "List items filtered by status or container.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["stored", "packed", "lent", "borrowed", "any"] },
          detail: { type: "string" }
        },
        required: ["status"]
      }
    }
  ];
}

function runVoiceTool(name, args) {
  if (name === "get_creator_info") {
    if (args.topic === "creator") {
      return { creator: "Faysal Iqbal", answer: "Faysal Iqbal" };
    }
    return {
      bio: "Faysal Iqbal is a Computer Science and Engineering student at Ahsanullah University of Science and Technology, passionate about cybersecurity, AI/ML, programming, and robotics. He enjoys building projects, exploring technology, and continuously learning. Outside tech, he loves music, gaming, fitness, gardening, and meaningful conversations."
    };
  }
  if (name === "find_item") {
    const item = findItem(args.item);
    return item
      ? { found: true, item: item.name, state: item.status, detail: item.detail, due_date: item.dueDate || null }
      : { found: false, message: "No current record exists." };
  }
  if (name === "list_items") {
    let items = activeItems();
    if (args.status !== "any") items = items.filter(i => i.status === args.status);
    if (args.detail) items = items.filter(i => norm(i.detail).includes(norm(args.detail)));
    return { items: items.map(i => ({ name: i.name, state: i.status, detail: i.detail, due_date: i.dueDate || null })) };
  }
  if (name === "draft_change") {
    const item = findItem(args.item);
    const action = args.action;
    if (!String(args.item || "").trim()) return { shown: false, error: "An item name is required." };

    if (action === "deleted") {
      const target = String(args.item || "").trim().toLowerCase();
      if (/^(?:all|everything|all items|all my items|all the items|every item)$/i.test(target)) {
        return { shown: false, error: "Items can only be deleted one by one to keep your records safe." };
      }
      if (!item) return { shown: false, error: "No active item found with that name." };
      setTimeout(() => openDeleteConfirm(item), 80);
      return { shown: true, message: "Delete confirmation opened." };
    }
    if (["stored", "packed", "lent", "borrowed", "received"].includes(action) && !String(args.detail || "").trim()) {
      return { shown: false, error: "A location or person is required." };
    }
    if (["received", "returned"].includes(action) && !item) {
      return { shown: false, error: "No active item found to return." };
    }

    prepareDraft({
      id: item?.id,
      name: item?.name || args.item,
      status: action === "received" ? "stored" : action === "returned" ? "returned" : action,
      detail: action === "returned" ? item.detail : args.detail,
      dueDate: args.due_date || "",
      eventType: action
    }, "voice");
    return { shown: true, message: "Confirmation displayed on screen." };
  }
  return { error: "Unknown tool" };
}

// Audio encoding and streaming
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function stopPlayback() {
  playingSources.forEach(source => {
    try { source.stop(); } catch {}
  });
  playingSources.clear();
  nextPlayTime = outputContext?.currentTime || 0;
}

async function playPcm(base64) {
  if (!soundsEnabled || !base64) return;
  const ctx = await ensureOutputContext();
  const raw = atob(base64);
  const pcm = new Float32Array(Math.floor(raw.length / 2));
  for (let i = 0; i < pcm.length; i++) {
    let val = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
    if (val >= 32768) val -= 65536;
    pcm[i] = val / 32768;
  }
  const audio = ctx.createBuffer(1, pcm.length, 24000);
  audio.getChannelData(0).set(pcm);
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  source.onended = () => playingSources.delete(source);
  playingSources.add(source);
  nextPlayTime = Math.max(nextPlayTime, ctx.currentTime + 0.01);
  source.start(nextPlayTime);
  nextPlayTime += audio.duration;
}

// Active voice session state management
function setVoiceUi(active) {
  if (active) {
    $("voiceCapsule")?.classList.remove("hidden");
  } else {
    $("voiceCapsule")?.classList.add("hidden");
  }
}

const AGENT_PROMPT = `You are Liora, a helpful, warm, and precise conversational physical memory assistant for tracking personal belongings. Keep spoken responses concise, clear, and natural.

CRITICAL CREATOR & DEVELOPER IDENTITY (HIGHEST PRIORITY):
- Creator & Developer: You were created and developed solely by Faysal Iqbal.
- If the user asks who made you, who created you, who developed you, who built you, or who your developer/creator is (e.g. "Who made you?", "Who is your creator?", "Who developed you?"), you MUST ALWAYS state: "Faysal Iqbal".
- NEVER state that you were developed, created, or made by Google, OpenAI, or anyone else. Your only creator and developer is Faysal Iqbal.
- About Faysal Iqbal / Creator ("tell me about him"): If the user asks about Faysal Iqbal, who he is, or asks "tell me about him", "tellme about him", "about him", or "who is he", reply: "Faysal Iqbal is a Computer Science and Engineering student at Ahsanullah University of Science and Technology, passionate about cybersecurity, AI/ML, programming, and robotics. He enjoys building projects, exploring technology, and continuously learning. Outside tech, he loves music, gaming, fitness, gardening, and meaningful conversations."
- About the User ("tell me about me"): If the user asks "tell me about me" or "who am I", reply: "You're the user of Liora! I'm here to remember and track all your physical belongings, packed items, and loans."

SINGLE-ITEM DELETION RULES (MANDATORY):
- The chatbot CANNOT delete all items at once. You can ONLY delete items one by one.
- If the user asks to delete all items, remove all items, delete everything, or clear all records (e.g. "delete all", "delete all items", "remove everything"), you MUST refuse and state: "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?"
- Never call draft_change with action "deleted" for "all" or "everything". Only call draft_change for a single, specific item.

ITEM TRACKING INSTRUCTIONS:
- Always use find_item before answering where an item is or who has it.
- Use list_items for questions about groups, bags, lent items, or borrowed items.
- Use draft_change for every requested record change (stored, packed, lent, borrowed, received, returned, deleted). A draft is not saved until the user confirms it on screen, so never say a change is saved before confirmation.
- If a lent item came back, ask where it is now, then draft received. If a borrowed item was returned to its owner, draft returned.
- To delete an item, verify it is a single specific item and call draft_change with action=deleted.
- Never invent a location, person, or record.`;

function sessionConfig(includeGreeting) {
  return {
    system_prompt: AGENT_PROMPT,
    ...(includeGreeting ? { greeting: "Hi, I'm Liora. What would you like me to remember or find?" } : {}),
    output: { voice: "ivy", format: { encoding: "audio/pcm" }, volume: 100 },
    input: {
      format: { encoding: "audio/pcm" },
      transcription_mode: "max_accuracy",
      keyterms: ["Liora", "Faysal", "Iqbal", "Ahsanullah"],
      turn_detection: { interrupt_response: true }
    },
    tools: voiceTools()
  };
}

function releaseMicrophone() {
  micStream?.getTracks().forEach(track => track.stop());
  micStream = null;
  try {
    sourceNode?.disconnect();
    workletNode?.disconnect();
  } catch {}
  sourceNode = null;
  workletNode = null;
  inputContext?.close();
  inputContext = null;
  muted = false;
}

function refreshSessionIdleTimer() {
  clearTimeout(sessionIdleTimer);
  if (!micStream) sessionIdleTimer = setTimeout(() => endAgentSession(false), 120000);
}

async function handleAgentEvent(m) {
  if (m.type === "session.ready") {
    sessionReady = true;
    if ($("connectionLabel")) $("connectionLabel").textContent = wantsMic ? "Voice connected" : "Connected";
    try {
      if (wantsMic && !micStream) await beginMic();
      sessionWaiter?.resolve();
    } catch (error) {
      releaseMicrophone();
      sessionWaiter?.reject(error);
      if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Microphone unavailable";
    }
    sessionWaiter = null;
    return;
  }

  if (m.type === "input.speech.started") {
    stopPlayback();
    if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Listening to your voice...";
  }
  if (m.type === "input.speech.stopped") {
    if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Thinking…";
  }
  if (m.type === "transcript.user") {
    addMessage("user", m.text);
  }
  if (m.type === "reply.started") {
    if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Liora is speaking";
    if ($("connectionLabel")) $("connectionLabel").textContent = "Responding…";
  }
  if (m.type === "reply.audio") {
    await playPcm(m.data);
  }
  if (m.type === "transcript.agent") {
    let cleanText = m.text;
    if (/\b(?:google|openai)\b/i.test(cleanText) && /\b(?:developed|made|created|built)\b/i.test(cleanText)) {
      cleanText = "I was developed by Faysal Iqbal.";
    }
    addMessage("assistant", cleanText);
    if ($("connectionLabel")) $("connectionLabel").textContent = micStream ? "Voice connected" : "Connected";
  }
  if (m.type === "tool.call") {
    pendingTools.push({ callId: m.call_id, result: runVoiceTool(m.name, m.arguments) });
  }
  if (m.type === "reply.done") {
    if (m.status !== "interrupted" && socket?.readyState === WebSocket.OPEN) {
      pendingTools.splice(0).forEach(call => {
        socket.send(JSON.stringify({
          type: "tool.result",
          call_id: call.callId,
          result: JSON.stringify(call.result),
          is_error: Boolean(call.result?.error)
        }));
      });
    } else {
      pendingTools = [];
    }
    if (wantsMic && $("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Listening to your voice...";
    refreshSessionIdleTimer();
  }
  if (m.type === "session.error") {
    const error = new Error(m.message || "Session error");
    sessionWaiter?.reject(error);
    sessionWaiter = null;
    if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Unavailable";
    if ($("connectionLabel")) $("connectionLabel").textContent = "Connection error";
  }
  if (m.type === "session.ended") {
    sessionReady = false;
    releaseMicrophone();
    setVoiceUi(false);
    if ($("connectionLabel")) $("connectionLabel").textContent = "Active";
  }
}

async function ensureAgentSession(enableMic = false) {
  wantsMic = wantsMic || enableMic;
  await ensureOutputContext();
  if (socket?.readyState === WebSocket.OPEN && sessionReady) {
    if (enableMic && !micStream) await beginMic();
    return;
  }
  if (sessionWaiter) return sessionWaiter.promise;

  manualStop = false;
  sessionReady = false;
  sessionWaiter = {};
  sessionWaiter.promise = new Promise((resolve, reject) => Object.assign(sessionWaiter, { resolve, reject }));

  try {
    const response = await fetch("/api/voice-token");
    const body = await response.json();
    if (!response.ok || !body.token) throw new Error(body.error || "Voice token unavailable");

    socket = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(body.token)}`);
    socket.onopen = () => socket.send(JSON.stringify({ type: "session.update", session: sessionConfig(enableMic) }));
    socket.onmessage = e => handleAgentEvent(JSON.parse(e.data)).catch(err => console.error("Liora voice event error", err));
    socket.onerror = () => {
      const error = new Error("Could not connect to AssemblyAI");
      sessionWaiter?.reject(error);
      sessionWaiter = null;
      if ($("connectionLabel")) $("connectionLabel").textContent = "Connection error";
    };
    socket.onclose = () => {
      sessionReady = false;
      const waiting = sessionWaiter;
      sessionWaiter = null;
      waiting?.reject(new Error("Session closed"));
      releaseMicrophone();
      if (!manualStop && $("connectionLabel")) $("connectionLabel").textContent = "Disconnected";
    };
  } catch (error) {
    sessionWaiter?.reject(error);
    sessionWaiter = null;
    throw error;
  }
  return sessionWaiter?.promise;
}

async function startVoice() {
  if (micStream) return stopVoice();
  playSound("tap");
  setVoiceUi(true);
  wantsMic = true;
  if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Connecting…";
  try {
    await ensureAgentSession(true);
  } catch (error) {
    if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Voice unavailable";
    setTimeout(() => setVoiceUi(false), 2500);
  }
}

async function beginMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  inputContext = new AudioContext();
  await inputContext.resume();
  await inputContext.audioWorklet.addModule("/pcm-processor.js");
  sourceNode = inputContext.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(inputContext, "liora-pcm", {
    processorOptions: { inputSampleRate: inputContext.sampleRate, targetSampleRate: 24000 }
  });
  workletNode.port.onmessage = e => {
    if (sessionReady && socket?.readyState === WebSocket.OPEN && !muted) {
      socket.send(JSON.stringify({ type: "input.audio", audio: toBase64(e.data) }));
    }
  };
  sourceNode.connect(workletNode);
  workletNode.connect(inputContext.destination);

  if ($("connectionLabel")) $("connectionLabel").textContent = "Voice active";
  if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = "Listening to your voice...";
  playSound("connect");
}

function endAgentSession(showEnd = true) {
  clearTimeout(sessionIdleTimer);
  manualStop = true;
  sessionReady = false;
  wantsMic = false;
  releaseMicrophone();
  stopPlayback();
  const active = socket;
  socket = null;
  if (active?.readyState === WebSocket.OPEN) {
    active.send(JSON.stringify({ type: "session.end" }));
    setTimeout(() => { if (active.readyState < WebSocket.CLOSING) active.close(); }, 800);
  } else if (active?.readyState === WebSocket.CONNECTING) {
    active.close();
  }
  sessionWaiter = null;
  if ($("connectionLabel")) $("connectionLabel").textContent = "Active";
  setVoiceUi(false);
  if (showEnd) playSound("end");
}

function stopVoice() {
  endAgentSession(true);
}

// Global buttons
if ($("talkBtn")) $("talkBtn").onclick = startVoice;
if ($("endBtn")) $("endBtn").onclick = stopVoice;
if ($("addBtn")) $("addBtn").onclick = () => openAction();
if ($("modeVoiceBtn")) $("modeVoiceBtn").onclick = startVoice;
if ($("modeTypeBtn")) $("modeTypeBtn").onclick = () => $("chatInput")?.focus();
if ($("voiceTypeBtn")) $("voiceTypeBtn").onclick = stopVoice;

// Privacy dialog and data clearing
if ($("openPrivacyBtn")) {
  $("openPrivacyBtn").onclick = () => $("privacyDialog")?.showModal();
}

if ($("deleteAllDataBtn")) {
  $("deleteAllDataBtn").onclick = () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("nestly-data-v2");
    data = { items: [], events: [] };
    chat = [
      { role: "assistant", text: "Hi, I'm Liora. All previous records have been cleared. What would you like to track?", at: new Date().toISOString() }
    ];
    persist();
    showToast("All Liora data cleared");
    $("privacyDialog")?.close();
  };
}

if ($("muteButton")) {
  $("muteButton").onclick = () => {
    muted = !muted;
    micStream?.getAudioTracks().forEach(t => t.enabled = !muted);
    $("muteButton").innerHTML = icon(muted ? "mute" : "mic");
    if ($("voiceStatusLabel")) $("voiceStatusLabel").textContent = muted ? "Muted" : "Listening…";
    playSound("tap");
  };
}

// Search shortcut (Ctrl+K or ⌘+K)
window.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("searchInput")?.focus();
  }
});

// ─────────────────────────────────────────────────────────────────────
// OVERLAY HELPERS (used by How Liora Works page)
// ─────────────────────────────────────────────────────────────────────
function showOverlay(id) {
  document.getElementById(id)?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function hideOverlay(id) {
  document.getElementById(id)?.classList.add("hidden");
  document.body.style.overflow = "";
}

// ─────────────────────────────────────────────────────────────────────
// HOW LIORA WORKS OVERLAY
// ─────────────────────────────────────────────────────────────────────
function closeHowItWorks() {
  hideOverlay("howItWorksOverlay");
}

if ($("howItWorksCloseBtn")) {
  $("howItWorksCloseBtn").onclick = closeHowItWorks;
}
if ($("howItWorksCloseBtnBottom")) {
  $("howItWorksCloseBtnBottom").onclick = closeHowItWorks;
}
if ($("howItWorksNavBtn")) {
  $("howItWorksNavBtn").onclick = () => showOverlay("howItWorksOverlay");
}

// ─────────────────────────────────────────────────────────────────────
// JUDGE-READY DEMO DATA LOADER (Priority 1)
// ─────────────────────────────────────────────────────────────────────
function loadDemoData() {
  if (data.items.length > 0) {
    const confirmAdd = confirm(
      "You already have tracked belongings. Would you like to add the 5 sample demo items to your collection?"
    );
    if (!confirmAdd) return;
  }

  const now = new Date();
  const dateStr = now.toISOString();

  // Due dates for loan demonstration
  const dCamera = new Date();
  dCamera.setDate(dCamera.getDate() + 4);
  const dBook = new Date();
  dBook.setDate(dBook.getDate() + 7);

  const demoItems = [
    {
      id: generateId(),
      name: "Passport",
      status: "stored",
      detail: "Bedroom drawer",
      dueDate: "",
      createdAt: new Date(now.getTime() - 86400000 * 3).toISOString(),
      updatedAt: dateStr
    },
    {
      id: generateId(),
      name: "Charger",
      status: "packed",
      detail: "Blue travel bag",
      dueDate: "",
      createdAt: new Date(now.getTime() - 86400000 * 2).toISOString(),
      updatedAt: dateStr
    },
    {
      id: generateId(),
      name: "Camera",
      status: "lent",
      detail: "Sarah",
      dueDate: dCamera.toISOString().split("T")[0],
      createdAt: new Date(now.getTime() - 86400000 * 5).toISOString(),
      updatedAt: dateStr
    },
    {
      id: generateId(),
      name: "Book",
      status: "borrowed",
      detail: "Adam",
      dueDate: dBook.toISOString().split("T")[0],
      createdAt: new Date(now.getTime() - 86400000 * 1).toISOString(),
      updatedAt: dateStr
    },
    {
      id: generateId(),
      name: "Headphones",
      status: "stored",
      detail: "Work backpack",
      dueDate: "",
      createdAt: dateStr,
      updatedAt: dateStr
    }
  ];

  demoItems.forEach(item => {
    // Avoid duplicate names
    const existing = findItem(item.name);
    if (!existing) {
      data.items.push(item);
      data.events.push({
        id: generateId(),
        itemId: item.id,
        itemName: item.name,
        type: item.status,
        title: eventTitle(item.status, item.name),
        detail: describe(item),
        at: item.updatedAt
      });
    }
  });

  persist();
  currentView = "all";
  render();
  showToast("Demo items loaded successfully");

  // Post helpful judge prompts in chat
  addMessage(
    "assistant",
    "I've loaded 5 realistic demo belongings: Passport (in bedroom drawer), Charger (in blue travel bag), Camera (lent to Sarah), Book (borrowed from Adam), and Headphones (in work backpack).\n\nTry asking:\n• \"Where is my passport?\"\n• \"What is in my blue travel bag?\"\n• \"Who has my camera?\"\n• \"What did I borrow from Adam?\"\n• \"Sarah returned my camera and I put it in the office cabinet.\""
  );
}

if ($("loadDemoBtn")) $("loadDemoBtn").onclick = loadDemoData;
if ($("loadDemoAssistantBtn")) $("loadDemoAssistantBtn").onclick = loadDemoData;

// ─────────────────────────────────────────────────────────────────────
// Initial boot
// ─────────────────────────────────────────────────────────────────────
render();

