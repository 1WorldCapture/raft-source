// Which server-side machines are THIS device, for the standalone Computer. The CLI's status JSON carries no
// machine ids, so read them from the attachments the Computer keeps: <home>/computer/servers/<id>/runner.state.json.
// Read-only and best effort: an unreadable file just contributes nothing (the card then falls back to hostname).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function readLocalMachineIds(home: string): Promise<string[]> {
  const root = path.join(home, "computer", "servers");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.sort()) {
    try {
      const parsed = JSON.parse(await readFile(path.join(root, name, "runner.state.json"), "utf8")) as { machineId?: unknown };
      if (typeof parsed.machineId === "string" && parsed.machineId.length > 0 && !ids.includes(parsed.machineId)) ids.push(parsed.machineId);
    } catch {
      // missing or malformed attachment: skip
    }
  }
  return ids;
}
