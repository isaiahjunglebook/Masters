import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Filesystem-backed storage for the daily brief.
 *
 * Everything lives under one directory (DATA_DIR, default ./data) so a whole
 * archive can be backed up, moved between machines, or inspected by hand — no
 * database to install and nothing hidden in a binary format. JSON for state,
 * plain .txt for transcripts.
 */

export const DATA_DIR = resolve(
  process.cwd(),
  process.env.DATA_DIR ?? "data"
);

export const CREATORS_FILE = resolve(DATA_DIR, "creators.json");
export const SEEN_FILE = resolve(DATA_DIR, "seen.json");
export const ARCHIVE_DIR = resolve(DATA_DIR, "archive");
export const BRIEFS_DIR = resolve(DATA_DIR, "briefs");

/** Read a JSON file, returning `fallback` when it doesn't exist yet. A corrupt
 *  file is a real error and is allowed to throw — silently resetting it would
 *  discard an archive index the user can't rebuild. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return fallback;
    throw new Error(`${file} is unreadable: ${err?.message ?? err}`);
  }
}

/** Write JSON atomically: a crash mid-write would otherwise truncate the file
 *  that records which videos are already archived. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
