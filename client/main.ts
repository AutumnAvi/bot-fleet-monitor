// Bot Fleet dashboard client. Read-only: it fetches what bots pushed from this
// Worker and renders it. There are no actions that message, start or stop a bot.

import {
  activityText,
  activityTone,
  accountMatches,
  buildFleetView,
  toRow,
  type AccountFilter,
  type BotRowView,
  type StatusFilter,
} from "../src/shared/fleet-view";
import { LIMITS, type ActivityItem, type BotDetail, type FleetResponse } from "../src/shared/model";
import { STATE_LABEL, lastSeenAt, type Bucket, type DisplayState } from "../src/shared/status";
import { formatClock, formatFull, formatRelative } from "../src/shared/time";
import { SignedOutError, fetchActivity, fetchBot, fetchFleet } from "./api";
import { h, icon, type IconName } from "./dom";

const REFRESH_MS = 30_000;
const PREFS_KEY = "botfleet.prefs.v1";
const LEAF_OPEN_NOTE = "Open works only for work-account bots. Leaf bots use a different Grok Bot login.";

interface DetailState {
  account: string;
  id: string;
  data: BotDetail | null;
  loading: boolean;
  error: string | null;
  /** data-key of the element to focus again when the drawer closes. */
  returnFocusKey: string | null;
}

interface State {
  data: FleetResponse | null;
  error: string | null;
  lastLoadedAt: number | null;
  /** serverNow - clientNow, so stale/relative times use the server clock. */
  clockOffset: number;
  account: AccountFilter;
  filter: StatusFilter;
  query: string;
  collapsed: Set<string>;
  olderActivity: ActivityItem[];
  olderNext: number | null;
  olderLoaded: boolean;
  /** Bumped whenever older pages are reset, so in-flight "View older" responses are dropped. */
  olderGen: number;
  loadingOlder: boolean;
  detail: DetailState | null;
}

const state: State = {
  data: null,
  error: null,
  lastLoadedAt: null,
  clockOffset: 0,
  account: "both",
  filter: "all",
  query: "",
  collapsed: new Set(),
  olderActivity: [],
  olderNext: null,
  olderLoaded: false,
  olderGen: 0,
  loadingOlder: false,
  detail: null,
};

const now = (): number => Date.now() + state.clockOffset;

// ------------------------------------------------------------------ prefs

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw) as { account?: string; filter?: string; collapsed?: unknown };
    if (prefs.account === "both" || prefs.account === "work" || prefs.account === "leaf") state.account = prefs.account;
    if (["all", "needs_me", "working", "idle", "stuck"].includes(prefs.filter ?? "")) {
      state.filter = prefs.filter as StatusFilter;
    }
    if (Array.isArray(prefs.collapsed)) {
      state.collapsed = new Set(prefs.collapsed.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // Storage unavailable or corrupt: use defaults.
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ account: state.account, filter: state.filter, collapsed: [...state.collapsed] }),
    );
  } catch {
    // Ignore: preferences are a convenience only.
  }
}

// ------------------------------------------------------------------ static layout

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs_me", label: "Needs me" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "stuck", label: "Stuck" },
];

const TILES: { id: Bucket; label: string; icon: IconName }[] = [
  { id: "needs_me", label: "Needs me", icon: "needsMe" },
  { id: "working", label: "Working", icon: "play" },
  { id: "idle", label: "Idle", icon: "idle" },
  { id: "stuck", label: "Stuck", icon: "stuck" },
];

const refs = {
  search: null as HTMLInputElement | null,
  chips: new Map<StatusFilter, HTMLButtonElement>(),
  tiles: new Map<Bucket, { button: HTMLButtonElement; count: HTMLElement }>(),
  account: null as HTMLSelectElement | null,
  fleet: null as HTMLElement | null,
  feed: null as HTMLElement | null,
  statusLine: null as HTMLElement | null,
  detailRoot: null as HTMLElement | null,
};

function buildLayout(root: HTMLElement): void {
  const search = h("input", {
    type: "search",
    placeholder: "Search bots...",
    "aria-label": "Search bots",
    autocomplete: "off",
    spellcheck: "false",
  });
  search.value = state.query;
  search.addEventListener("input", () => {
    state.query = search.value;
    renderFleet();
  });
  refs.search = search;

  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter by status" });
  for (const f of FILTERS) {
    const chip = h("button", { type: "button", class: "chip" }, f.label);
    chip.addEventListener("click", () => setFilter(f.id));
    refs.chips.set(f.id, chip);
    chips.append(chip);
  }

  const account = h(
    "select",
    { "aria-label": "Account" },
    h("option", { value: "both" }, "Work | Leaf"),
    h("option", { value: "work" }, "Work"),
    h("option", { value: "leaf" }, "Leaf"),
  );
  account.value = state.account;
  account.addEventListener("change", () => {
    state.account = account.value as AccountFilter;
    savePrefs();
    resetOlderActivity();
    renderAll();
    void refresh(); // the feed's first page is fetched per account
  });
  refs.account = account;

  const tiles = h("section", { class: "tiles", "aria-label": "Counts" });
  for (const t of TILES) {
    const count = h("span", { class: "tile-count" }, "–");
    const button = h(
      "button",
      { type: "button", class: `tile tone-${t.id}`, title: `Show only ${t.label}` },
      h("span", { class: "tile-icon" }, icon(t.icon)),
      h("span", { class: "tile-text" }, h("span", { class: "tile-label" }, t.label), count),
    );
    button.addEventListener("click", () => setFilter(state.filter === t.id ? "all" : t.id));
    refs.tiles.set(t.id, { button, count });
    tiles.append(button);
  }

  refs.fleet = h("main", { class: "card fleet", id: "fleet", "aria-label": "Bots" });
  refs.feed = h("aside", { class: "card feed", "aria-label": "Recent activity" });
  refs.statusLine = h("p", { class: "status-line", role: "status" });
  refs.detailRoot = h("div", { id: "detail-root" });

  const logout = h(
    "form",
    { method: "post", action: "/logout", class: "logout" },
    h("button", { type: "submit", class: "link-btn" }, "Sign out"),
  );

  root.replaceChildren(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "top" },
        h("h1", {}, "Bot Fleet"),
        h(
          "div",
          { class: "top-right" },
          h("label", { class: "account-switch" }, icon("person"), account, icon("chevronDown", "icon chev")),
          logout,
        ),
        h("div", { class: "controls" }, h("label", { class: "search" }, icon("search"), search), chips),
      ),
      tiles,
      h("div", { class: "layout" }, refs.fleet, refs.feed),
      refs.statusLine,
    ),
    refs.detailRoot,
  );
}

function setFilter(filter: StatusFilter): void {
  state.filter = filter;
  savePrefs();
  renderFleet();
}

// Re-renders replace DOM nodes; interactive elements carry a stable data-key so
// keyboard focus survives refreshes, group toggles and closing the drawer.
function activeKey(within?: Element): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || (within && !within.contains(el))) return null;
  return el.dataset.key ?? null;
}

function focusByKey(key: string | null, within: ParentNode = document): boolean {
  if (key === null) return false;
  const el = Array.from(within.querySelectorAll<HTMLElement>("[data-key]")).find((e) => e.dataset.key === key);
  el?.focus({ preventScroll: true });
  return el !== undefined;
}

// ------------------------------------------------------------------ rendering

const DOT_CLASS: Record<DisplayState, string> = {
  waiting_user: "dot amber",
  working: "dot green",
  idle: "dot gray",
  unknown: "dot hollow",
  error: "dot red",
  stale: "dot red stale",
};

function timeEl(at: number | null): HTMLElement {
  if (at === null) return h("span", { class: "when muted" }, "—");
  return h(
    "time",
    { class: "when", datetime: new Date(at).toISOString(), title: formatFull(at) },
    formatRelative(at, now()),
  );
}

function openControl(row: BotRowView, extraClass = ""): HTMLElement {
  if (row.openUrl === null) {
    return h(
      "button",
      {
        type: "button",
        class: `open-btn ${extraClass}`,
        disabled: true,
        title: LEAF_OPEN_NOTE,
        "aria-label": `Open ${row.bot.name} (not available for Leaf bots)`,
      },
      "Open",
    );
  }
  return h(
    "a",
    {
      class: `open-btn ${extraClass}`,
      href: row.openUrl,
      "aria-label": `Open ${row.bot.name} in Grok Bot`,
      "data-key": `${extraClass ? "detail-open" : "open"}:${row.bot.account}/${row.bot.id}`,
    },
    "Open",
    icon("chevronRight", "icon chev-r"),
  );
}

function rowEl(row: BotRowView, showAccountTag: boolean): HTMLElement {
  const { bot } = row;
  const name = h("span", { class: "name" }, h("span", { class: "name-text" }, bot.name));
  if (showAccountTag && bot.account === "leaf") name.append(h("span", { class: "tag leaf" }, "Leaf"));
  if (bot.unread > 0) {
    name.append(
      h("span", {
        class: "unread-dot",
        title: `${bot.unread} message${bot.unread === 1 ? "" : "s"} since your last reply`,
        "aria-label": `${bot.unread} unread`,
        role: "img",
      }),
    );
  }
  const main = h(
    "button",
    {
      type: "button",
      class: `row-main state-${row.state}`,
      "aria-label": `${bot.name}: ${STATE_LABEL[row.state]}. ${row.stepText}. Show details`,
      "data-key": `row:${bot.account}/${bot.id}`,
    },
    h("span", { class: DOT_CLASS[row.state], title: STATE_LABEL[row.state] }),
    name,
    h("span", { class: "step" }, row.stepText),
    timeEl(lastSeenAt(bot)),
  );
  main.addEventListener("click", () => openDetail(bot.account, bot.id, `row:${bot.account}/${bot.id}`));
  return h("li", { class: "row" }, main, openControl(row));
}

function groupEl(key: string, title: string, rows: BotRowView[], options: { needsMe?: boolean; emptyText?: string | null; showAccountTag: boolean }): HTMLElement {
  const collapsed = state.collapsed.has(key);
  const listId = `group-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const toggle = h(
    "button",
    {
      type: "button",
      class: "group-toggle",
      "aria-expanded": String(!collapsed),
      "aria-controls": listId,
      "data-key": `toggle:${key}`,
    },
    h("span", { class: "group-title" }, title),
    options.needsMe ? h("span", { class: "dot amber small", "aria-hidden": "true" }) : null,
    h("span", { class: "group-count" }, String(rows.length)),
    icon(collapsed ? "chevronDown" : "chevronUp", "icon chev"),
  );
  toggle.addEventListener("click", () => {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    savePrefs();
    renderFleet();
  });
  const list = h("ul", { class: "rows", id: listId, hidden: collapsed });
  if (rows.length === 0 && options.emptyText) list.append(h("li", { class: "row-empty" }, options.emptyText));
  for (const row of rows) list.append(rowEl(row, options.showAccountTag));
  return h("section", { class: `group${options.needsMe ? " needs-me" : ""}` }, h("h2", { class: "group-head" }, toggle), list);
}

function renderTiles(counts: Record<Bucket, number> | null): void {
  for (const [id, ref] of refs.tiles) {
    ref.count.textContent = counts ? String(counts[id]) : "–";
    ref.button.setAttribute("aria-pressed", String(state.filter === id));
  }
  for (const [id, chip] of refs.chips) {
    chip.classList.toggle("active", state.filter === id);
    chip.setAttribute("aria-pressed", String(state.filter === id));
  }
}

function renderFleet(): void {
  const fleet = refs.fleet;
  if (!fleet) return;
  if (!state.data) {
    renderTiles(null);
    fleet.replaceChildren(h("p", { class: "empty" }, state.error ?? "Loading…"));
    return;
  }
  const view = buildFleetView(state.data.bots, {
    account: state.account,
    filter: state.filter,
    query: state.query,
    now: now(),
  });
  renderTiles(view.counts);

  const showAccountTag = state.account === "both";
  const sections: HTMLElement[] = [];
  if (view.needsMe && (view.needsMe.length > 0 || state.filter === "needs_me")) {
    sections.push(
      groupEl("needs-me", "Needs me", view.needsMe, {
        needsMe: true,
        emptyText: state.query.trim() === "" ? "Nothing needs you right now." : null,
        showAccountTag,
      }),
    );
  }
  for (const group of view.groups) {
    sections.push(groupEl(`g:${group.name}`, group.name, group.rows, { emptyText: group.emptyText, showAccountTag: false }));
  }
  const needsMeEmptyShown = state.filter === "needs_me" && state.query.trim() === "";
  if (view.shown === 0 && (state.query.trim() !== "" || state.filter !== "all") && !needsMeEmptyShown) {
    sections.push(h("p", { class: "empty" }, "No bots match."));
  }
  const focused = activeKey(fleet);
  fleet.replaceChildren(...sections);
  focusByKey(focused, fleet);
}

function activityItems(): { items: ActivityItem[]; next: number | null } {
  const first = state.data?.activity.items ?? [];
  const lastSeq = first[first.length - 1]?.seq ?? Infinity;
  const older = state.olderActivity.filter((item) => item.seq < lastSeq);
  const next = state.olderLoaded ? state.olderNext : (state.data?.activity.nextBefore ?? null);
  return { items: [...first, ...older], next };
}

function renderFeed(): void {
  const feed = refs.feed;
  if (!feed) return;
  const { items, next } = activityItems();
  const visible = items.filter((item) => accountMatches(item.account, state.account));
  const list = h("ol", { class: "feed-list" });
  if (visible.length === 0) {
    list.append(h("li", { class: "feed-empty" }, state.data ? "No activity yet. Bots add to this feed when they report." : "Loading…"));
  }
  const t = now();
  for (const item of visible) {
    const button = h(
      "button",
      {
        type: "button",
        class: "feed-btn",
        title: `${item.botName} ${activityText(item)}`,
        "data-key": `feed:${item.seq}`,
      },
      h("time", { class: "feed-time", datetime: new Date(item.at).toISOString(), title: formatFull(item.at) }, formatClock(item.at, t)),
      h("span", { class: `dot small ${activityTone(item.kind)}`, "aria-hidden": "true" }),
      h("span", { class: "feed-text" }, h("strong", {}, item.botName), " ", activityText(item)),
    );
    button.addEventListener("click", () => openDetail(item.account, item.botId, `feed:${item.seq}`));
    list.append(h("li", { class: "feed-item" }, button));
  }
  const more =
    next !== null
      ? h(
          "button",
          { type: "button", class: "feed-more", disabled: state.loadingOlder, "data-key": "feed-more" },
          state.loadingOlder ? "Loading…" : "View older activity…",
        )
      : null;
  more?.addEventListener("click", () => void loadOlder(next));
  const parts: HTMLElement[] = [h("h2", { class: "feed-head" }, "Activity"), list];
  if (more) parts.push(more);
  const focused = activeKey(feed);
  const scrollTop = feed.querySelector(".feed-list")?.scrollTop ?? 0;
  feed.replaceChildren(...parts);
  list.scrollTop = scrollTop; // keep the reader's place across refreshes and "View older"
  focusByKey(focused, feed);
}

function renderStatusLine(): void {
  if (!refs.statusLine) return;
  const parts: string[] = [];
  if (state.lastLoadedAt !== null) parts.push(`Updated ${formatClock(state.lastLoadedAt, now())} (Asia/Hebron)`);
  if (state.error && state.data) parts.push(state.error);
  parts.push("Shows only what bots pushed. Never wakes or messages a bot.");
  refs.statusLine.textContent = parts.join(" · ");
}

function renderAll(): void {
  renderFleet();
  renderFeed();
  renderStatusLine();
  renderDetail();
}

// ------------------------------------------------------------------ detail view

function parseHash(): { account: string; id: string } | null {
  const match = /^#bot\/(work|leaf)\/(.+)$/.exec(location.hash);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { account: match[1], id: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function openDetail(account: string, id: string, fromKey: string | null): void {
  const hash = `#bot/${account}/${encodeURIComponent(id)}`;
  if (location.hash !== hash) history.pushState({ detail: true }, "", hash);
  showDetail(account, id, fromKey);
}

function showDetail(account: string, id: string, returnFocusKey: string | null): void {
  const same = state.detail?.account === account && state.detail.id === id;
  if (!same) {
    state.detail = { account, id, data: null, loading: true, error: null, returnFocusKey };
  }
  renderDetail(true);
  void loadDetail();
}

function closeDetail(): void {
  if (!state.detail) return;
  if ((history.state as { detail?: boolean } | null)?.detail) {
    history.back();
    return;
  }
  history.replaceState(null, "", location.pathname + location.search);
  hideDetail();
}

function hideDetail(): void {
  const key = state.detail?.returnFocusKey ?? null;
  state.detail = null;
  renderDetail();
  focusByKey(key);
}

let detailLoadSeq = 0;
async function loadDetail(): Promise<void> {
  const detail = state.detail;
  if (!detail) return;
  const seq = ++detailLoadSeq;
  try {
    const data = await fetchBot(detail.account, detail.id);
    // Drop stale responses: the drawer changed, or a newer load was started.
    if (state.detail !== detail || seq !== detailLoadSeq) return;
    detail.data = data;
    detail.error = data ? null : "This bot is not on the roster.";
  } catch (err) {
    if (err instanceof SignedOutError) return signedOut();
    if (state.detail !== detail || seq !== detailLoadSeq) return;
    detail.error = "Could not load details. Retrying with the next refresh.";
  }
  detail.loading = false;
  renderDetail();
}

function section(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return h("section", { class: "detail-section" }, h("h3", {}, title), ...children);
}

function renderDetail(focus = false): void {
  const root = refs.detailRoot;
  if (!root) return;
  const detail = state.detail;
  document.body.classList.toggle("has-detail", detail !== null);
  if (!detail) {
    root.replaceChildren();
    return;
  }
  const t = now();
  const fromList = state.data?.bots.find((b) => b.account === detail.account && b.id === detail.id) ?? null;
  const bot = detail.data?.bot ?? fromList;
  const row = bot ? toRow(bot, t) : null;

  const close = h(
    "button",
    { type: "button", class: "icon-btn", "aria-label": "Close details", "data-key": "detail-close" },
    icon("close"),
  );
  close.addEventListener("click", closeDetail);

  const body: (HTMLElement | null)[] = [];
  const lastReport = bot ? lastSeenAt(bot) : null;
  if (row && bot) {
    body.push(
      h("p", { class: `detail-state state-${row.state}` }, h("strong", {}, STATE_LABEL[row.state]), " · ", row.stepText),
      h(
        "dl",
        { class: "detail-meta" },
        h("dt", {}, "Last report"),
        h("dd", {}, lastReport === null ? "Never" : `${formatFull(lastReport)} (${formatRelative(lastReport, t)})`),
        h("dt", {}, "Account"),
        h("dd", {}, `${bot.account === "work" ? "Work" : "Leaf"} · ${bot.group}`),
      ),
      row.openUrl
        ? openControl(row, "primary")
        : h("p", { class: "muted small" }, LEAF_OPEN_NOTE),
    );
  }

  if (detail.error && !detail.data) {
    body.push(h("p", { class: "empty" }, detail.error));
  } else if (!detail.data) {
    body.push(h("p", { class: "empty" }, "Loading…"));
  } else {
    const d = detail.data;
    body.push(
      section(
        "What you need to know",
        d.summary
          ? h("p", { class: "summary" }, d.summary)
          : h("p", { class: "empty-inline" }, "This bot hasn't pushed a summary yet."),
        d.bot.summaryAt !== null && d.summary
          ? h("p", { class: "muted small" }, `Updated ${formatFull(d.bot.summaryAt)} (${formatRelative(d.bot.summaryAt, t)})`)
          : null,
      ),
    );
    const messages = h("ol", { class: "messages" });
    for (const m of d.messages) {
      messages.append(
        h(
          "li",
          { class: "message" },
          h("time", { datetime: new Date(m.at).toISOString(), title: formatFull(m.at) }, formatClock(m.at, t)),
          h("p", {}, m.text),
        ),
      );
    }
    const replyNote =
      d.bot.lastAviReplyAt !== null
        ? h("p", { class: "muted small" }, `Your last reply was marked ${formatFull(d.bot.lastAviReplyAt)}.`)
        : null;
    const capped = d.messages.length >= LIMITS.messagesPerBot;
    body.push(
      section(
        d.messages.length === 0
          ? "Messages since your last reply"
          : capped
            ? `Latest ${d.messages.length} messages since your last reply`
            : `Messages since your last reply (${d.messages.length})`,
        capped
          ? h("p", { class: "muted small" }, `Only the newest ${LIMITS.messagesPerBot} are kept. Open the chat for anything older.`)
          : null,
        d.messages.length > 0 ? messages : h("p", { class: "empty-inline" }, "No messages since your last reply."),
        replyNote,
      ),
    );
  }

  const title = bot?.name ?? detail.id;
  const dialog = h(
    "aside",
    { class: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "detail-title", tabindex: "-1" },
    h(
      "header",
      { class: "drawer-head" },
      row ? h("span", { class: DOT_CLASS[row.state] }) : null,
      h("h2", { id: "detail-title" }, title),
      close,
    ),
    h("div", { class: "drawer-body" }, ...body),
  );
  const overlay = h("div", { class: "overlay" });
  overlay.addEventListener("click", closeDetail);

  // Re-rendering on refresh must not steal focus or jump the scroll position.
  const hadFocus = root.contains(document.activeElement);
  const focused = activeKey(root);
  const scrollTop = root.querySelector(".drawer-body")?.scrollTop ?? 0;
  root.replaceChildren(overlay, dialog);
  const newBody = root.querySelector(".drawer-body");
  if (newBody) newBody.scrollTop = scrollTop;
  if (focus) close.focus();
  else if (hadFocus && !focusByKey(focused, dialog)) dialog.focus();
}

/** Keeps Tab inside the open detail dialog. */
function trapFocus(event: KeyboardEvent): void {
  const dialog = refs.detailRoot?.querySelector<HTMLElement>(".drawer");
  if (!dialog) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

// ------------------------------------------------------------------ data loading

function signedOut(): void {
  location.assign("/login");
}

function resetOlderActivity(): void {
  state.olderActivity = [];
  state.olderNext = null;
  state.olderLoaded = false;
  state.olderGen += 1;
}

/**
 * Keeps "View older" pages consistent across refreshes: items that slide off the
 * new first page move into the older list. If more than a page of events arrived
 * since the last refresh, the two no longer touch, so paging restarts instead of
 * leaving a silent gap.
 */
function carryOlderActivity(prev: FleetResponse | null, next: FleetResponse): void {
  // Also while the first "View older" is in flight: its page continues from the
  // previous first page, so that page's tail must be kept too.
  if ((!state.olderLoaded && !state.loadingOlder) || !prev) return;
  const known = [...prev.activity.items, ...state.olderActivity];
  const newest = known.reduce((max, item) => Math.max(max, item.seq), -Infinity);
  const page = next.activity.items;
  const oldestNew = page[page.length - 1]?.seq;
  if (page.length >= LIMITS.activityPageSize && oldestNew !== undefined && oldestNew > newest) {
    resetOlderActivity();
    return;
  }
  const seen = new Set<number>();
  state.olderActivity = known
    .filter((item) => !seen.has(item.seq) && seen.add(item.seq))
    .sort((a, b) => b.seq - a.seq);
}

let refreshing = false;
let refreshAgain = false;
async function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  const account = state.account;
  try {
    const data = await fetchFleet(account);
    if (account === state.account) {
      carryOlderActivity(state.data, data);
      state.clockOffset = data.now - Date.now();
      state.data = data;
      state.error = null;
      state.lastLoadedAt = data.now;
    } else {
      refreshAgain = true; // switched accounts mid-request: fetch again for the new one
    }
  } catch (err) {
    if (err instanceof SignedOutError) return signedOut();
    state.error = state.data ? "Refresh failed; showing the last data." : "Could not load the fleet. Retrying…";
  } finally {
    refreshing = false;
  }
  renderAll();
  if (state.detail) void loadDetail();
  if (refreshAgain) {
    refreshAgain = false;
    void refresh();
  }
}

async function loadOlder(before: number | null): Promise<void> {
  if (before === null || state.loadingOlder) return;
  const account = state.account;
  const gen = state.olderGen;
  state.loadingOlder = true;
  renderFeed();
  try {
    const page = await fetchActivity(before, account);
    // Drop the page if the account changed or paging was reset (a gap opened) meanwhile.
    if (account === state.account && gen === state.olderGen) {
      const seen = new Set<number>();
      state.olderActivity = [...state.olderActivity, ...page.items]
        .filter((item) => !seen.has(item.seq) && seen.add(item.seq))
        .sort((a, b) => b.seq - a.seq);
      state.olderNext = page.nextBefore;
      state.olderLoaded = true;
    }
  } catch (err) {
    if (err instanceof SignedOutError) return signedOut();
  } finally {
    state.loadingOlder = false;
  }
  renderFeed();
}

// ------------------------------------------------------------------ boot

function syncFromHash(): void {
  const target = parseHash();
  if (target) showDetail(target.account, target.id, null);
  else if (state.detail) hideDetail();
}

function boot(): void {
  const root = document.getElementById("app");
  if (!root) return;
  loadPrefs();
  buildLayout(root);
  renderAll();
  void refresh();
  syncFromHash();

  window.addEventListener("popstate", syncFromHash);
  window.addEventListener("hashchange", syncFromHash);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.detail) {
      event.preventDefault();
      closeDetail();
    } else if (event.key === "Tab" && state.detail) {
      trapFocus(event);
    } else if (event.key === "/" && document.activeElement === document.body) {
      event.preventDefault();
      refs.search?.focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, REFRESH_MS);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
