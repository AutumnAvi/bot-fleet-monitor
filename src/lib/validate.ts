// Parses and validates ingest payloads. Produces clean values or a client error.

import {
  INGEST_STATUSES,
  LEAF_GROUP,
  LIMITS,
  WORK_GROUPS,
  type Account,
  type IngestStatus,
} from "../shared/model";
import { cleanBlock, cleanLine } from "./sanitize";

export const INGEST_KINDS = ["status", "summary", "message", "avi-replied", "save-for-later"] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];

export function isIngestKind(value: string): value is IngestKind {
  return (INGEST_KINDS as readonly string[]).includes(value);
}

/** Who the payload is about, plus optional upsert fields. */
export interface BotRef {
  botId: string;
  name?: string;
  group?: string;
}

export type IngestPayload =
  | (BotRef & { kind: "status"; status: IngestStatus; step: string | null })
  | (BotRef & { kind: "summary"; summary: string | null })
  | (BotRef & { kind: "message"; text: string })
  | (BotRef & { kind: "avi-replied" })
  | (BotRef & { kind: "save-for-later" });

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const COMMON_FIELDS = ["botId", "name", "group", "account"];
const KIND_FIELDS: Record<IngestKind, string[]> = {
  status: ["status", "step"],
  summary: ["summary"],
  message: ["text"],
  "avi-replied": [],
  "save-for-later": [],
};

function bad(message: string, code = "invalid_payload"): ClientError {
  return new ClientError(400, code, message);
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw bad(`"${key}" must be a string`);
  return value;
}

export function parseIngestPayload(
  kind: IngestKind,
  account: Account,
  raw: unknown,
): IngestPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bad("Body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const allowed = new Set([...COMMON_FIELDS, ...KIND_FIELDS[kind]]);
  const unknownKey = Object.keys(obj).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw bad(`Unknown field "${cleanLine(unknownKey, 40)}" for ${kind}`);
  }

  const claimedAccount = optionalString(obj, "account");
  if (claimedAccount !== undefined && claimedAccount !== account) {
    throw new ClientError(403, "account_mismatch", "This write key cannot write to that account");
  }

  const botIdRaw = optionalString(obj, "botId");
  if (botIdRaw === undefined) throw bad('"botId" is required');
  const botId = botIdRaw.trim();
  if (botId.length === 0 || botId.length > LIMITS.botIdChars || !BOT_ID.test(botId)) {
    throw bad(`"botId" must be 1-${LIMITS.botIdChars} characters of A-Z a-z 0-9 . _ : -`);
  }

  const ref: BotRef = { botId };

  const nameRaw = optionalString(obj, "name");
  if (nameRaw !== undefined) {
    const name = cleanLine(nameRaw, LIMITS.nameChars);
    if (name.length === 0) throw bad('"name" must not be empty');
    ref.name = name;
  }

  const groupRaw = optionalString(obj, "group");
  if (groupRaw !== undefined) {
    const group = groupRaw.trim();
    if (account === "leaf") {
      if (group !== LEAF_GROUP) throw bad(`Leaf-account bots always use group "${LEAF_GROUP}"`);
    } else if (!(WORK_GROUPS as readonly string[]).includes(group)) {
      throw bad(`"group" must be one of: ${WORK_GROUPS.join(", ")}`);
    }
    ref.group = group;
  }

  switch (kind) {
    case "status": {
      const status = optionalString(obj, "status");
      if (status === undefined || !(INGEST_STATUSES as readonly string[]).includes(status)) {
        throw bad(`"status" must be one of: ${INGEST_STATUSES.join(", ")}`);
      }
      const stepRaw = optionalString(obj, "step");
      const step = stepRaw === undefined ? null : cleanLine(stepRaw, LIMITS.stepChars) || null;
      return { ...ref, kind, status: status as IngestStatus, step };
    }
    case "summary": {
      const summaryRaw = optionalString(obj, "summary");
      if (summaryRaw === undefined) throw bad('"summary" is required (send "" to clear it)');
      const summary = cleanBlock(summaryRaw, LIMITS.summaryChars) || null;
      return { ...ref, kind, summary };
    }
    case "message": {
      const textRaw = optionalString(obj, "text");
      const text = textRaw === undefined ? "" : cleanBlock(textRaw, LIMITS.messageChars);
      if (text.length === 0) throw bad('"text" is required');
      return { ...ref, kind, text };
    }
    case "avi-replied":
    case "save-for-later":
      return { ...ref, kind };
  }
}
