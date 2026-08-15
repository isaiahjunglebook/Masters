import { CREATORS_FILE, readJson, writeJson } from "./store";

/** A whitelisted source the daily scrape checks. Only YouTube today; the shape
 *  carries `kind` so RSS/newsletter sources can be added without migrating the
 *  stored file. */
export interface Creator {
  /** Stable id — the resolved channel id once known, else a slug of the input. */
  id: string;
  kind: "youtube";
  /** Exactly what the user pasted, kept so a failed resolve can be retried. */
  input: string;
  /** Display name, filled in on first successful resolve. */
  name: string;
  /** Resolved UC… channel id; null until the first scrape resolves it. */
  channelId: string | null;
  addedAt: string;
  /** Set when a scrape fails to resolve the channel, so the UI can show why. */
  lastError?: string;
}

export async function listCreators(): Promise<Creator[]> {
  return readJson<Creator[]>(CREATORS_FILE, []);
}

export async function saveCreators(creators: Creator[]): Promise<void> {
  await writeJson(CREATORS_FILE, creators);
}

/** Key a pasted input for duplicate detection: handles differing only by URL
 *  form, trailing slash, or case are the same creator. */
function inputKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?youtube\.com\//, "")
    .replace(/\/+$/, "")
    .replace(/^@/, "");
}

/** Add a creator, ignoring one already on the list. Returns the stored record
 *  either way so the caller can report "added" vs "already there". */
export async function addCreator(
  input: string
): Promise<{ creator: Creator; added: boolean }> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a channel URL or @handle");

  const creators = await listCreators();
  const key = inputKey(trimmed);
  const existing = creators.find((c) => inputKey(c.input) === key);
  if (existing) return { creator: existing, added: false };

  const creator: Creator = {
    id: key || trimmed,
    kind: "youtube",
    input: trimmed,
    name: trimmed.replace(/^.*youtube\.com\//i, "").replace(/^@/, "") || trimmed,
    channelId: null,
    addedAt: new Date().toISOString(),
  };
  creators.push(creator);
  await saveCreators(creators);
  return { creator, added: true };
}

export async function removeCreator(id: string): Promise<boolean> {
  const creators = await listCreators();
  const remaining = creators.filter((c) => c.id !== id);
  if (remaining.length === creators.length) return false;
  await saveCreators(remaining);
  return true;
}

/** Persist what a scrape learned about a creator (resolved id, real title, or
 *  the error that stopped it) without disturbing the rest of the list. */
export async function updateCreator(
  id: string,
  patch: Partial<Omit<Creator, "id">>
): Promise<void> {
  const creators = await listCreators();
  const creator = creators.find((c) => c.id === id);
  if (!creator) return;
  Object.assign(creator, patch);
  if (patch.lastError === undefined && "lastError" in patch) {
    delete creator.lastError;
  }
  await saveCreators(creators);
}
