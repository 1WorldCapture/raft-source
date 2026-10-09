import { File, Paths } from "expo-file-system";
import { bindSkinPending, bindSkinStorage } from "./skin";

// Read synchronously so the first painted frame already uses the saved skin.
// The pending file is the unsent-pick flag createSkinSync retries after login or when the network returns.
const FILE_NAME = "raft-mobile-skin";
const PENDING_NAME = "raft-mobile-skin-pending";

function skinFile(): File | null {
  try {
    return new File(Paths.document, FILE_NAME);
  } catch {
    return null;
  }
}

bindSkinStorage({
  read: () => {
    const file = skinFile();
    if (!file?.exists) return null;
    return file.textSync();
  },
  write: (id) => {
    const file = skinFile();
    if (!file) return;
    if (!file.exists) file.create();
    file.write(id);
  },
});

function pendingFile(): File | null {
  try {
    return new File(Paths.document, PENDING_NAME);
  } catch {
    return null;
  }
}

bindSkinPending({
  read: () => {
    const file = pendingFile();
    if (!file?.exists) return false;
    return file.textSync().trim() === "1";
  },
  write: (value) => {
    const file = pendingFile();
    if (!file) return;
    if (!value) {
      if (file.exists) file.delete();
      return;
    }
    if (!file.exists) file.create();
    file.write("1");
  },
});
