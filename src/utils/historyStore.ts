import type { GenerationHistoryEntry } from '../types/studio';

const HISTORY_STORAGE_KEY = 'sketch2shape_history_v1';
const DB_NAME = 'sketch2shape_glb_archive_v1';
const STORE_NAME = 'glb_binaries';
const MAX_HISTORY_ITEMS = 20;

function openGlbDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGlbToIndexedDb(entryId: string, buffer: ArrayBuffer): Promise<boolean> {
  try {
    const db = await openGlbDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(buffer, entryId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function loadGlbFromIndexedDb(entryId: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openGlbDatabase();
    const result = await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(entryId);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function deleteGlbFromIndexedDb(entryId: string): Promise<void> {
  try {
    const db = await openGlbDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(entryId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage deletion failure
  }
}

export function loadHistoryEntries(): GenerationHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as GenerationHistoryEntry[];
  } catch {
    return [];
  }
}

export async function saveHistoryEntry(
  entry: GenerationHistoryEntry,
  glbBuffer?: ArrayBuffer | null
): Promise<GenerationHistoryEntry[]> {
  let storedGlb = false;
  if (glbBuffer && glbBuffer.byteLength > 0) {
    storedGlb = await saveGlbToIndexedDb(entry.id, glbBuffer);
  }

  const finalEntry: GenerationHistoryEntry = {
    ...entry,
    hasStoredGlb: storedGlb,
  };

  const existing = loadHistoryEntries().filter((item) => item.id !== entry.id);
  const updated = [finalEntry, ...existing];

  // Evict oldest items beyond MAX_HISTORY_ITEMS
  if (updated.length > MAX_HISTORY_ITEMS) {
    const evicted = updated.slice(MAX_HISTORY_ITEMS);
    for (const stale of evicted) {
      if (stale.hasStoredGlb) {
        await deleteGlbFromIndexedDb(stale.id);
      }
    }
  }

  const trimmed = updated.slice(0, MAX_HISTORY_ITEMS);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Fallback if localStorage quota is tight
  }
  return trimmed;
}

export async function removeHistoryEntry(entryId: string): Promise<GenerationHistoryEntry[]> {
  await deleteGlbFromIndexedDb(entryId);
  const next = loadHistoryEntries().filter((e) => e.id !== entryId);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
  return next;
}

export async function clearAllHistory(): Promise<void> {
  const existing = loadHistoryEntries();
  for (const item of existing) {
    if (item.hasStoredGlb) {
      await deleteGlbFromIndexedDb(item.id);
    }
  }
  localStorage.removeItem(HISTORY_STORAGE_KEY);
}

export async function computeBlobSha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
