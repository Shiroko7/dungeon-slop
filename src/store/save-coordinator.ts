import type {
  DungeonMutation,
  DungeonPatch,
  DungeonRecord,
} from "../campaign/types.ts";
import { ApiError } from "./api.ts";

export type SaveStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "failed"
  | "conflict"
  | "recovery";
export interface PendingSave {
  key: string;
  dungeonId: number;
  campaignId: number;
  name: string;
  revision: number;
  pending: DungeonPatch;
  flight: DungeonMutation | null;
}
export interface SaveState {
  status: SaveStatus;
  durable: boolean;
  error: string | null;
}
export interface RecoveryStorage {
  read(): PendingSave[];
  put(entry: PendingSave): void;
  remove(key: string): void;
  acquire?(key: string): Promise<(() => void) | null>;
}
const PREFIX = "dungeon-outbox-v1:";
/** Recovery only, not a canonical cache. The budget is shared by all tabs.
 * Storage denial/quota failure leaves the in-memory copy dirty and warns on exit.
 */
export function browserRecoveryStorage(storage: Storage): RecoveryStorage {
  return {
    async acquire(key) {
      if (typeof navigator === "undefined" || !navigator.locks) {
        throw new Error(
          "This browser cannot safely coordinate recovery between tabs.",
        );
      }
      return new Promise((resolve, reject) => {
        void navigator.locks
          .request(key, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(null);
              return;
            }
            return new Promise<void>((release) => resolve(release));
          })
          .catch(reject);
      });
    },
    read() {
      const result: PendingSave[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(PREFIX)) continue;
        try {
          const data = JSON.parse(storage.getItem(key)!) as PendingSave;
          if (
            data.key === key &&
            Number.isSafeInteger(data.dungeonId) &&
            data.dungeonId > 0 &&
            Number.isSafeInteger(data.revision) &&
            data.revision >= 0 &&
            data.pending &&
            typeof data.pending === "object"
          )
            result.push(data);
        } catch {
          /* Leave unreadable entries untouched for manual recovery. */
        }
      }
      return result;
    },
    put(entry) {
      const value = JSON.stringify(entry);
      let size = value.length * 2;
      let count = 1;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(PREFIX) && key !== entry.key) {
          size += (storage.getItem(key)?.length ?? 0) * 2;
          count++;
        }
      }
      if (size > 4 * 1024 * 1024 || count > 20)
        throw new Error(
          "Recovery storage is full (4 MiB / 20 pending maps). Keep this tab open or export the local copy.",
        );
      storage.setItem(entry.key, value);
    },
    remove: (key) => storage.removeItem(key),
  };
}
export function mergePatches(a: DungeonPatch, b: DungeonPatch): DungeonPatch {
  const merged = { ...a, ...b };
  if (a.roomNotes || b.roomNotes)
    merged.roomNotes = [
      ...new Map([...(a.roomNotes ?? []), ...(b.roomNotes ?? [])]),
    ];
  return merged;
}
export function applyPatch(
  record: DungeonRecord,
  patch: DungeonPatch,
): DungeonRecord {
  const notes = new Map(record.roomNotes);
  for (const [id, description] of patch.roomNotes ?? []) {
    if (description === null) notes.delete(id);
    else notes.set(id, description);
  }
  return { ...record, ...patch, roomNotes: [...notes] };
}

export class SaveCoordinator {
  private entries = new Map<number, PendingSave>();
  private states = new Map<number, SaveState>();
  private running = new Map<number, Promise<void>>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private revisions = new Map<number, number>();
  private leases = new Map<string, Promise<(() => void) | null>>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(
    private storage: RecoveryStorage,
    private send: (
      id: number,
      mutation: DungeonMutation,
    ) => Promise<{ revision: number }>,
    private read: (id: number) => Promise<DungeonRecord>,
    private delay = 600,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
  private acquire(key: string) {
    const lease = this.storage.acquire
      ? this.storage.acquire(key).catch(() => null)
      : Promise.resolve(() => {});
    this.leases.set(key, lease);
    return lease;
  }
  private async release(key: string) {
    (await this.leases.get(key))?.();
    this.leases.delete(key);
  }
  state(id: number): SaveState {
    return (
      this.states.get(id) ?? { status: "saved", durable: true, error: null }
    );
  }
  pendingEntries() {
    return [...this.entries.values()];
  }
  recoveries(): PendingSave[] {
    try {
      return this.storage
        .read()
        .filter((r) => !this.pendingEntries().some((e) => e.key === r.key));
    } catch {
      return [];
    }
  }
  hasUnsafeChanges() {
    return [...this.states.values()].some((s) => !s.durable);
  }
  revision(id: number) {
    return this.revisions.get(id) ?? this.entries.get(id)?.revision ?? 0;
  }
  attach(record: DungeonRecord): DungeonRecord {
    const entry = this.entries.get(record.id);
    if (!entry) {
      this.revisions.set(record.id, record.revision);
      return record;
    }
    return applyPatch(
      record,
      mergePatches(entry.flight?.patch ?? {}, entry.pending),
    );
  }
  private persist(entry: PendingSave): boolean {
    try {
      this.storage.put(entry);
      this.states.set(entry.dungeonId, {
        ...this.state(entry.dungeonId),
        durable: true,
      });
      return true;
    } catch (err) {
      this.states.set(entry.dungeonId, {
        status: "unsaved",
        durable: false,
        error: String(err),
      });
      return false;
    }
  }
  queue(
    record: Pick<DungeonRecord, "id" | "campaignId" | "name">,
    patch: DungeonPatch,
  ) {
    let entry = this.entries.get(record.id);
    if (!entry) {
      entry = {
        key: PREFIX + crypto.randomUUID(),
        dungeonId: record.id,
        campaignId: record.campaignId,
        name: record.name,
        revision: this.revision(record.id),
        pending: {},
        flight: null,
      };
      this.entries.set(record.id, entry);
      this.acquire(entry.key);
    }
    entry.pending = mergePatches(entry.pending, patch);
    const prior = this.state(record.id);
    this.states.set(record.id, {
      ...prior,
      status: prior.status === "conflict" ? "conflict" : "unsaved",
    });
    this.persist(entry); // synchronous: no unload fetch or async storage promise
    this.emit();
    clearTimeout(this.timers.get(record.id));
    if (prior.status !== "conflict")
      this.timers.set(
        record.id,
        setTimeout(() => void this.flush(record.id), this.delay),
      );
  }
  flush(id: number): Promise<void> {
    clearTimeout(this.timers.get(id));
    const running = this.running.get(id);
    if (running) return running;
    if (this.state(id).status === "conflict") return Promise.resolve();
    const work = this.drain(id).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return work;
  }
  private async drain(id: number) {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      if ((await this.leases.get(entry.key)) === null)
        throw new Error(
          "Recovery is open in another tab, or browser recovery locking is unavailable.",
        );
      while (entry.flight || Object.keys(entry.pending).length) {
        if (!entry.flight) {
          entry.flight = {
            operationId: crypto.randomUUID(),
            expectedRevision: entry.revision,
            patch: entry.pending,
          };
          entry.pending = {};
        }
        // Persist the exact immutable request before sending. If storage is
        // unavailable, still allow a server save, but keep the exit warning.
        this.persist(entry);
        this.states.set(id, { ...this.state(id), status: "saving" });
        this.emit();
        const { revision } = await this.send(id, entry.flight);
        entry.revision = revision;
        this.revisions.set(id, revision);
        entry.flight = null;
        // Keep edits made DURING this request. Never clear a shared patch blindly.
        if (Object.keys(entry.pending).length) this.persist(entry);
      }
      this.storage.remove(entry.key);
      this.entries.delete(id);
      await this.release(entry.key);
      if (!this.entries.has(id))
        this.states.set(id, { status: "saved", durable: true, error: null });
    } catch (err) {
      const conflict =
        err instanceof ApiError && (err.status === 409 || err.status === 404);
      const durable = this.persist(entry);
      this.states.set(id, {
        status: conflict ? "conflict" : "failed",
        durable,
        error: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      this.emit();
    }
  }
  /** Explicit replay; a second tab may replay the same immutable request safely.
   * Never overwrite an existing working copy or silently rebase old edits.
   */
  async recover(recovery: PendingSave) {
    if (this.entries.has(recovery.dungeonId))
      throw new Error(
        "Save or resolve this tab's edits before recovering another copy.",
      );
    if (!(await this.acquire(recovery.key)))
      throw new Error(
        "This recovery copy is still open in another tab. Close that tab before recovering it.",
      );
    let record: DungeonRecord;
    try {
      const latest = this.storage
        .read()
        .find((entry) => entry.key === recovery.key);
      if (!latest)
        throw new Error("This recovery copy was already saved or discarded.");
      recovery = latest;
      record = await this.read(recovery.dungeonId);
      if (this.entries.has(record.id))
        throw new Error(
          "This tab has new edits. Resolve those before recovering another copy.",
        );
    } catch (err) {
      await this.release(recovery.key);
      throw err;
    }
    this.entries.set(record.id, structuredClone(recovery));
    this.revisions.set(record.id, recovery.revision);
    const conflict = record.revision !== recovery.revision && !recovery.flight;
    this.states.set(record.id, {
      status: conflict ? "conflict" : "recovery",
      durable: true,
      error: conflict
        ? "The server changed. Export the local copy, then choose a resolution."
        : null,
    });
    this.emit();
    // An in-flight request may already have committed: retry its receipt before
    // deciding that a different server revision is a conflict.
    if (!conflict) await this.flush(record.id);
  }
  async reload(id: number): Promise<DungeonRecord> {
    await this.running.get(id);
    const captured = JSON.stringify(this.entries.get(id));
    const record = await this.read(id); // fail without discarding the local copy
    if (JSON.stringify(this.entries.get(id)) !== captured)
      throw new Error(
        "Local edits changed while reloading. Review them before discarding.",
      );
    const entry = this.entries.get(id);
    if (entry) this.storage.remove(entry.key);
    this.entries.delete(id);
    this.revisions.set(id, record.revision);
    this.states.set(id, { status: "saved", durable: true, error: null });
    this.emit();
    if (entry) await this.release(entry.key);
    return record;
  }
  /** Deliberate overwrite after viewing the latest server copy, not a Retry. */
  async keepLocal(id: number, expectedServerRevision: number) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (this.running.has(id))
      throw new Error("Wait for the current save to finish.");
    const captured = JSON.stringify(entry);
    const current = await this.read(id);
    if (JSON.stringify(this.entries.get(id)) !== captured)
      throw new Error("Local edits changed. Review the conflict again.");
    if (current.revision !== expectedServerRevision)
      throw new Error(
        "The server changed again. Review the new revision first.",
      );
    entry.pending = mergePatches(entry.flight?.patch ?? {}, entry.pending);
    entry.flight = null;
    entry.revision = current.revision;
    this.states.set(id, { status: "unsaved", durable: true, error: null });
    this.persist(entry);
    await this.flush(id);
  }

  async discard(entry: PendingSave) {
    if (this.running.has(entry.dungeonId))
      throw new Error("Wait for the current save to finish.");
    const current = this.entries.get(entry.dungeonId);
    const own = current?.key === entry.key;
    if (!own && !(await this.acquire(entry.key)))
      throw new Error("This recovery is open in another tab.");
    if (own) clearTimeout(this.timers.get(entry.dungeonId));
    try {
      this.storage.remove(entry.key);
      if (own) {
        this.entries.delete(entry.dungeonId);
        this.states.delete(entry.dungeonId);
      }
    } finally {
      await this.release(entry.key);
      this.emit();
    }
  }
}
