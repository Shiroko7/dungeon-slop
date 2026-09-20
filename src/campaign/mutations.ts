import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { DungeonMutation } from "./types.ts";
import { getDungeon, updateDungeon } from "./dungeons.ts";
import { checkpointAuthoredContent } from "./revisions.ts";

export class MutationError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public revision?: number,
  ) {
    super(message);
  }
}

/** One transaction covers the revision comparison, all fields/notes and receipt.
 * Receipts make a lost HTTP acknowledgement safe to retry, even after another
 * writer has committed. Returning the ORIGINAL acknowledged revision is vital.
 */
export function commitDungeon(
  db: Database,
  id: number,
  mutation: DungeonMutation,
): number {
  return db.transaction(() => {
    const current = getDungeon(db, id);
    if (!current)
      throw new MutationError(
        404,
        "owner_missing",
        "This dungeon no longer exists. Export your local recovery copy.",
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          expectedRevision: mutation.expectedRevision,
          patch: mutation.patch,
        }),
      )
      .digest("hex");
    const receipt = db
      .query(
        "SELECT fingerprint, revision FROM dungeon_mutations WHERE dungeon_id = ? AND operation_id = ?",
      )
      .get(id, mutation.operationId) as {
      fingerprint: string;
      revision: number;
    } | null;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new MutationError(
          409,
          "operation_reused",
          "A save ID was reused with different content.",
        );
      return receipt.revision;
    }
    if (current.revision !== mutation.expectedRevision) {
      throw new MutationError(
        409,
        "revision_conflict",
        "A newer version was saved elsewhere. Your local edits are retained.",
        current.revision,
      );
    }
    const geometry =
      mutation.patch.geometry === undefined
        ? current.geometry
        : mutation.patch.geometry;
    for (const [roomId, description] of mutation.patch.roomNotes ?? []) {
      // Deleting an old orphan note is safe; inserting a new orphan is not.
      if (
        description !== null &&
        !geometry?.rooms.some((room) => room.id === roomId)
      ) {
        throw new MutationError(
          400,
          "room_owner_mismatch",
          `Room ${roomId} does not belong to this map.`,
        );
      }
    }
    checkpointAuthoredContent(db, id, current, mutation.patch);
    const saved = updateDungeon(db, id, mutation.patch)!;
    db.run("INSERT INTO dungeon_mutations VALUES (?, ?, ?, ?)", [
      id,
      mutation.operationId,
      fingerprint,
      saved.revision,
    ]);
    // Older receipts can only cause a conflict, never a blind replay.
    db.run(
      "DELETE FROM dungeon_mutations WHERE dungeon_id = ? AND revision < ?",
      [id, saved.revision - 1000],
    );
    return saved.revision;
  })();
}
