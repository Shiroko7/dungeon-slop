import type { Database } from "bun:sqlite";
import { touchCampaign } from "./campaigns.ts";
import { dungeonCampaignId } from "./dungeons.ts";
import type { ChatMessage, ChatRecord, ChatSummary, Citation, MessageInput } from "./types.ts";

interface ChatRow {
  id: number;
  campaign_id: number;
  dungeon_id: number | null;
  title: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  citations: string | null;
  created_at: number;
}

const CHAT_SELECT = `
  SELECT c.id, c.campaign_id, c.dungeon_id, c.title, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
  FROM chats c
`;

function toSummary(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    dungeonId: row.dungeon_id,
    title: row.title,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  let citations: Citation[] | null = null;
  if (row.citations !== null) {
    try {
      const parsed: unknown = JSON.parse(row.citations);
      if (Array.isArray(parsed)) citations = parsed as Citation[];
    } catch {
      // A malformed citation list should cost the footnotes, not the message.
    }
  }
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    citations,
    createdAt: row.created_at,
  };
}

/** Loremaster threads only — a dungeon's Architect log is reached through the dungeon. */
export function listChats(db: Database, campaignId: number): ChatSummary[] {
  const rows = db
    .query(
      `${CHAT_SELECT} WHERE c.campaign_id = ? AND c.dungeon_id IS NULL
       ORDER BY c.updated_at DESC`,
    )
    .all(campaignId) as ChatRow[];
  return rows.map(toSummary);
}

export function getChat(db: Database, id: number): ChatRecord | null {
  const row = db.query(`${CHAT_SELECT} WHERE c.id = ?`).get(id) as ChatRow | null;
  if (row === null) return null;
  return { ...toSummary(row), messages: listMessages(db, id) };
}

export function listMessages(db: Database, chatId: number): ChatMessage[] {
  const rows = db
    .query(
      "SELECT id, role, content, citations, created_at FROM messages WHERE chat_id = ? ORDER BY id",
    )
    .all(chatId) as MessageRow[];
  return rows.map(toMessage);
}

export function createChat(
  db: Database,
  campaignId: number,
  options: { title?: string; dungeonId?: number | null } = {},
): ChatRecord {
  const now = Date.now();
  db.run(
    "INSERT INTO chats (campaign_id, dungeon_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [campaignId, options.dungeonId ?? null, options.title?.trim() ?? "", now, now],
  );
  const id = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  touchCampaign(db, campaignId);

  const created = getChat(db, id);
  if (created === null) throw new Error(`Chat ${id} vanished immediately after insert`);
  return created;
}

/**
 * The single Architect thread for a dungeon, created on first use.
 *
 * The uniqueness is enforced by a partial index in the schema, not by this
 * lookup — two concurrent requests would otherwise both miss and both insert.
 * On that collision the insert throws and the second caller re-reads.
 */
export function architectChat(db: Database, dungeonId: number): ChatRecord {
  const existing = db.query("SELECT id FROM chats WHERE dungeon_id = ?").get(dungeonId) as
    | { id: number }
    | null;
  if (existing !== null) {
    const chat = getChat(db, existing.id);
    if (chat !== null) return chat;
  }

  const campaignId = dungeonCampaignId(db, dungeonId);
  if (campaignId === null) throw new Error(`No dungeon ${dungeonId}`);

  try {
    return createChat(db, campaignId, { dungeonId, title: "Architect" });
  } catch (err) {
    const raced = db.query("SELECT id FROM chats WHERE dungeon_id = ?").get(dungeonId) as
      | { id: number }
      | null;
    if (raced === null) throw err;
    const chat = getChat(db, raced.id);
    if (chat === null) throw err;
    return chat;
  }
}

export function updateChat(db: Database, id: number, patch: { title?: string }): ChatRecord | null {
  if (patch.title !== undefined) {
    db.run("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?", [
      patch.title.trim(),
      Date.now(),
      id,
    ]);
  }
  return getChat(db, id);
}

export function deleteChat(db: Database, id: number): boolean {
  const row = db.query("SELECT id FROM chats WHERE id = ?").get(id);
  if (row === null) return false;
  db.run("DELETE FROM chats WHERE id = ?", [id]);
  return true;
}

export function appendMessage(db: Database, chatId: number, input: MessageInput): ChatMessage {
  const now = Date.now();
  db.run(
    "INSERT INTO messages (chat_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?)",
    [
      chatId,
      input.role,
      input.content,
      input.citations == null ? null : JSON.stringify(input.citations),
      now,
    ],
  );
  const id = Number((db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  db.run("UPDATE chats SET updated_at = ? WHERE id = ?", [now, chatId]);

  // First user line names an untitled thread, the way the picker needs it to.
  if (input.role === "user") {
    const row = db.query("SELECT title FROM chats WHERE id = ?").get(chatId) as
      | { title: string }
      | null;
    if (row !== null && row.title === "") {
      db.run("UPDATE chats SET title = ? WHERE id = ?", [deriveTitle(input.content), chatId]);
    }
  }

  const row = db
    .query("SELECT id, role, content, citations, created_at FROM messages WHERE id = ?")
    .get(id) as MessageRow;
  return toMessage(row);
}

/** Replace a thread's messages wholesale — used by the legacy import and by edit-and-resend. */
export function replaceMessages(db: Database, chatId: number, inputs: MessageInput[]): ChatMessage[] {
  db.transaction(() => {
    db.run("DELETE FROM messages WHERE chat_id = ?", [chatId]);
    const insert = db.prepare(
      "INSERT INTO messages (chat_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const [i, input] of inputs.entries()) {
      insert.run(
        chatId,
        input.role,
        input.content,
        input.citations == null ? null : JSON.stringify(input.citations),
        // Spaced so the ordering survives a later sort by timestamp as well as by id.
        now + i,
      );
    }
    const first = inputs.find((m) => m.role === "user");
    db.run("UPDATE chats SET updated_at = ?, title = COALESCE(NULLIF(title, ''), ?) WHERE id = ?", [
      now,
      first === undefined ? "" : deriveTitle(first.content),
      chatId,
    ]);
  })();
  return listMessages(db, chatId);
}

export function truncateMessagesFrom(db: Database, chatId: number, index: number): ChatMessage[] {
  const ids = (
    db.query("SELECT id FROM messages WHERE chat_id = ? ORDER BY id").all(chatId) as Array<{
      id: number;
    }>
  ).map((r) => r.id);

  const cutoff = ids[index];
  if (cutoff === undefined) return listMessages(db, chatId);

  db.run("DELETE FROM messages WHERE chat_id = ? AND id >= ?", [chatId, cutoff]);
  db.run("UPDATE chats SET updated_at = ? WHERE id = ?", [Date.now(), chatId]);
  return listMessages(db, chatId);
}

function deriveTitle(content: string): string {
  const line = content.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line || "Untitled";
}
