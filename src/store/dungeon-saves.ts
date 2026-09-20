import { api } from "./api.ts";
import {
  browserRecoveryStorage,
  SaveCoordinator,
  type RecoveryStorage,
} from "./save-coordinator.ts";

const unavailable: RecoveryStorage = {
  read: () => [],
  put: () => {
    throw new Error(
      "Local recovery storage is unavailable. Keep this tab open until Saved, or export the local copy.",
    );
  },
  remove: () => {},
};
let storage = unavailable;
try {
  if (typeof localStorage !== "undefined")
    storage = browserRecoveryStorage(localStorage);
} catch {
  /* denied */
}
export const dungeonSaves = new SaveCoordinator(
  storage,
  (id, mutation) => api.dungeons.update(id, mutation),
  (id) => api.dungeons.get(id),
);

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (dungeonSaves.hasUnsafeChanges()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
