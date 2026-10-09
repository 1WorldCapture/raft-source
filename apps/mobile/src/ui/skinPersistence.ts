import { File, Paths } from "expo-file-system";
import { bindSkinStorage } from "./skin";

// One local file, read synchronously so the first painted frame already uses
// the saved skin. Server sync is a later step, after preferredSkin is on dev.
const FILE_NAME = "raft-mobile-skin";

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
