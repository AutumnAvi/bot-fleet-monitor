// Bot Fleet v2. Reads what was pushed to this Worker and renders Focus, Board and Feed.
// The only write is Save for later. Nothing here messages, wakes or polls a bot.

import { fetchActivity, fetchBot, fetchState, setSaved, SignedOutError } from "./api";
import { h } from "./dom";
import {
  accountMatches,
  needsAttention,
  openLabel,
  openUrl,
  toRow,
  activityDetail,
  activityLabel,
  visibleActivity,
  type AccountFilter,
  type BotRowView,
} from "../src/shared/fleet-view";
import {
  ACCOUNT_LABEL,
  GROUP_ORDER,
  LEAF_GROUP,
  LIMITS,
  type Account,
  type ActivityItem,
  type BotDetail,
  type BotView,
  type CodingSession,
  type GrokUsage,
  type SessionHelper,
  type StateResponse,
  type UsageAccount,
  type UsageMeter,
} from "../src/shared/model";
import {
  attentionBadge,
  codingNote,
  displayStatus,
  helperRuntime,
  initials,
  linkSessions,
  orphanLine,
  runLabel,
  sessionBadge,
  sessionBarColor,
  sessionProgress,
  sessionStatusClass,
  sessionStatusLabel,
  sessionSummary,
  sessionTitle,
  sessionsOwnedBy,
} from "../src/shared/sessions";
import { apiRemainingRatio, formatMoney, meterRemaining, primaryMeter, sortUsageAccounts, usageDisplayName, weeklyResetMeter } from "../src/shared/usage";
import { displayState, lastSeenAt, type DisplayState } from "../src/shared/status";
import { formatClock, formatFull, formatHeaderClock, formatReset, formatShortAge, isSameDay } from "../src/shared/time";

const REFRESH_MS = 30_000;
const PREFS_KEY = "botfleet.prefs.v2";
type Tab = "focus" | "board" | "feed";
type FeedFilter = "all" | "needs" | "work" | "leaf";

interface State {
  data: StateResponse | null;
  dataAccount: AccountFilter | null;
  error: string | null;
  clockOffset: number;
  account: AccountFilter;
  tab: Tab;
  feedFilter: FeedFilter;
  /** `${account}:${id}` of the attention item Focus is showing. */
  focusId: string | null;
  detail: BotDetail | null;
  detailKey: string | null;
  collapsed: Set<string>;
  groupInit: Set<string>;
  sessionsOpen: boolean;
  /** Session ids whose helper rows are expanded. */
  helpersOpen: Set<string>;
  /** False until a saved preference exists, so idle groups start collapsed only on a first visit. */
  collapseDefaults: boolean;
  olderActivity: ActivityItem[];
  olderNext: number | null;
  olderLoaded: boolean;
  olderGen: number;
  loadingOlder: boolean;
  grokOpen: Account | null;
}

const state: State = {
  data: null,
  dataAccount: null,
  error: null,
  clockOffset: 0,
  account: "both",
  tab: "focus",
  feedFilter: "all",
  focusId: null,
  detail: null,
  detailKey: null,
  collapsed: new Set(),
  groupInit: new Set(),
  sessionsOpen: false,
  helpersOpen: new Set(),
  collapseDefaults: true,
  olderActivity: [],
  olderNext: null,
  olderLoaded: false,
  olderGen: 0,
  loadingOlder: false,
  grokOpen: null,
};

const now = (): number => Date.now() + state.clockOffset;
const app = (): HTMLElement | null => document.getElementById("app");

function loadPrefs(): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    state.collapseDefaults = false;
    const prefs = JSON.parse(raw) as { account?: string; tab?: string; collapsed?: unknown; sessionsOpen?: boolean };
    if (prefs.account === "both" || prefs.account === "work" || prefs.account === "leaf") state.account = prefs.account;
    if (prefs.tab === "focus" || prefs.tab === "board" || prefs.tab === "feed") state.tab = prefs.tab;
    if (Array.isArray(prefs.collapsed)) {
      state.collapsed = new Set(prefs.collapsed.filter((item): item is string => typeof item === "string"));
      state.groupInit = new Set(state.collapsed);
    }
    if (prefs.sessionsOpen === true) state.sessionsOpen = true;
  } catch {
    // Preferences are a convenience.
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        account: state.account,
        tab: state.tab,
        collapsed: [...state.collapsed],
        sessionsOpen: state.sessionsOpen,
      }),
    );
  } catch {
    // Ignore.
  }
}

function tabFromHash(): Tab | null {
  const hash = location.hash.replace(/^#/, "");
  if (hash === "focus" || hash === "board" || hash === "feed") return hash;
  return null;
}

function signedOut(): void {
  location.assign("/login");
}

function resetOlder(): void {
  state.olderActivity = [];
  state.olderNext = null;
  state.olderLoaded = false;
  state.olderGen += 1;
}

function carryOlder(prev: StateResponse | null, next: StateResponse, account: AccountFilter): void {
  if ((!state.olderLoaded && !state.loadingOlder) || !prev || state.dataAccount !== account) return;
  const known = [...prev.activity.items, ...state.olderActivity];
  const newest = known.reduce((max, item) => Math.max(max, item.seq), -Infinity);
  const page = next.activity.items;
  const oldestNew = page[page.length - 1]?.seq;
  if (page.length >= LIMITS.activityPageSize && oldestNew !== undefined && oldestNew > newest) {
    resetOlder();
    return;
  }
  const seen = new Set<number>();
  state.olderActivity = known.filter((item) => !seen.has(item.seq) && seen.add(item.seq)).sort((a, b) => b.seq - a.seq);
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
    const data = await fetchState(account);
    if (account === state.account) {
      carryOlder(state.data, data, account);
      state.clockOffset = data.now - Date.now();
      state.data = data;
      state.dataAccount = account;
      state.error = null;
    } else {
      refreshAgain = true;
    }
  } catch (err) {
    if (err instanceof SignedOutError) return signedOut();
    state.error = state.data ? "Refresh failed. Showing the last data." : "Could not load Bot Fleet. Retrying…";
  } finally {
    refreshing = false;
  }
  render();
  void loadDetail(true);
  if (refreshAgain) {
    refreshAgain = false;
    void refresh();
  }
}

async function loadDetail(force = false): Promise<void> {
  const current = focused();
  if (!current) {
    state.detail = null;
    state.detailKey = null;
    return;
  }
  const key = `${current.bot.account}:${current.bot.id}`;
  if (!force && state.detailKey === key && state.detail) return;
  state.detailKey = key;
  try {
    const detail = await fetchBot(current.bot.account, current.bot.id);
    if (state.detailKey === key) {
      state.detail = detail;
      render();
    }
  } catch (err) {
    if (err instanceof SignedOutError) signedOut();
  }
}

async function save(bot: BotView, saved: boolean): Promise<void> {
  try {
    await setSaved(bot.account, bot.id, saved);
    if (saved && state.focusId === `${bot.account}:${bot.id}`) state.focusId = null;
    await refresh();
  } catch (err) {
    if (err instanceof SignedOutError) signedOut();
    else {
      state.error = "Couldn't update Save for later.";
      render();
    }
  }
}

function visibleBots(): BotRowView[] {
  const data = state.data;
  if (!data) return [];
  return data.bots.filter((bot) => accountMatches(bot.account, state.account)).map((bot) => toRow(bot, now()));
}

function byRecent(a: BotRowView, b: BotRowView): number {
  return (b.bot.statusAt ?? 0) - (a.bot.statusAt ?? 0) || a.bot.name.localeCompare(b.bot.name, "en");
}

function attention(): BotRowView[] {
  return visibleBots()
    .filter((row) => row.bot.savedAt === null && needsAttention(row.bucket))
    .sort(byRecent);
}

function savedRows(): BotRowView[] {
  return visibleBots()
    .filter((row) => row.bot.savedAt !== null)
    .sort((a, b) => (b.bot.savedAt ?? 0) - (a.bot.savedAt ?? 0));
}

function rowKey(row: BotRowView): string {
  return `${row.bot.account}:${row.bot.id}`;
}

function focused(): BotRowView | null {
  const queue = attention();
  if (queue.length === 0) return null;
  return queue.find((row) => rowKey(row) === state.focusId) ?? queue[0] ?? null;
}

function advance(delta: number): void {
  const queue = attention();
  if (queue.length < 2) return;
  const current = focused();
  const index = Math.max(0, current ? queue.findIndex((row) => rowKey(row) === rowKey(current)) : 0);
  const next = queue[(index + delta + queue.length) % queue.length];
  if (!next) return;
  state.focusId = rowKey(next);
  state.detail = null;
  state.detailKey = null;
  render();
  void loadDetail();
}

function jumpTo(bot: BotView): void {
  state.tab = "focus";
  state.focusId = `${bot.account}:${bot.id}`;
  history.replaceState(null, "", "#focus");
  state.detail = null;
  state.detailKey = null;
  savePrefs();
  render();
  void loadDetail();
}

function accountTag(account: Account): HTMLElement {
  return h("span", { class: `acc ${account === "work" ? "a-w" : "a-a"}` }, ACCOUNT_LABEL[account]);
}

function dot(color: string): HTMLElement {
  return h("span", { class: "dot", style: `background:${color}` });
}

function stateColor(display: DisplayState): string {
  switch (display) {
    case "waiting_user":
      return "var(--amber)";
    case "working":
      return "var(--blue)";
    case "error":
      return "var(--red)";
    case "stale":
      return "#f0a3a5";
    case "idle":
    case "unknown":
      return "var(--gray)";
  }
}

function attentionLabel(display: DisplayState): { text: string; tag: string } {
  switch (display) {
    case "error":
      return { text: "STUCK", tag: "t-red" };
    case "stale":
      return { text: "STALE", tag: "t-gray" };
    default:
      return { text: "NEEDS ME", tag: "t-amb" };
  }
}

function tone(display: DisplayState): string {
  if (display === "error") return "tone-error";
  if (display === "stale") return "tone-stale";
  return "tone-wait";
}

function age(bot: BotView): string {
  const at = lastSeenAt(bot);
  return at === null ? "" : formatShortAge(at, now());
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function prLabel(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match?.[1] ? `PR #${match[1]}` : "Pull request";
}

function prFor(bot: BotView): string | null {
  const data = state.data;
  if (!data) return null;
  for (const session of sessionsOwnedBy(data.sessions, bot.account, bot.id)) {
    const url = httpsUrl(session.prUrl);
    if (url) return url;
  }
  return null;
}

function openLink(bot: BotView, primary = false): HTMLAnchorElement {
  return h("a", { class: primary ? "btn p" : "btn", href: openUrl(bot) }, openLabel(bot.account));
}

function laterButton(bot: BotView, label = "Save for later"): HTMLButtonElement {
  return h("button", { type: "button", class: "btn", onclick: () => void save(bot, true) }, `🔖 ${label}`);
}

function groupName(group: string): string {
  return group === LEAF_GROUP ? "Admin bots" : group;
}

function remainingColor(left: number | null, group: UsageAccount["group"]): string {
  if (left === null) return group === "api" ? "var(--purple)" : "var(--green)";
  if (group === "api") return left < 25 ? "var(--red)" : "var(--purple)";
  if (group === "cursor") return left < 20 ? "var(--red)" : "var(--blue)";
  if (left < 25) return "var(--red)";
  if (left < 40) return "var(--amber)";
  return "var(--green)";
}

function remainingLevel(left: number | null): "" | "warn" | "bad" {
  if (left === null) return "";
  if (left < 25) return "bad";
  if (left < 40) return "warn";
  return "";
}

function meterCaption(meter: UsageMeter): string {
  if (meter.state === "no_limit") return `${meter.label} no limit`;
  if (meter.pctUsed === null) return meter.label;
  return `${meter.label} ${Math.round(meter.pctUsed)}% used`;
}

function usageCell(account: UsageAccount): HTMLElement {
  const clock = now();
  const primary = primaryMeter(account);
  const apiRatio = account.group === "api" ? apiRemainingRatio(account) : null;
  const left = apiRatio ?? (primary ? meterRemaining(primary) : null);
  const noLimit = primary?.state === "no_limit" && apiRatio === null;
  const spend = formatMoney(account.spend);
  const remaining = formatMoney(account.remaining);
  const granted = formatMoney(account.granted);
  const weekly = weeklyResetMeter(account, clock);
  const resetAt = weekly?.resetAt ?? (account.group === "api" ? account.expiresAt : primary?.resetAt) ?? null;
  const big = noLimit ? "No limit" : left !== null ? `${Math.round(left)}%` : (remaining ?? spend ?? "–");
  const small = noLimit ? "5h" : left !== null ? "left" : null;
  const extra = account.meters
    .filter((meter) => meter !== primary)
    .map((meter) => {
      const reset = meter.resetAt !== null && !(isWeekly(meter) && weekly === null) ? formatReset(meter.resetAt, clock) : "";
      return reset && !isWeekly(meter) ? `${meterCaption(meter)} · ${reset}` : meterCaption(meter);
    });
  if (weekly) extra.push(`resets ${formatReset(weekly.resetAt ?? clock, clock)}`);
  if (account.group === "api" && remaining && granted) extra.unshift(`${remaining} / ${granted}`);
  else if (spend && big !== spend) extra.unshift(spend);
  if (account.expiresAt !== null && account.group === "api") extra.push(`expires ${formatReset(account.expiresAt, clock)}`);
  if (account.routingVerified === false) extra.push("unverified");
  if (account.note) extra.push(account.note);
  return h(
    "div",
    { class: `u${account.group === "api" ? " api" : ""}` },
    h("div", { class: "n" }, usageDisplayName(account), resetAt !== null ? h("em", {}, formatReset(resetAt, clock)) : null),
    h("div", { class: `v ${remainingLevel(left)}` }, big, small ? h("small", {}, ` ${small}`) : null),
    h("div", { class: "b" }, h("i", { style: `width:${left ?? (noLimit ? 100 : 0)}%;background:${remainingColor(left, account.group)}` })),
    extra.length ? h("div", { class: "sub" }, extra.join(" · ")) : null,
  );
}

function isWeekly(meter: UsageMeter): boolean {
  return /week/i.test(`${meter.id} ${meter.label}`);
}

function grokCell(account: Account, usage: GrokUsage | undefined): HTMLElement {
  const label = `Grok · ${ACCOUNT_LABEL[account]}`;
  const open = state.grokOpen === account;
  const reset = typeof usage?.resetAt === "number" ? formatReset(usage.resetAt, now()) : "";
  const cell = h(
    "div",
    {
      class: `u g${account === "work" ? " gw" : ""}${open ? " open" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-expanded": open ? "true" : "false",
      "aria-label": `${label} usage by bot`,
    },
    h("div", { class: "n" }, `⚡ ${label}`),
    h(
      "div",
      { class: "v" },
      usage ? `${Math.round(usage.pctUsed)}%` : "–",
      h("small", {}, usage ? ` used${reset ? ` · resets ${reset}` : ""}` : " no report yet"),
    ),
    h("div", { class: "b" }, h("i", { style: `width:${usage ? Math.max(0, Math.min(100, usage.pctUsed)) : 0}%` })),
    grokPopover(account, usage),
  );
  const toggle = (): void => {
    state.grokOpen = state.grokOpen === account ? null : account;
    render();
  };
  cell.addEventListener("click", (event) => {
    if ((event.target as HTMLElement | null)?.closest(".gpop")) return;
    toggle();
  });
  cell.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
  return cell;
}

function grokPopover(account: Account, usage: GrokUsage | undefined): HTMLElement {
  const bots = usage?.bots ?? [];
  const top = bots.slice(0, 8);
  const rest = bots.slice(8);
  const restShare = rest.reduce((sum, bot) => sum + bot.share, 0);
  const max = Math.max(1, ...bots.map((bot) => bot.share));
  const rows = top.map((bot, index) => {
    const routines = bot.routinesShare !== null && bot.share > 0 && bot.routinesShare >= bot.share / 2;
    return h(
      "div",
      { class: "grow" },
      h("span", {}, String(index + 1)),
      h("span", {}, bot.name),
      h("span", { class: "gbar" }, h("i", { style: `width:${Math.round((bot.share / max) * 100)}%;background:${routines ? "#a5b4fc" : "#0ea5e9"}` })),
      h("b", {}, `${Math.round(bot.share)}%`),
    );
  });
  if (rest.length > 0) {
    rows.push(
      h(
        "div",
        { class: "grow" },
        h("span", {}, ""),
        h("span", {}, `${rest.length} others`),
        h("span", { class: "gbar" }, h("i", { style: `width:${Math.round((restShare / max) * 100)}%;background:#e6e8ec` })),
        h("b", {}, `${Math.round(restShare)}%`),
      ),
    );
  }
  const reset = typeof usage?.resetAt === "number" ? formatFull(usage.resetAt) : "no reset time";
  return h(
    "div",
    { class: "gpop", role: "dialog" },
    h(
      "div",
      { class: "gh" },
      h("b", {}, `⚡ Grok Bot · ${ACCOUNT_LABEL[account]}`),
      h("span", {}, usage ? `${Math.round(usage.pctUsed)}% used · ${reset}` : "No report yet"),
    ),
    h("div", { class: "gs" }, "Share of this account's usage this week, by bot"),
    ...rows,
    rows.length === 0 ? h("div", { class: "gs" }, "No per-bot breakdown was pushed.") : null,
    h(
      "div",
      { class: "gl" },
      h("span", {}, "chats & tasks"),
      h("span", {}, "mostly routines"),
    ),
  );
}

function sessionBlock(): HTMLElement {
  const data = state.data;
  const sessions = data?.sessions ?? [];
  const bots = data?.bots ?? [];
  const { linked, orphans } = linkSessions(sessions, bots);
  const shown = linked.slice(0, 8);
  const extra = linked.length - shown.length;
  const orphan = orphanLine(orphans);
  const rows = shown.flatMap(({ session, bot }) => sessionRows(session, bot));
  const head = h(
    "h4",
    {},
    h("button", { type: "button", class: "grp-h", onclick: () => { state.sessionsOpen = !state.sessionsOpen; savePrefs(); render(); } },
      "⌨ Coding sessions ",
      h("span", { class: "csum" }, sessionSummary(sessions)),
      h("span", { class: "r" }, "started by bots · FYI only"),
      h("span", { class: "chev" }, state.sessionsOpen ? "▾" : "▸"),
    ),
  );
  const note = h("div", { class: "orph" }, [
    extra > 0 ? `+${extra} more` : "",
    extra > 0 && orphan ? " · " : "",
    orphan ?? "",
    sessions.length === 0 ? "No coding sessions reported." : "",
  ].join(""));
  return h("div", { class: `cs${state.sessionsOpen ? "" : " closed"}` }, head, ...rows, note);
}

function sessionRows(session: CodingSession, bot: BotView | null): HTMLElement[] {
  const status = displayStatus(session);
  const open = state.helpersOpen.has(session.id);
  const badge = sessionBadge(session);
  const fyi = attentionBadge(session.attentionReason);
  const owner = bot
    ? h(
        "button",
        {
          type: "button",
          class: "owner-link",
          title: openLabel(bot.account),
          onclick: () => {
            const queued = attention().some((row) => row.bot.id === bot.id && row.bot.account === bot.account);
            if (queued) jumpTo(bot);
            else location.assign(openUrl(bot));
          },
        },
        bot.name,
      )
    : h("em", {}, session.ownerName ?? "Unassigned");
  const main = h(
    "div",
    { class: "cr" },
    h(
      "div",
      { class: "l1" },
      h("span", { class: `tool ${badge.className}` }, badge.label),
      h("b", {}, sessionTitle(session)),
      fyi ? h("span", { class: "tag t-gray" }, fyi) : null,
      h("span", { class: `st ${sessionStatusClass(status)}` }, sessionStatusLabel(status)),
    ),
    h(
      "div",
      { class: "l2" },
      bot ? "started by " : "",
      owner,
      ...sessionMeta(session, status),
      session.helpers.length
        ? h(
            "button",
            {
              type: "button",
              class: "owner-link",
              "aria-expanded": open ? "true" : "false",
              onclick: () => {
                if (state.helpersOpen.has(session.id)) state.helpersOpen.delete(session.id);
                else state.helpersOpen.add(session.id);
                render();
              },
            },
            open ? "Hide helpers" : `${session.helpers.length} helpers`,
          )
        : null,
    ),
  );
  const helpers = open ? session.helpers.map((helper) => helperRow(helper)) : [];
  return [main, ...helpers];
}

function sessionMeta(session: CodingSession, status: ReturnType<typeof displayStatus>): HTMLElement[] {
  const progress = sessionProgress(session);
  const bits: HTMLElement[] = [];
  if (progress !== null) {
    bits.push(h("span", { class: "pb" }, h("i", { style: `width:${progress}%;background:${sessionBarColor(status)}` })));
  }
  if (progress !== null && session.step !== null && session.steps !== null) bits.push(h("span", {}, `${session.step}/${session.steps}`));
  if (status === "paused_limit" && session.limitReset !== null) {
    bits.push(h("span", { class: "rt" }, `↻ ${formatClock(session.limitReset, now())}`));
  } else {
    bits.push(h("span", { class: "rt" }, runLabel(session, now())));
  }
  if (session.ci) bits.push(h("span", {}, session.ci.state));
  return bits;
}

function helperRow(helper: SessionHelper): HTMLElement {
  const progress = helper.step !== null && helper.steps !== null && helper.steps > 0 ? Math.round((helper.step / helper.steps) * 100) : null;
  return h(
    "div",
    { class: "cr hrow" },
    h(
      "div",
      { class: "l1" },
      h("b", {}, helper.name),
      h("span", { class: `st ${sessionStatusClass(helper.status)}` }, sessionStatusLabel(helper.status)),
    ),
    h(
      "div",
      { class: "l2" },
      progress === null ? null : h("span", {}, `${helper.step}/${helper.steps}`),
      h("span", { class: "rt" }, helperRuntime(helper.runtimeSec)),
    ),
  );
}

function sessionPlaces(...classes: string[]): HTMLElement[] {
  return classes.map((name) => h("div", { class: name }, sessionBlock()));
}

function usageBar(): HTMLElement {
  const data = state.data;
  const accounts = sortUsageAccounts(data?.accounts ?? []);
  const grok = new Map((data?.grok ?? []).map((item) => [item.account, item]));
  return h(
    "div",
    { class: "us" },
    ...accounts.map(usageCell),
    grokCell("work", grok.get("work")),
    grokCell("leaf", grok.get("leaf")),
  );
}

function header(): HTMLElement {
  const tab = state.tab;
  const title = tab === "focus" ? "Focus" : tab === "board" ? "Board" : "Feed";
  const tabs = (["focus", "board", "feed"] as const).map((id) =>
    h(
      "button",
      {
        type: "button",
        class: id === tab ? "on" : "",
        "aria-pressed": id === tab ? "true" : "false",
        onclick: () => {
          state.tab = id;
          history.replaceState(null, "", `#${id}`);
          savePrefs();
          render();
        },
      },
      id === "focus" ? "Focus" : id === "board" ? "Board" : "Feed",
    ),
  );
  const accounts: { id: AccountFilter; label: string }[] = [
    { id: "both", label: "All" },
    { id: "work", label: ACCOUNT_LABEL.work },
    { id: "leaf", label: ACCOUNT_LABEL.leaf },
  ];
  const select = h(
    "select",
    {
      class: "acct-mini",
      "aria-label": "Account",
      onchange: (event: Event) => {
        state.account = (event.target as HTMLSelectElement).value as AccountFilter;
        resetOlder();
        savePrefs();
        void refresh();
      },
    },
    ...accounts.map((item) => h("option", { value: item.id }, item.label)),
  );
  select.value = state.account;
  return h(
    "header",
    { class: "top" },
    h("h1", {}, "Fleet ", h("span", {}, `· ${title}`)),
    h("nav", { class: "mode", "aria-label": "View" }, ...tabs),
    h(
      "div",
      { class: "r" },
      h(
        "span",
        { class: "acct", role: "group", "aria-label": "Account" },
        ...accounts.map((item) =>
          h(
            "button",
            {
              type: "button",
              class: state.account === item.id ? "on" : "",
              "aria-pressed": state.account === item.id ? "true" : "false",
              onclick: () => {
                state.account = item.id;
                resetOlder();
                savePrefs();
                void refresh();
              },
            },
            item.label,
          ),
        ),
      ),
      select,
      h("span", { class: "clock" }, formatHeaderClock(now())),
      h("form", { method: "post", action: "/logout", class: "signout" }, h("button", { type: "submit" }, "Sign out")),
    ),
  );
}

function queueItem(row: BotRowView, index: number | string, onClick: () => void): HTMLButtonElement {
  const label = attentionLabel(row.state);
  return h(
    "button",
    { type: "button", class: "qi", onclick: onClick },
    h("span", { class: "n" }, String(index)),
    h("b", {}, row.bot.name),
    h("p", {}, row.stepText),
    accountTag(row.bot.account),
    h("span", { class: `tag ${label.tag}` }, label.text),
    h("span", { class: "t" }, age(row.bot)),
  );
}

function focusView(): HTMLElement {
  const queue = attention();
  const current = focused();
  const index = current ? queue.findIndex((row) => rowKey(row) === rowKey(current)) : -1;
  const next: BotRowView | null = queue.length > 1 ? (queue[(index + 1) % queue.length] ?? null) : null;
  const dots = h(
    "div",
    { class: "dots", "aria-hidden": "true" },
    ...queue.map((row, i) => h("i", { class: i === index ? "on" : row.state === "error" || row.state === "stale" ? "s" : "a" })),
  );
  const card = current ? focusCard(current, next) : h(
    "div",
    { class: "fc empty" },
    h("h3", {}, "Nothing needs you"),
    h("p", {}, "Stuck, waiting and stale bots land here. Coding sessions stay in their own list and never join this queue."),
  );
  const upNext = queue.filter((_, i) => i !== index);
  const saved = savedRows();
  return h(
    "main",
    { class: "focus" },
    h(
      "section",
      { class: "f-main" },
      h(
        "div",
        { class: "fh" },
        h("h2", {}, "One thing at a time"),
        dots,
        h("span", { class: "r" }, queue.length === 0 ? "Nothing queued" : `${index + 1} of ${queue.length} need you · press N for next`),
      ),
      card,
    ),
    h(
      "section",
      { class: "f-queue" },
      h("div", { class: "q" }, h("div", { class: "lab" }, "Up next"), ...(upNext.length ? upNext.map((row, i) => queueItem(row, index + i + 2, () => jumpTo(row.bot))) : [h("p", { class: "empty" }, "Nothing else is waiting.")])),
      saved.length
        ? h(
            "div",
            { class: "q" },
            h("div", { class: "lab" }, `Saved for later · ${saved.length}`),
            ...saved.map((row) =>
              h(
                "div",
                { class: "qi sv" },
                h("span", { class: "n" }, "🔖"),
                h("b", {}, row.bot.name),
                h("p", {}, row.stepText),
                accountTag(row.bot.account),
                h("span", { class: "tag t-pur" }, "Saved"),
                h("button", { type: "button", class: "t back", onclick: () => void save(row.bot, false) }, "Move back"),
              ),
            ),
          )
        : null,
      ...sessionPlaces("wcode"),
    ),
    h(
      "section",
      { class: "f-board" },
      h(
        "div",
        { class: "bh" },
        h("h2", {}, "Everything else, by account"),
        h("span", { class: "r" }, `${visibleBots().length} bots · ${state.data?.sessions.length ?? 0} coding sessions`),
      ),
      h("div", { class: "groups" }, ...accountGroups()),
      ...sessionPlaces("scode", "tcode"),
    ),
  );
}

function focusCard(row: BotRowView, next: BotRowView | null): HTMLElement {
  const bot = row.bot;
  const label = attentionLabel(row.state);
  const detail = state.detailKey === `${bot.account}:${bot.id}` ? state.detail : null;
  const summary = detail?.summary ?? null;
  const messages = [...(detail?.messages ?? [])].reverse();
  const owned = sessionsOwnedBy(state.data?.sessions ?? [], bot.account, bot.id);
  const session = owned[0];
  const pr = prFor(bot);
  const when = bot.statusAt ? `${formatClock(bot.statusAt, now())} (Hebron)` : "no report yet";
  return h(
    "div",
    { class: "fc" },
    h(
      "div",
      { class: `band ${tone(row.state)}` },
      h("div", { class: "ico" }, initials(bot.name)),
      h("div", {}, h("h3", {}, bot.name), h("p", {}, accountTag(bot.account), ` ${groupName(bot.group)} · since ${when}`)),
      h("span", { class: "st" }, label.text),
    ),
    h(
      "div",
      { class: "fb" },
      h(
        "div",
        {},
        h("div", { class: "lab" }, "What you need to know"),
        h("div", { class: "know" }, summary ?? "This bot hasn't pushed a need-to-know summary."),
        session ? focusSession(session) : null,
      ),
      h(
        "div",
        {},
        h("div", { class: "lab" }, `Messages since your last reply · ${messages.length}`),
        ...(messages.length
          ? messages.map((message, i) =>
              h(
                "div",
                { class: i === 0 ? "msg" : "msg old" },
                h("small", {}, `${formatClock(message.at, now())} (Hebron)`),
                h("p", {}, message.text),
              ),
            )
          : [h("p", { class: "lastr" }, "No messages since your last reply.")]),
        bot.lastAviReplyAt ? h("div", { class: "lastr" }, `Your last reply · ${formatFull(bot.lastAviReplyAt)}`) : null,
      ),
    ),
    h(
      "div",
      { class: "acts" },
      openLink(bot, true),
      pr ? h("a", { class: "btn", href: pr, target: "_blank", rel: "noopener noreferrer" }, prLabel(pr)) : null,
      laterButton(bot, "Save for later"),
      h("span", { class: "sp" }),
      h("button", { type: "button", class: "btn skip", disabled: next ? undefined : "true", onclick: () => advance(1) }, "Skip"),
      h(
        "button",
        { type: "button", class: "btn p", disabled: next ? undefined : "true", onclick: () => advance(1) },
        next ? `Next: ${next.bot.name} ›` : "Next",
      ),
    ),
  );
}

function focusSession(session: CodingSession): HTMLElement {
  const status = displayStatus(session);
  const progress = sessionProgress(session);
  const pr = httpsUrl(session.prUrl);
  const badge = sessionBadge(session);
  const ciUrl = session.ci ? httpsUrl(session.ci.url) : null;
  return h(
    "div",
    { class: "ses" },
    h(
      "div",
      { class: "a" },
      h("span", { class: `tool ${badge.className}` }, badge.label),
      `Coding session it started · ${session.title}`,
      h("span", { class: `tag ${status === "failed" || status === "aborted" ? "t-red" : status === "finished" ? "t-green" : "t-blue"}` }, sessionStatusLabel(status)),
    ),
    progress === null ? null : h("div", { class: "pb" }, h("i", { style: `width:${progress}%;background:${sessionBarColor(status)}` })),
    h(
      "div",
      { class: "m" },
      h("span", {}, `${runLabel(session, now())} run`),
      pr ? h("a", { href: pr, target: "_blank", rel: "noopener noreferrer" }, prLabel(pr)) : null,
      session.ci ? (ciUrl ? h("a", { href: ciUrl, target: "_blank", rel: "noopener noreferrer" }, session.ci.state) : h("span", {}, session.ci.state)) : null,
      session.repo ? h("span", {}, session.branch ? `${session.repo} · ${session.branch}` : session.repo) : null,
      session.model ? h("span", {}, session.effort ? `${session.model} · ${session.effort}` : session.model) : null,
      session.helpers.length ? h("span", {}, `${session.helpers.length} helpers`) : null,
    ),
  );
}

function accountGroups(): HTMLElement[] {
  const accounts: Account[] = state.account === "leaf" ? ["leaf"] : state.account === "work" ? ["work"] : ["work", "leaf"];
  const blocks: HTMLElement[] = [];
  for (const account of accounts) {
    const rows = visibleBots().filter((row) => row.bot.account === account);
    const need = rows.filter((row) => row.bot.savedAt === null && needsAttention(row.bucket)).length;
    blocks.push(
      h(
        "div",
        { class: "acch" },
        accountTag(account),
        h("span", {}, `${rows.length} bots`),
        h("span", { class: "r" }, need === 0 ? "none need you" : `${need} need you`),
      ),
    );
    if (rows.length === 0) {
      blocks.push(h("p", { class: "empty" }, account === "leaf" ? "No Admin bots yet. They appear after their first report." : "No bots in Avi's Work."));
      continue;
    }
    const names = GROUP_ORDER.filter((name) => (account === "leaf" ? name === LEAF_GROUP : name !== LEAF_GROUP));
    for (const name of names) {
      const inGroup = rows.filter((row) => row.bot.group === name);
      if (inGroup.length === 0 && name === "Unassigned") continue;
      if (inGroup.length === 0) continue;
      blocks.push(groupBlock(account, name, inGroup));
    }
  }
  return blocks;
}

function groupBlock(account: Account, name: string, rows: BotRowView[]): HTMLElement {
  const key = `${account}:${name}`;
  const working = rows.filter((row) => row.bucket === "working" && row.bot.savedAt === null);
  if (!state.groupInit.has(key)) {
    state.groupInit.add(key);
    if (state.collapseDefaults && working.length === 0) state.collapsed.add(key);
  }
  const closed = state.collapsed.has(key);
  const lights = rows.slice(0, 8).map((row) => h("i", { style: `background:${stateColor(row.state)}` }));
  const idleBits = rows
    .filter((row) => row.bucket !== "working" || row.bot.savedAt !== null)
    .slice(0, 12)
    .map((row) => {
      const mark = row.bot.savedAt !== null ? " · saved" : needsAttention(row.bucket) && row.bot.savedAt === null ? " ↑" : "";
      return h("span", {}, `${row.bot.name}${mark}`);
    });
  const head = h(
    "h4",
    {},
    h(
      "button",
      {
        type: "button",
        class: "grp-h",
        "aria-expanded": closed ? "false" : "true",
        onclick: () => {
          if (state.collapsed.has(key)) state.collapsed.delete(key);
          else state.collapsed.add(key);
          savePrefs();
          render();
        },
      },
      groupName(name),
      h("span", { class: "c" }, String(rows.length)),
      h("span", { class: "sum" }, ` · ${working.length} working`),
      h("span", { class: "lights" }, ...lights),
      h("span", { class: "chev" }, closed ? "▸" : "▾"),
    ),
  );
  return h(
    "div",
    { class: `grp${closed ? " closed closed-t" : ""}` },
    head,
    ...working.map((row) => botLine(row)),
    idleBits.length ? h("div", { class: "idle" }, ...idleBits) : null,
  );
}

function botLine(row: BotRowView): HTMLElement {
  const note = codingNote(sessionsOwnedBy(state.data?.sessions ?? [], row.bot.account, row.bot.id));
  return h(
    "div",
    { class: "br" },
    dot(stateColor(row.state)),
    h("b", {}, row.bot.name),
    h("p", {}, note ? `${row.stepText} · ${note}` : row.stepText),
    h("span", { class: "chip" }, age(row.bot)),
  );
}

function boardView(): HTMLElement {
  const rows = visibleBots();
  const need = attention();
  const working = rows.filter((row) => row.bucket === "working" && row.bot.savedAt === null).sort(byRecent);
  const saved = savedRows();
  const idle = rows.filter((row) => (row.bucket === "idle" || row.state === "unknown") && row.bot.savedAt === null);
  return h(
    "main",
    { class: "board" },
    column("need wide2", "var(--red)", "Needs me", need.length, "by account", boardCards(need, "need")),
    column("work wide2", "var(--blue)", "Working", working.length, "by account", boardCards(working, "work")),
    h(
      "div",
      { class: "col save" },
      colHead("var(--purple)", "Saved for later", saved.length, ""),
      ...saved.map((row) => boardCard(row, "save")),
      saved.length === 0 ? h("p", { class: "empty" }, "Nothing saved.") : null,
      ...sessionPlaces("bcode"),
    ),
    h(
      "div",
      { class: "col idlec" },
      colHead("var(--gray)", "Idle & done", idle.length, ""),
      h("div", { class: "unc" }, ...idle.map((row) => h("div", { class: "mini" }, dot(stateColor(row.state)), row.bot.name, h("span", { class: "t" }, age(row.bot) || "–")))),
      h("div", { class: "unl" }, `${idle.length} idle`),
    ),
    ...sessionPlaces("tcode"),
  );
}

function column(className: string, color: string, title: string, count: number, aside: string, body: HTMLElement): HTMLElement {
  return h("div", { class: `col ${className}` }, colHead(color, title, count, aside), body);
}

function colHead(color: string, title: string, count: number, aside: string): HTMLElement {
  return h(
    "h3",
    {},
    h("span", { class: "d", style: `background:${color}` }),
    title,
    h("span", { class: "c" }, String(count)),
    aside ? h("span", { class: "r" }, aside) : null,
  );
}

function boardCards(rows: BotRowView[], kind: "need" | "work"): HTMLElement {
  const accounts: Account[] = [];
  for (const row of rows) if (!accounts.includes(row.bot.account)) accounts.push(row.bot.account);
  const children: HTMLElement[] = [];
  for (const account of accounts) {
    children.push(h("div", { class: "pg" }, accountTag(account)));
    for (const row of rows.filter((item) => item.bot.account === account)) children.push(boardCard(row, kind));
  }
  if (children.length === 0) children.push(h("p", { class: "empty" }, kind === "need" ? "Nobody needs you." : "Nobody is working."));
  return h("div", { class: "cards" }, ...children);
}

function boardCard(row: BotRowView, kind: "need" | "work" | "save"): HTMLElement {
  const label = kind === "save" ? { text: "SAVED", tag: "t-pur" } : attentionLabel(row.state);
  const note = codingNote(sessionsOwnedBy(state.data?.sessions ?? [], row.bot.account, row.bot.id));
  const pr = prFor(row.bot);
  const border = kind === "save" ? "var(--purple)" : stateColor(row.state);
  return h(
    "div",
    { class: "card", style: `--x:${border}` },
    h("div", { class: "proj" }, groupName(row.bot.group), accountTag(row.bot.account)),
    h(
      "div",
      { class: "h" },
      h("b", {}, row.bot.name),
      kind === "work" ? null : h("span", { class: `tag ${label.tag}` }, label.text),
      h("span", { class: "t" }, age(row.bot)),
    ),
    h("p", {}, row.stepText),
    note && kind === "work" ? h("div", { class: "cn" }, note) : null,
    kind === "work"
      ? null
      : h(
          "div",
          { class: "ac" },
          kind === "save"
            ? h("button", { type: "button", class: "p", onclick: () => void save(row.bot, false) }, "Move back")
            : null,
          openLink(row.bot, kind !== "save"),
          pr && kind === "need" ? h("a", { href: pr, target: "_blank", rel: "noopener noreferrer" }, prLabel(pr)) : null,
          kind === "need" ? h("button", { type: "button", onclick: () => void save(row.bot, true) }, "🔖 Later") : null,
        ),
  );
}

function feedView(): HTMLElement {
  const queue = attention();
  const saved = savedRows();
  const items = feedItems();
  return h(
    "main",
    { class: "feed" },
    h(
      "section",
      { class: "pin" },
      h("div", { class: "lab" }, `Needs my attention · ${queue.length}`, h("span", { class: "r" }, "pinned until handled")),
      h(
        "div",
        { class: "pins" },
        ...(queue.length
          ? queue.map((row) => pinCard(row))
          : [h("p", { class: "empty" }, "Nothing needs you.")]),
      ),
    ),
    h(
      "section",
      { class: "saved" },
      ...saved.map((row) =>
        h(
          "div",
          { class: "sv" },
          "🔖 ",
          h("span", {}, h("b", {}, "Saved: "), `${row.bot.name} · ${row.stepText}`),
          accountTag(row.bot.account),
          h(
            "span",
            { class: "r" },
            h("button", { type: "button", class: "btn", onclick: () => void save(row.bot, false) }, "Move back"),
          ),
        ),
      ),
    ),
    h(
      "section",
      { class: "tl" },
      h("div", { class: "lab" }, "What bots are saying", feedFilters()),
      h("div", { class: "tlcols" }, ...timeline(items)),
      state.olderNext !== null || (!state.olderLoaded && (state.data?.activity.nextBefore ?? null) !== null)
        ? h(
            "button",
            {
              type: "button",
              class: "older",
              onclick: () => void loadOlder(state.olderLoaded ? state.olderNext : (state.data?.activity.nextBefore ?? null)),
            },
            state.loadingOlder ? "Loading…" : "View older activity",
          )
        : null,
    ),
    h(
      "aside",
      { class: "side" },
      h(
        "div",
        { class: "box wkbox" },
        h("div", { class: "lab" }, `Working now · ${visibleBots().filter((row) => row.bucket === "working").length}`),
        h(
          "div",
          { class: "wkrow" },
          ...visibleBots()
            .filter((row) => row.bucket === "working" && row.bot.savedAt === null)
            .map((row) => h("div", { class: "wk" }, dot("var(--blue)"), h("b", {}, row.bot.name), h("em", {}, ACCOUNT_LABEL[row.bot.account]))),
        ),
      ),
      ...sessionPlaces("fcode", "tcode"),
      h("div", { class: "box projects" }, h("div", { class: "lab" }, "By account"), ...accountSummary()),
    ),
  );
}

function pinCard(row: BotRowView): HTMLElement {
  const label = attentionLabel(row.state);
  return h(
    "div",
    { class: "pc", style: `--x:${stateColor(row.state)}` },
    h("div", { class: "t" }, label.text, h("span", {}, age(row.bot))),
    h("b", {}, row.bot.name),
    h("div", { class: "pa" }, accountTag(row.bot.account)),
    h("p", {}, row.stepText),
    h("div", { class: "pcb" }, openLink(row.bot, true)),
  );
}

function feedFilters(): HTMLElement {
  const options: { id: FeedFilter; label: string }[] = [
    { id: "all", label: "Everything" },
    { id: "needs", label: "Needs me" },
    { id: "work", label: ACCOUNT_LABEL.work },
    { id: "leaf", label: ACCOUNT_LABEL.leaf },
  ];
  return h(
    "span",
    { class: "fil" },
    ...options.map((option) =>
      h(
        "button",
        {
          type: "button",
          class: state.feedFilter === option.id ? "on" : "",
          onclick: () => {
            state.feedFilter = option.id;
            render();
          },
        },
        option.label,
      ),
    ),
  );
}

function feedItems(): ActivityItem[] {
  const first = state.data?.activity.items ?? [];
  const seen = new Set<number>();
  const items = [...first, ...state.olderActivity].filter((item) => !seen.has(item.seq) && seen.add(item.seq));
  const filtered = items.filter((item) => {
    if (!accountMatches(item.account, state.account)) return false;
    if (state.feedFilter === "work" || state.feedFilter === "leaf") return item.account === state.feedFilter;
    if (state.feedFilter === "needs") return item.kind === "waiting_user" || item.kind === "error" || item.kind === "message";
    return true;
  });
  return visibleActivity(filtered);
}

function timeline(items: ActivityItem[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  let bucket = "";
  const clock = now();
  for (const item of items) {
    const name = isSameDay(item.at, clock) ? (clock - item.at < 30 * 60_000 ? "Now" : "Earlier today") : formatClock(item.at, clock);
    if (name !== bucket) {
      bucket = name;
      out.push(h("div", { class: "day" }, name));
    }
    const bot = state.data?.bots.find((candidate) => candidate.account === item.account && candidate.id === item.botId);
    const display = bot ? displayState(bot, clock) : "idle";
    out.push(
      h(
        "div",
        { class: "it" },
        h("div", { class: "av", style: `background:${stateColor(display)}` }, initials(item.botName)),
        h(
          "div",
          { class: "bd" },
          h(
            "div",
            { class: "l" },
            h("b", {}, item.botName),
            accountTag(item.account),
            h("span", { class: `tag ${tagForKind(item.kind)}` }, activityLabel(item.kind)),
            h("span", { class: "tm" }, `${formatClock(item.at, clock)} (Hebron)`),
          ),
          ...detailLine(item),
        ),
      ),
    );
  }
  if (out.length === 0) out.push(h("p", { class: "empty" }, "No activity for this filter yet."));
  return out;
}

function tagForKind(kind: ActivityItem["kind"]): string {
  switch (kind) {
    case "error":
      return "t-red";
    case "waiting_user":
    case "message":
      return "t-amb";
    case "working":
      return "t-blue";
    case "saved":
    case "unsaved":
      return "t-pur";
    case "done":
      return "t-green";
    default:
      return "t-gray";
  }
}

function detailLine(item: ActivityItem): HTMLElement[] {
  const detail = activityDetail(item);
  return detail === null ? [] : [h("p", {}, detail)];
}

function accountSummary(): HTMLElement[] {
  const accounts: Account[] = state.account === "leaf" ? ["leaf"] : state.account === "work" ? ["work"] : ["work", "leaf"];
  return accounts.map((account) => {
    const rows = visibleBots().filter((row) => row.bot.account === account);
    const need = rows.filter((row) => row.bot.savedAt === null && needsAttention(row.bucket)).length;
    return h(
      "div",
      { class: "pr" },
      h("b", {}, accountTag(account)),
      h("span", { class: "lights" }, ...rows.slice(0, 8).map((row) => h("i", { style: `background:${stateColor(row.state)}` }))),
      h("em", {}, `${rows.length} bots · ${need} need you`),
    );
  });
}

async function loadOlder(before: number | null): Promise<void> {
  if (before === null || state.loadingOlder) return;
  const account = state.account;
  const gen = state.olderGen;
  state.loadingOlder = true;
  render();
  try {
    const page = await fetchActivity(before, account);
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
    if (gen === state.olderGen && !state.olderLoaded) state.olderActivity = [];
  } finally {
    state.loadingOlder = false;
  }
  render();
}

function render(): void {
  const root = app();
  if (!root) return;
  const scroll = root.querySelector("main")?.scrollTop ?? 0;
  const main = !state.data
    ? h("main", {}, h("p", { class: "boot" }, state.error ?? "Loading Bot Fleet…"))
    : state.tab === "board"
      ? boardView()
      : state.tab === "feed"
        ? feedView()
        : focusView();
  const parts: Node[] = [header()];
  if (state.data) parts.push(usageBar());
  if (state.error && state.data) parts.push(h("p", { class: "banner", role: "status" }, state.error));
  parts.push(main);
  root.replaceChildren(...parts);
  const nextMain = root.querySelector("main");
  if (nextMain) nextMain.scrollTop = scroll;
}

function boot(): void {
  loadPrefs();
  const hashed = tabFromHash();
  if (hashed) state.tab = hashed;
  else history.replaceState(null, "", `#${state.tab}`);
  render();
  void refresh();
  window.addEventListener("hashchange", () => {
    const next = tabFromHash();
    if (next && next !== state.tab) {
      state.tab = next;
      savePrefs();
      render();
    }
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select")) return;
    if ((event.key === "n" || event.key === "N" || event.key === "ArrowRight") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (state.tab !== "focus") return;
      event.preventDefault();
      advance(1);
    }
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(".u.g")) return;
    if (state.grokOpen) {
      state.grokOpen = null;
      render();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, REFRESH_MS);
}

boot();
