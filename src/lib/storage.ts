import { FORMAT_LABELS, type ScanRecord } from "@/types/scanner";

const DB_NAME = "warehouse_scanner_db";
const DB_VERSION = 1;
const STORE_NAME = "scans";
const LS_BACKUP_KEY = "warehouse_scans_backup";

function writeLocalStorageBackup(records: ScanRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(records));
  } catch {
    // localStorage dolu veya erişilemez olabilir
  }
}

function readLocalStorageBackup(): ScanRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_BACKUP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScanRecord[];
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => b.timestamp - a.timestamp)
      : [];
  } catch {
    return [];
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB desteklenmiyor"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("barcode", "barcode", { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB açılamadı"));
  });
}

async function getAllFromIDB(): Promise<ScanRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const rows = (request.result as ScanRecord[]) ?? [];
      resolve(rows.sort((a, b) => b.timestamp - a.timestamp));
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Okuma kayıtları alınamadı"));
  });
}

export async function getAllScans(): Promise<ScanRecord[]> {
  try {
    const idbRows = await getAllFromIDB();
    if (idbRows.length > 0) {
      writeLocalStorageBackup(idbRows);
      return idbRows;
    }

    // IDB boşsa ancak localStorage yedeği varsa kurtar
    const backup = readLocalStorageBackup();
    if (backup.length > 0) {
      await saveAllScans(backup);
      return backup;
    }
    return [];
  } catch {
    return readLocalStorageBackup();
  }
}

export async function saveScanRecord(record: ScanRecord): Promise<void> {
  const backup = readLocalStorageBackup();
  const nextBackup = [
    record,
    ...backup.filter((item) => item.id !== record.id),
  ].sort((a, b) => b.timestamp - a.timestamp);
  writeLocalStorageBackup(nextBackup);

  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("Kayıt veritabanına yazılamadı"));
    });
  } catch {
    // localStorage yedeği zaten güncel
  }
}

export async function saveAllScans(records: ScanRecord[]): Promise<void> {
  const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
  writeLocalStorageBackup(sorted);

  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const item of sorted) {
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("Kayıtlar toplu güncellenemedi"));
    });
  } catch {
    // localStorage yedeği güncel
  }
}

export async function deleteScanRecord(id: string): Promise<void> {
  const backup = readLocalStorageBackup().filter((item) => item.id !== id);
  writeLocalStorageBackup(backup);

  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("Kayıt veritabanından silinemedi"));
    });
  } catch {
    // localStorage yedeği güncellendi
  }
}

export async function clearAllScans(): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(LS_BACKUP_KEY);
    } catch {
      // Yoksay
    }
  }

  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("Veritabanı temizlenemedi"));
    });
  } catch {
    // Yoksay
  }
}

export async function markScansSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const current = await getAllScans();
  const updated = current.map((item) =>
    idSet.has(item.id) ? { ...item, synced: true } : item
  );
  await saveAllScans(updated);
}

function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  const escaped = safe.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function exportScansToCSV(scans: ScanRecord[]): void {
  if (typeof window === "undefined" || scans.length === 0) return;

  const header = "ID;Barkod;Urun_Adi;Format;Adet;Tarih_Saat;Senkron_Durumu";
  const rows = scans.map((scan) => {
    const formattedDate = new Date(scan.timestamp).toLocaleString("tr-TR");
    const formatLabel = FORMAT_LABELS[scan.format] ?? scan.format;
    const syncStatus = scan.synced ? "Eşitlendi" : "Bekliyor";
    const productName = scan.productName ?? "-";
    return [
      escapeCsvCell(scan.id),
      escapeCsvCell(scan.barcode),
      escapeCsvCell(productName),
      escapeCsvCell(formatLabel),
      String(scan.quantity),
      escapeCsvCell(formattedDate),
      escapeCsvCell(syncStatus),
    ].join(";");
  });

  // Türkçe Excel uyumluluğu için UTF-8 BOM + noktalı virgül ayracı
  const csvContent = `\uFEFF${[header, ...rows].join("\r\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `depo-sayim-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
