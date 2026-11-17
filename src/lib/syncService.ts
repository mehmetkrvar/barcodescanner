import { markScansSynced } from "@/lib/storage";
import type { ScanRecord } from "@/types/scanner";

export interface SyncResult {
  success: boolean;
  syncedIds: string[];
  syncedAt?: string;
  message: string;
}

export async function syncToServer(scans: ScanRecord[]): Promise<SyncResult> {
  const unsynced = scans.filter((scan) => !scan.synced);

  if (unsynced.length === 0) {
    return {
      success: true,
      syncedIds: [],
      message: "Tüm kayıtlar zaten sunucu ile eşitlenmiş.",
    };
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return {
      success: false,
      syncedIds: [],
      message: "Çevrimdışı moddasınız. Veriler yerel hafızada güvende.",
    };
  }

  try {
    const response = await fetch("/api/scans", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scans: unsynced }),
    });

    if (!response.ok) {
      return {
        success: false,
        syncedIds: [],
        message: `Sunucu hatası (${response.status}). Kayıtlar yerelde korundu.`,
      };
    }

    const data = (await response.json()) as {
      success?: boolean;
      syncedIds?: string[];
      syncedAt?: string;
    };

    const syncedIds = Array.isArray(data.syncedIds)
      ? data.syncedIds
      : unsynced.map((item) => item.id);

    await markScansSynced(syncedIds);

    return {
      success: true,
      syncedIds,
      syncedAt: data.syncedAt,
      message: `${syncedIds.length} kayıt başarıyla eşitlendi.`,
    };
  } catch {
    return {
      success: false,
      syncedIds: [],
      message: "Bağlantı kurulamadı. Veriler yerel depolamada saklanıyor.",
    };
  }
}
