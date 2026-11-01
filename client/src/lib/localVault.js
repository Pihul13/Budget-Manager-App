const DATABASE_NAME = "personal-finance-local";
const STORE_NAME = "vault";
const RECORD_KEY = "private-finance-data";
const COLLECTIONS = [
  "accounts",
  "categories",
  "transactions",
  "budgets",
  "goals",
  "recurring",
  "settings",
  "funds",
];
const ITERATIONS = 310_000;
export const NO_CHANGE = Symbol("no-local-data-change");

let databasePromise;
let data = null;
let encryptionKey = null;
let writeQueue = Promise.resolve();
let generation = 0;

function openDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("This browser does not support local storage."));
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Local storage is busy. Close other app tabs and try again."));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function readRecord() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(record) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function clearLegacyCache() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("personal-finance-cache");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close older Budget Manager tabs before creating this local vault."));
  });
}

function defaultData() {
  return Object.fromEntries(COLLECTIONS.map((collection) => [collection, []]));
}

function validateBackup(payload) {
  if (
    payload?.version !== 1 ||
    !payload.data ||
    typeof payload.data !== "object" ||
    Array.isArray(payload.data) ||
    COLLECTIONS.some((collection) => !Array.isArray(payload.data[collection])) ||
    Object.values(payload.data).some((rows) =>
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)),
    )
  ) {
    throw new Error("Invalid backup file.");
  }
  return Object.fromEntries(
    COLLECTIONS.map((collection) => [
      collection,
      payload.data[collection].map(({ userId, __v, ...row }) => row),
    ]),
  );
}

async function deriveKey(pin, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(payload, key, iv) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return Array.from(new Uint8Array(ciphertext));
}

async function decrypt(ciphertext, key, iv) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    new Uint8Array(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function getVaultStatus() {
  const record = await readRecord();
  return record ? "locked" : "setup";
}

export async function setupVault(pin, backup = null) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure local encryption is unavailable in this browser.");
  }
  if (typeof pin !== "string" || pin.length < 10) {
    throw new Error("Choose a passphrase with at least 10 characters.");
  }
  const initialData = backup ? validateBackup(backup) : defaultData();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ciphertext = await encrypt(initialData, key, iv);
  await clearLegacyCache();
  await writeRecord({
    id: RECORD_KEY,
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext,
  });
  data = initialData;
  encryptionKey = key;
  generation += 1;
}

export async function unlockVault(pin) {
  const record = await readRecord();
  if (!record) throw new Error("Local app is not set up yet.");
  try {
    const key = await deriveKey(pin, new Uint8Array(record.salt));
    const decrypted = await decrypt(
      record.ciphertext,
      key,
      new Uint8Array(record.iv),
    );
    data = validateBackup({ version: 1, data: decrypted });
    encryptionKey = key;
    generation += 1;
  } catch {
    throw new Error("That passphrase is incorrect, or the local data is damaged.");
  }
}

export function lockVault() {
  generation += 1;
  data = null;
  encryptionKey = null;
  writeQueue = Promise.resolve();
}

export function isVaultUnlocked() {
  return data !== null && encryptionKey !== null;
}

export async function readLocalData() {
  if (!isVaultUnlocked()) throw new Error("Unlock the local app first.");
  return structuredClone(data);
}

export function updateLocalData(update) {
  const operation = writeQueue.then(async () => {
    if (!isVaultUnlocked()) throw new Error("Unlock the local app first.");
    const currentGeneration = generation;
    const currentKey = encryptionKey;
    const next = structuredClone(data);
    const result = await update(next);
    if (result === NO_CHANGE) return null;
    if (currentGeneration !== generation) {
      throw new Error("The local vault was locked before the change was saved.");
    }
    const record = await readRecord();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await encrypt(next, currentKey, iv);
    if (currentGeneration !== generation) {
      throw new Error("The local vault was locked before the change was saved.");
    }
    await writeRecord({ ...record, iv: Array.from(iv), ciphertext });
    if (currentGeneration === generation) data = next;
    return structuredClone(result);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function exportLocalBackup() {
  const localData = await readLocalData();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: localData,
  };
}

export async function importLocalBackup(payload) {
  const imported = validateBackup(payload);
  return updateLocalData((current) => {
    Object.assign(current, imported);
    return { ok: true };
  });
}

export function changeVaultPassphrase(currentPin, nextPin) {
  const operation = writeQueue.then(async () => {
    if (!isVaultUnlocked()) throw new Error("Unlock the local app first.");
    if (typeof nextPin !== "string" || nextPin.length < 10) {
      throw new Error("Choose a passphrase with at least 10 characters.");
    }
    const currentGeneration = generation;
    const record = await readRecord();
    const verifiedKey = await deriveKey(currentPin, new Uint8Array(record.salt));
    const decrypted = await decrypt(
      record.ciphertext,
      verifiedKey,
      new Uint8Array(record.iv),
    ).catch(() => {
      throw new Error("Current passphrase is incorrect.");
    });
    const nextSalt = crypto.getRandomValues(new Uint8Array(16));
    const nextIv = crypto.getRandomValues(new Uint8Array(12));
    const nextKey = await deriveKey(nextPin, nextSalt);
    const ciphertext = await encrypt(decrypted, nextKey, nextIv);
    if (currentGeneration !== generation) {
      throw new Error("The local vault was locked before the passphrase changed.");
    }
    await writeRecord({
      id: RECORD_KEY,
      salt: Array.from(nextSalt),
      iv: Array.from(nextIv),
      ciphertext,
    });
    if (currentGeneration === generation) {
      data = validateBackup({ version: 1, data: decrypted });
      encryptionKey = nextKey;
    }
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function createLocalId() {
  return crypto.randomUUID();
}
