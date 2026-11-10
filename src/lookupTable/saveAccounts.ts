import path from "path";
import fs from "fs";

export const KEYS_DIR = "keys";

/**
 * Append secret keys to keys/<fileName>. Safe by design:
 * - never deletes or overwrites existing keys (an unreadable file is kept and a new file is written instead)
 * - writes atomically (temp file + rename) with owner-only permissions
 * - THROWS on failure, so callers never fund wallets whose keys were not saved
 * keys/ is in .gitignore. Back this folder up somewhere safe and never commit it.
 */
export const saveDataToFile = (newData: string[], fileName: string = "data.json"): string => {
  fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  let filePath = path.join(KEYS_DIR, fileName);

  let existing: string[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      existing = parsed;
    } catch (e) {
      // Don't touch the old file: it may hold keys to funded wallets.
      filePath = path.join(KEYS_DIR, `${path.parse(fileName).name}-${Date.now()}.json`);
      console.warn(`⚠️  ${fileName} could not be read (${(e as Error).message}); leaving it as is and writing ${filePath}`);
    }
  }

  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...existing, ...newData], null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);

  // Read back to prove the keys are really on disk before anyone sends SOL to them.
  const check = JSON.parse(fs.readFileSync(filePath, "utf-8")) as string[];
  if (!newData.every((k) => check.includes(k))) throw new Error(`Key file ${filePath} failed verification`);
  console.log(`Saved ${newData.length} keys to ${filePath}`);
  return filePath;
};

export const loadKeysFromFile = (fileName: string = "data.json"): string[] => {
  const filePath = path.join(KEYS_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error(`${filePath} is not a JSON array of keys`);
  return parsed;
};
