// Coding sessions are a side list. They are not bots and never enter Needs my attention.

import type {
  Account,
  AttentionReason,
  BotView,
  CodingSession,
  DisplaySessionStatus,
  SessionTool,
} from "./model";
import { formatDuration } from "./time";

const STATUS_ORDER: Record<DisplaySessionStatus, number> = {
  running: 0,
  in_review: 1,
  paused_limit: 2,
  stalled: 3,
  failed: 4,
  aborted: 5,
  stopped: 6,
  finished: 7,
};

/**
 * `stalled` is process liveness, not a quiet timer. A running session whose
 * process is gone is stalled. Paused, in review, and terminal statuses stay as reported.
 */
export function displayStatus(session: Pick<CodingSession, "status" | "alive">): DisplaySessionStatus {
  if (session.status === "running" && session.alive === false) return "stalled";
  return session.status;
}

export interface LinkedSession {
  session: CodingSession;
  bot: BotView | null;
}

export function toolLabel(tool: SessionTool): string {
  switch (tool) {
    case "claude":
      return "Claude";
    case "t3":
      return "T3";
    case "cursor":
    case "cursor-cloud":
      return "Cursor";
  }
}

export function toolClass(tool: SessionTool): string {
  switch (tool) {
    case "claude":
      return "CC";
    case "t3":
      return "T3";
    case "cursor":
    case "cursor-cloud":
      return "CU";
  }
}

export function sessionStatusLabel(status: DisplaySessionStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "paused_limit":
      return "Paused · limit";
    case "stalled":
      return "Stalled";
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    case "aborted":
      return "Aborted";
    case "stopped":
      return "Stopped";
    case "in_review":
      return "In review";
  }
}

export function sessionStatusClass(status: DisplaySessionStatus): string {
  switch (status) {
    case "running":
    case "in_review":
      return "s-live";
    case "paused_limit":
    case "stalled":
      return "s-pause";
    case "finished":
      return "s-done";
    case "failed":
    case "aborted":
    case "stopped":
      return "s-fail";
  }
}

export function sessionBarColor(status: DisplaySessionStatus): string {
  switch (status) {
    case "running":
    case "in_review":
    case "stalled":
      return "var(--blue)";
    case "paused_limit":
      return "var(--amber)";
    case "finished":
      return "var(--green)";
    case "failed":
    case "aborted":
    case "stopped":
      return "var(--red)";
  }
}

/** FYI badge only. This never puts a bot into Needs my attention. */
export function attentionBadge(reason: AttentionReason | null): string | null {
  switch (reason) {
    case "paused_limit":
      return "Paused · limit";
    case "stalled":
      return "Stalled";
    case "pr_ready":
      return "PR ready";
    case null:
      return null;
  }
}

export function sessionBadge(session: Pick<CodingSession, "tool" | "account">): { label: string; className: string } {
  if (session.tool) return { label: toolLabel(session.tool), className: toolClass(session.tool) };
  if (session.account === "cursor" || session.account === "cursor-cloud") return { label: "Cursor", className: "CU" };
  if (session.account === "codex") return { label: "Codex", className: "CX" };
  if (session.account.startsWith("claude")) return { label: "Claude", className: "CC" };
  return { label: session.account, className: "T3" };
}

/** 0–100, or null when the collector didn't send a step count. */
export function sessionProgress(session: CodingSession): number | null {
  if (session.step === null || session.steps === null || session.steps <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((session.step / session.steps) * 100)));
}

export function sessionTitle(session: CodingSession): string {
  const cloud =
    (session.tool === "cursor-cloud" || session.account === "cursor-cloud") && !/cloud/i.test(session.title)
      ? " (cloud)"
      : "";
  const count = session.helpers.length;
  const helpers = count > 0 ? ` · ${count} helper${count === 1 ? "" : "s"}` : "";
  return `${session.title}${cloud}${helpers}`;
}

export function sortSessions(sessions: readonly CodingSession[]): CodingSession[] {
  return [...sessions].sort(
    (a, b) =>
      STATUS_ORDER[displayStatus(a)] - STATUS_ORDER[displayStatus(b)] ||
      b.updatedAt - a.updatedAt ||
      a.title.localeCompare(b.title, "en") ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Joins a session to a bot by ownerBotId. A session with no owner, or an owner
 * that isn't on the roster, is an orphan and collapses into one grey line.
 */
export function linkSessions(sessions: readonly CodingSession[], bots: readonly BotView[]): {
  linked: LinkedSession[];
  orphans: CodingSession[];
} {
  const linked: LinkedSession[] = [];
  const orphans: CodingSession[] = [];
  for (const session of sortSessions(sessions)) {
    if (!session.ownerBotId) {
      orphans.push(session);
      continue;
    }
    const matches = bots.filter((bot) => bot.id === session.ownerBotId);
    const bot = matches.find((item) => item.account === "work") ?? matches[0] ?? null;
    if (!bot) orphans.push(session);
    else linked.push({ session, bot });
  }
  return { linked, orphans };
}

/** `account` is the Grok bot's account. The session's own `account` is the tool source and is not compared. */
export function sessionsOwnedBy(sessions: readonly CodingSession[], _account: Account, botId: string): CodingSession[] {
  return sessions.filter((session) => session.ownerBotId === botId);
}

/** Active sessions only. Finished and failed stay in the FYI list, not on the working card. */
export function codingNote(sessions: readonly CodingSession[]): string | null {
  const active = sessions.filter((session) => {
    const status = displayStatus(session);
    return status === "running" || status === "paused_limit" || status === "stalled" || status === "in_review";
  });
  if (active.length === 0) return null;
  const paused = active.filter((session) => displayStatus(session) === "paused_limit").length;
  if (paused === active.length) {
    return paused === 1 ? "⌨ 1 session paused" : `⌨ ${paused} sessions paused`;
  }
  return active.length === 1 ? "⌨ 1 coding session" : `⌨ ${active.length} coding sessions`;
}

export function sessionSummary(sessions: readonly CodingSession[]): string {
  const counts = { running: 0, paused: 0, finished: 0, failed: 0 };
  for (const session of sessions) {
    const status = displayStatus(session);
    if (status === "running" || status === "in_review") counts.running += 1;
    else if (status === "paused_limit" || status === "stalled") counts.paused += 1;
    else if (status === "finished") counts.finished += 1;
    else counts.failed += 1;
  }
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.paused) parts.push(`${counts.paused} paused`);
  if (counts.finished) parts.push(`${counts.finished} finished`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.length ? `· ${parts.join(" · ")}` : "· none";
}

export function runLabel(session: CodingSession, now: number): string {
  const ms = Math.max(0, now - session.startedAt);
  if (ms < 60_000) return "<1m";
  return formatDuration(ms);
}

export function orphanLine(orphans: readonly CodingSession[]): string | null {
  if (orphans.length === 0) return null;
  if (orphans.length === 1) {
    const only = orphans[0];
    return only ? `1 unassigned (${only.title})` : "1 unassigned";
  }
  return `${orphans.length} unassigned`;
}

export function helperRuntime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return formatDuration(seconds * 1000);
}

/** Initials for feed avatars and the focus card. Two letters, from the bot's name. */
export function initials(name: string): string {
  const words = name
    .split(/[\s·•|/]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && /[A-Za-z0-9]/.test(word));
  if (words.length === 0) return "•";
  if (words.length === 1) {
    const letters = Array.from(words[0] ?? "").filter((ch) => /[A-Za-z0-9]/.test(ch));
    return (letters.slice(0, 2).join("") || "•").toUpperCase();
  }
  const first = Array.from(words[0] ?? "").find((ch) => /[A-Za-z0-9]/.test(ch)) ?? "";
  const second = Array.from(words[1] ?? "").find((ch) => /[A-Za-z0-9]/.test(ch)) ?? "";
  return `${first}${second}`.toUpperCase() || "•";
}
