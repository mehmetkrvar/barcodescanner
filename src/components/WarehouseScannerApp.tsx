"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CameraOff,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudOff,
  Download,
  Flashlight,
  FlashlightOff,
  Layers,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Repeat,
  ScanBarcode,
  Search,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
  ZoomIn,
} from "lucide-react";
import {
  useWarehouseScanner,
  type DetectionOutcome,
} from "@/hooks/useWarehouseScanner";
import {
  playClickTick,
  playDuplicateWarningBeep,
  playSuccessBeep,
  soundSynthesizer,
} from "@/lib/audioFeedback";
import {
  clearAllScans,
  deleteScanRecord,
  exportScansToCSV,
  getAllScans,
  saveScanRecord,
} from "@/lib/storage";
import { syncToServer } from "@/lib/syncService";
import {
  FORMAT_LABELS,
  WAREHOUSE_FORMATS,
  type BarcodeFormatFilter,
  type DecodedBarcodeItem,
  type ScanMode,
  type ScanRecord,
  type SupportedBarcodeFormat,
} from "@/types/scanner";

const FORMAT_FILTERS: BarcodeFormatFilter[] = ["all", ...WAREHOUSE_FORMATS];

const DEMO_BARCODES: Array<{
  rawValue: string;
  format: SupportedBarcodeFormat;
}> = [
  { rawValue: "8690504012345", format: "ean_13" },
  { rawValue: "DEPO-RAF-A12-0048", format: "code_128" },
  { rawValue: "PALET-2026-8841", format: "code_39" },
  { rawValue: "https://depo.local/sku/90421", format: "qr_code" },
  { rawValue: "86912348", format: "ean_8" },
  { rawValue: "036000291452", format: "upc_a" },
];

function createRecordId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function WarehouseScannerApp() {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [formatFilter, setFormatFilter] = useState<BarcodeFormatFilter>("all");
  const [scanMode, setScanMode] = useState<ScanMode>("serial");
  const [muted, setMuted] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [statusBanner, setStatusBanner] = useState<{
    type: "info" | "success" | "warning";
    text: string;
  } | null>(null);

  const scansRef = useRef<ScanRecord[]>([]);
  const scanModeRef = useRef<ScanMode>(scanMode);
  const mutedRef = useRef<boolean>(muted);
  const bannerTimerRef = useRef<number | null>(null);
  const demoIndexRef = useRef<number>(0);

  scansRef.current = scans;
  scanModeRef.current = scanMode;
  mutedRef.current = muted;

  const showStatusBanner = useCallback(
    (type: "info" | "success" | "warning", text: string, durationMs = 2600) => {
      if (bannerTimerRef.current !== null) {
        window.clearTimeout(bannerTimerRef.current);
      }
      setStatusBanner({ type, text });
      bannerTimerRef.current = window.setTimeout(() => {
        setStatusBanner(null);
        bannerTimerRef.current = null;
      }, durationMs);
    },
    []
  );

  // İlk yüklemede yerel depolamadan kayıtları getir
  useEffect(() => {
    void getAllScans().then((loaded) => {
      setScans(loaded);
    });

    if (typeof window !== "undefined") {
      setIsOnline(window.navigator.onLine);
      const handleOnline = () => {
        setIsOnline(true);
        showStatusBanner("success", "İnternet bağlantısı geri geldi. Eşitlemeye hazır.");
      };
      const handleOffline = () => {
        setIsOnline(false);
        showStatusBanner(
          "info",
          "Çevrimdışı Hazır: Tüm okumalar cihaz hafızasına kaydediliyor."
        );
      };

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }
  }, [showStatusBanner]);

  const handleBarcodeDetected = useCallback(
    (item: DecodedBarcodeItem): DetectionOutcome => {
      const currentScans = scansRef.current;
      const existing = currentScans.find(
        (record) => record.barcode === item.rawValue
      );

      if (scanModeRef.current === "single" && existing) {
        playDuplicateWarningBeep(mutedRef.current);
        showStatusBanner(
          "warning",
          `Mükerrer Barkod: ${item.rawValue} zaten okutuldu!`,
          2800
        );
        return "duplicate";
      }

      const now = Date.now();
      let updatedRecord: ScanRecord;
      let nextList: ScanRecord[];

      if (existing) {
        updatedRecord = {
          ...existing,
          quantity: existing.quantity + 1,
          timestamp: now,
          synced: false,
        };
        nextList = [
          updatedRecord,
          ...currentScans.filter((r) => r.id !== existing.id),
        ];
      } else {
        updatedRecord = {
          id: createRecordId(),
          barcode: item.rawValue,
          format: item.format,
          quantity: 1,
          timestamp: now,
          synced: false,
        };
        nextList = [updatedRecord, ...currentScans];
      }

      scansRef.current = nextList;
      setScans(nextList);
      void saveScanRecord(updatedRecord);
      playSuccessBeep(mutedRef.current);
      return "accepted";
    },
    [showStatusBanner]
  );

  const {
    videoRef,
    roiRef,
    isStarting,
    isActive,
    error,
    laserState,
    telemetry,
    hasTorch,
    torchOn,
    zoom,
    digitalZoomScale,
    toggleTorch,
    setZoom,
    restartCamera,
    triggerLaserFeedback,
  } = useWarehouseScanner({
    formatFilter,
    paused: drawerOpen || confirmClearOpen,
    onDetected: handleBarcodeDetected,
  });

  const handleUnlockAudio = useCallback(() => {
    soundSynthesizer.unlock();
  }, []);

  const handleAdjustQuantity = useCallback(
    (id: string, delta: number) => {
      soundSynthesizer.unlock();
      playClickTick(mutedRef.current);

      const target = scansRef.current.find((r) => r.id === id);
      if (!target) return;

      const nextQty = Math.max(1, target.quantity + delta);
      if (nextQty === target.quantity) return;

      const updated: ScanRecord = {
        ...target,
        quantity: nextQty,
        timestamp: Date.now(),
        synced: false,
      };

      const nextList = scansRef.current.map((r) => (r.id === id ? updated : r));
      scansRef.current = nextList;
      setScans(nextList);
      void saveScanRecord(updated);
    },
    []
  );

  const handleDeleteRecord = useCallback((id: string) => {
    soundSynthesizer.unlock();
    playClickTick(mutedRef.current);

    const nextList = scansRef.current.filter((r) => r.id !== id);
    scansRef.current = nextList;
    setScans(nextList);
    void deleteScanRecord(id);
  }, []);

  const handleClearConfirmed = useCallback(async () => {
    soundSynthesizer.unlock();
    await clearAllScans();
    scansRef.current = [];
    setScans([]);
    setConfirmClearOpen(false);
    setDrawerOpen(false);
    showStatusBanner("info", "Tüm okuma listesi temizlendi.");
  }, [showStatusBanner]);

  const handleSync = useCallback(async () => {
    soundSynthesizer.unlock();
    if (isSyncing) return;
    setIsSyncing(true);
    const result = await syncToServer(scansRef.current);
    if (result.success && result.syncedIds.length > 0) {
      const syncedSet = new Set(result.syncedIds);
      const nextList = scansRef.current.map((item) =>
        syncedSet.has(item.id) ? { ...item, synced: true } : item
      );
      scansRef.current = nextList;
      setScans(nextList);
    }
    setIsSyncing(false);
    showStatusBanner(result.success ? "success" : "warning", result.message);
  }, [isSyncing, showStatusBanner]);

  const handleSimulateScan = useCallback(() => {
    soundSynthesizer.unlock();
    const sample = DEMO_BARCODES[demoIndexRef.current % DEMO_BARCODES.length];
    demoIndexRef.current += 1;

    const outcome = handleBarcodeDetected(sample);
    if (outcome === "accepted") {
      triggerLaserFeedback("success");
    } else if (outcome === "duplicate") {
      triggerLaserFeedback("duplicate");
    }
  }, [handleBarcodeDetected, triggerLaserFeedback]);

  const latestScan = scans[0] ?? null;

  const { totalUnits, unsyncedCount } = useMemo(() => {
    let units = 0;
    let unsynced = 0;
    for (const item of scans) {
      units += item.quantity;
      if (!item.synced) unsynced += 1;
    }
    return { totalUnits: units, unsyncedCount: unsynced };
  }, [scans]);

  const filteredScans = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return scans;
    return scans.filter((item) => {
      const formatLabel = (FORMAT_LABELS[item.format] ?? item.format).toLowerCase();
      return (
        item.barcode.toLowerCase().includes(q) || formatLabel.includes(q)
      );
    });
  }, [scans, searchQuery]);

  const laserLineClasses =
    laserState === "success"
      ? "h-1 bg-emerald-400 shadow-[0_0_20px_5px_rgba(52,211,153,0.95)] scale-y-125"
      : laserState === "duplicate"
        ? "h-1 bg-amber-400 shadow-[0_0_18px_4px_rgba(251,191,36,0.95)]"
        : "h-[2px] bg-red-500 shadow-[0_0_12px_2px_rgba(239,68,68,0.85)]";

  const cornerBorderClasses =
    laserState === "success"
      ? "border-emerald-400"
      : laserState === "duplicate"
        ? "border-amber-400"
        : "border-zinc-100";

  return (
    <div
      onPointerDown={handleUnlockAudio}
      className="relative flex h-dvh w-full flex-col overflow-hidden bg-zinc-950 text-zinc-50 select-none"
    >
      {/* ÜST DURUM & TELEMETRİ ÇUBUĞU */}
      <header className="z-20 flex flex-col gap-2 border-b border-zinc-800/80 bg-zinc-950/90 px-3 pt-2.5 pb-2 backdrop-blur-md">
        <div className="flex items-center justify-between gap-2">
          {/* Çevrimiçi / Çevrimdışı Durumu + Eşitle */}
          <div className="flex items-center gap-1.5">
            <div
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                isOnline
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/15 text-amber-300"
              }`}
            >
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              <span>{isOnline ? "Çevrimiçi" : "Çevrimdışı Hazır"}</span>
            </div>

            {unsyncedCount > 0 && (
              <button
                type="button"
                onClick={handleSync}
                disabled={isSyncing}
                className="flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300 active:scale-95 disabled:opacity-50"
                title="Bekleyen kayıtları sunucuya gönder"
              >
                <RefreshCw
                  className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`}
                />
                <span>Eşitle ({unsyncedCount})</span>
              </button>
            )}
          </div>

          {/* Performans Telemetrisi & Ses & Test Butonları */}
          <div className="flex items-center gap-1.5">
            <div className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 sm:flex">
              <span className="font-mono text-emerald-400">
                {telemetry.decodeTimeMs > 0
                  ? `${telemetry.decodeTimeMs.toFixed(1)} ms`
                  : "-- ms"}
              </span>
              <span className="text-zinc-600">•</span>
              <span>
                {telemetry.engine === "BarcodeDetector"
                  ? "Native GPU"
                  : telemetry.engine === "ZXing-WASM"
                    ? "ZXing WASM"
                    : "Hazırlanıyor"}
              </span>
              {telemetry.fps > 0 && (
                <>
                  <span className="text-zinc-600">•</span>
                  <span className="font-mono">{telemetry.fps} FPS</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={handleSimulateScan}
              className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-200 active:scale-95"
              title="Kamera olmadan örnek barkod okumasını test et"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span>Test Okut</span>
            </button>

            <button
              type="button"
              onClick={() => setMuted((prev) => !prev)}
              aria-label={muted ? "Sesi Aç" : "Sesi Kapat"}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold active:scale-95 ${
                muted
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-100"
              }`}
            >
              {muted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
              )}
              <span className="hidden xs:inline">
                {muted ? "Sessiz" : "Ses Açık"}
              </span>
            </button>
          </div>
        </div>

        {/* Mobil Kompakt Telemetri Satırı + Format Kilitleme Seçicisi */}
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2 py-1 text-[11px] font-mono text-zinc-300 sm:hidden">
            <span className="text-emerald-400">
              {telemetry.decodeTimeMs > 0
                ? `${telemetry.decodeTimeMs.toFixed(0)}ms`
                : "--ms"}
            </span>
            <span className="text-zinc-600">/</span>
            <span>
              {telemetry.engine === "BarcodeDetector" ? "GPU" : "WASM"}
            </span>
          </div>

          <div
            className="no-scrollbar flex flex-1 items-center gap-1.5 overflow-x-auto py-0.5"
            role="tablist"
            aria-label="Barkod format kilidi"
          >
            {FORMAT_FILTERS.map((fmt) => {
              const active = formatFilter === fmt;
              return (
                <button
                  key={fmt}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFormatFilter(fmt)}
                  className={`flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors active:scale-95 ${
                    active
                      ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-300"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {active && fmt !== "all" && <Lock className="h-3 w-3" />}
                  <span>{FORMAT_LABELS[fmt]}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* TAM EKRAN KAMERA VİZÖRÜ VE ROI HEDEF ÇİZGİSİ */}
      <main className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            transform:
              digitalZoomScale > 1
                ? `scale(${digitalZoomScale})`
                : undefined,
          }}
          className="h-full w-full object-cover transition-transform duration-150 ease-out"
        />

        {/* Merkez %85 x %25 ROI Kutusu + Dış Koyu Yarı Saydam Maske */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center overflow-hidden">
          <div
            ref={roiRef}
            className="relative h-[25%] w-[85%] max-w-2xl rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.68)]"
          >
            {/* 4 Köşebent Hedef İşaretçisi */}
            <span
              className={`absolute -top-0.5 -left-0.5 h-6 w-6 rounded-tl-xl border-t-4 border-l-4 transition-colors duration-100 ${cornerBorderClasses}`}
            />
            <span
              className={`absolute -top-0.5 -right-0.5 h-6 w-6 rounded-tr-xl border-t-4 border-r-4 transition-colors duration-100 ${cornerBorderClasses}`}
            />
            <span
              className={`absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 transition-colors duration-100 ${cornerBorderClasses}`}
            />
            <span
              className={`absolute -right-0.5 -bottom-0.5 h-6 w-6 rounded-br-xl border-r-4 border-b-4 transition-colors duration-100 ${cornerBorderClasses}`}
            />

            {/* Keskin Merkez Lazer Çizgisi */}
            <div className="absolute inset-x-3 top-1/2 -translate-y-1/2">
              <div
                className={`w-full rounded-full transition-all duration-100 ${laserLineClasses}`}
              />
            </div>

            {/* Aktif ROI Etiketi */}
            <div className="absolute top-2 left-3 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-300 backdrop-blur-xs">
              {formatFilter === "all"
                ? "ROI %85×%25"
                : `${FORMAT_LABELS[formatFilter]} KİLİTLİ`}
            </div>
          </div>

          {/* Alt Hedef İpucu */}
          <div className="mt-4 flex items-center gap-1.5 rounded-full border border-zinc-800/80 bg-zinc-950/80 px-3.5 py-1 text-xs font-medium text-zinc-200 backdrop-blur-sm">
            {laserState === "success" ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-300">Barkod Okundu!</span>
              </>
            ) : (
              <span>Barkodu çizgiye hizalayın</span>
            )}
          </div>
        </div>

        {/* Anlık Durum / Mükerrer Barkod Uyarı Bandı */}
        {statusBanner && (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex justify-center">
            <div
              className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold shadow-lg backdrop-blur-md ${
                statusBanner.type === "warning"
                  ? "border-amber-400/60 bg-amber-950/90 text-amber-200"
                  : statusBanner.type === "success"
                    ? "border-emerald-400/50 bg-emerald-950/90 text-emerald-200"
                    : "border-zinc-700 bg-zinc-900/90 text-zinc-100"
              }`}
            >
              {statusBanner.type === "warning" && (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              )}
              {statusBanner.type === "success" && (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              )}
              <span>{statusBanner.text}</span>
            </div>
          </div>
        )}

        {/* Kamera Başlatılıyor veya Hata Durumu Katmanı */}
        {(isStarting || error) && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-zinc-950/90 p-6 text-center backdrop-blur-sm">
            {error ? (
              <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
                  <CameraOff className="h-6 w-6" />
                </div>
                <h2 className="text-base font-bold text-zinc-100">
                  Kamera Başlatılamadı
                </h2>
                <p className="text-xs leading-relaxed text-zinc-400">{error}</p>
                <div className="mt-1 flex w-full gap-2">
                  <button
                    type="button"
                    onClick={() => void restartCamera()}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-zinc-950 active:scale-95"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Tekrar Dene</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSimulateScan}
                    className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 py-2.5 text-xs font-semibold text-zinc-200 active:scale-95"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                    <span>Test Okut</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <ScanBarcode className="h-10 w-10 animate-pulse text-emerald-400" />
                <p className="text-sm font-semibold text-zinc-200">
                  Yüksek hızlı kamera ve çözücü başlatılıyor...
                </p>
                <p className="text-xs text-zinc-400">
                  Lütfen kamera iznini onaylayın
                </p>
              </div>
            )}
          </div>
        )}

        {/* BAŞPARMAK DOSTU DONANIM VE OKUMA MODU KONTROLLERİ */}
        <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 bg-gradient-to-t from-zinc-950 via-zinc-950/85 to-transparent px-3 pt-6 pb-2.5">
          <div className="flex items-center justify-between gap-2">
            {/* Okuma Modu Geçiş Anahtarı */}
            <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/95 p-1">
              <button
                type="button"
                onClick={() => setScanMode("serial")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors active:scale-95 ${
                  scanMode === "serial"
                    ? "bg-emerald-500 text-zinc-950"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Repeat className="h-3.5 w-3.5" />
                <span>Seri Sayım</span>
              </button>
              <button
                type="button"
                onClick={() => setScanMode("single")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors active:scale-95 ${
                  scanMode === "single"
                    ? "bg-amber-400 text-zinc-950"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Tekil Mod</span>
              </button>
            </div>

            {/* Başparmak Erişimli Flaş / Fener Butonu */}
            <button
              type="button"
              onClick={() => void toggleTorch()}
              disabled={!hasTorch || !isActive}
              className={`flex items-center gap-1.5 rounded-xl border px-4 py-2.5 text-xs font-bold transition-all active:scale-95 ${
                torchOn
                  ? "border-amber-300 bg-amber-400 text-zinc-950 shadow-[0_0_15px_rgba(251,191,36,0.4)]"
                  : hasTorch && isActive
                    ? "border-zinc-700 bg-zinc-900 text-zinc-100"
                    : "border-zinc-800/80 bg-zinc-900/60 text-zinc-500"
              }`}
              title={
                hasTorch
                  ? "Karanlık raf araları için flaşı aç/kapat"
                  : "Bu cihazda kamera flaşı algılanmadı"
              }
            >
              {torchOn ? (
                <Flashlight className="h-4 w-4" />
              ) : (
                <FlashlightOff className="h-4 w-4" />
              )}
              <span>{torchOn ? "Flaş Açık" : "Flaş"}</span>
            </button>
          </div>

          {/* Akıcı Yakınlaştırma (1x - 3x) Kaydırıcısı */}
          <div className="flex items-center gap-2.5 rounded-xl border border-zinc-800/90 bg-zinc-900/90 px-3 py-1.5 backdrop-blur-sm">
            <ZoomIn className="h-4 w-4 shrink-0 text-zinc-400" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={zoom}
              aria-label="Kamera yakınlaştırma"
              onChange={(e) => void setZoom(Number(e.target.value))}
              className="h-2 flex-1 cursor-pointer accent-emerald-500"
            />
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => void setZoom(preset)}
                  className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-bold active:scale-95 ${
                    Math.abs(zoom - preset) < 0.15
                      ? "bg-emerald-500/25 text-emerald-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {preset}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>

      {/* ALT CANLI OKUMA KARTI & ÇEKMECE ÖZET ÇUBUĞU */}
      <footer className="z-20 flex flex-col border-t border-zinc-800 bg-zinc-950 px-3 pt-2.5 pb-3">
        {latestScan ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-3 shadow-lg">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                  {FORMAT_LABELS[latestScan.format] ?? latestScan.format}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {new Date(latestScan.timestamp).toLocaleTimeString("tr-TR")}
                </span>
                {latestScan.synced ? (
                  <Cloud className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <CloudOff className="h-3.5 w-3.5 text-amber-400" />
                )}
              </div>
              <p className="mt-1 truncate font-mono text-lg font-extrabold tracking-tight text-zinc-50">
                {latestScan.barcode}
              </p>
            </div>

            {/* Büyük Başparmak Adet Kontrolleri */}
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                aria-label="Adet azalt"
                onClick={() => handleAdjustQuantity(latestScan.id, -1)}
                disabled={latestScan.quantity <= 1}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-100 active:scale-95 disabled:opacity-40"
              >
                <Minus className="h-5 w-5" />
              </button>

              <div className="flex min-w-11 flex-col items-center justify-center px-1">
                <span className="font-mono text-xl font-black text-emerald-400">
                  {latestScan.quantity}
                </span>
                <span className="text-[9px] font-semibold uppercase text-zinc-400">
                  Adet
                </span>
              </div>

              <button
                type="button"
                aria-label="Adet artır"
                onClick={() => handleAdjustQuantity(latestScan.id, 1)}
                className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 active:scale-95"
              >
                <Plus className="h-5 w-5 stroke-[2.5]" />
              </button>

              <button
                type="button"
                aria-label="Kaydı sil"
                onClick={() => handleDeleteRecord(latestScan.id)}
                className="ml-0.5 flex h-11 w-10 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 active:scale-95"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs text-zinc-400">
            <span>Henüz barkod okutulmadı. Kırmızı çizgiyi barkoda tutun.</span>
            <ScanBarcode className="h-5 w-5 shrink-0 text-zinc-600" />
          </div>
        )}

        {/* Alt Liste Çekmecesi Tetikleyici Çubuk */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex flex-1 items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-left active:scale-[0.99]"
          >
            <div className="flex items-center gap-3 text-xs">
              <span className="font-bold text-zinc-100">
                Okunanlar ({scans.length} Kalem)
              </span>
              <span className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono font-bold text-emerald-400">
                Toplam: {totalUnits} Adet
              </span>
            </div>
            <ChevronUp className="h-4 w-4 text-zinc-400" />
          </button>

          <button
            type="button"
            onClick={() => exportScansToCSV(scans)}
            disabled={scans.length === 0}
            className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-xs font-bold text-zinc-100 active:scale-95 disabled:opacity-40"
          >
            <Download className="h-4 w-4 text-emerald-400" />
            <span>Excel İndir</span>
          </button>
        </div>
      </footer>

      {/* GENİŞLETİLEBİLİR LİSTE ÇEKMECESİ */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-zinc-950/95 backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div>
              <h2 className="text-base font-bold text-zinc-50">
                Sayım Listesi ({scans.length} Kalem / {totalUnits} Adet)
              </h2>
              <p className="text-xs text-zinc-400">
                Çevrimdışı kalıcı depo hafızası • {unsyncedCount} eşitlenmemiş
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="flex items-center gap-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-bold text-zinc-200 active:scale-95"
            >
              <ChevronDown className="h-4 w-4" />
              <span>Tarayıcıya Dön</span>
            </button>
          </div>

          {/* Arama Çubuğu */}
          <div className="border-b border-zinc-800/80 px-4 py-2.5">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-3 h-4 w-4 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Barkod ara..."
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2.5 pr-9 pl-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Aramayı temizle"
                  className="absolute right-2.5 rounded-full p-1 text-zinc-400 hover:text-zinc-200"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Kayıt Listesi */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {filteredScans.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
                <ScanBarcode className="h-8 w-8 text-zinc-700" />
                <p>
                  {scans.length === 0
                    ? "Henüz okutulmuş ürün bulunmuyor."
                    : "Arama kriterine uygun barkod bulunamadı."}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {filteredScans.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                          {FORMAT_LABELS[item.format] ?? item.format}
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          {new Date(item.timestamp).toLocaleString("tr-TR")}
                        </span>
                        {item.synced ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                            <Cloud className="h-3 w-3" />
                            Eşitlendi
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400">
                            <CloudOff className="h-3 w-3" />
                            Yerel
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate font-mono text-base font-bold text-zinc-50">
                        {item.barcode}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label="Adet azalt"
                        onClick={() => handleAdjustQuantity(item.id, -1)}
                        disabled={item.quantity <= 1}
                        className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-100 active:scale-95 disabled:opacity-40"
                      >
                        <Minus className="h-4 w-4" />
                      </button>

                      <span className="min-w-9 text-center font-mono text-lg font-extrabold text-emerald-400">
                        {item.quantity}
                      </span>

                      <button
                        type="button"
                        aria-label="Adet artır"
                        onClick={() => handleAdjustQuantity(item.id, 1)}
                        className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 active:scale-95"
                      >
                        <Plus className="h-4 w-4 stroke-[2.5]" />
                      </button>

                      <button
                        type="button"
                        aria-label="Satırı sil"
                        onClick={() => handleDeleteRecord(item.id)}
                        className="flex h-10 w-9 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 active:scale-95"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Alt Dışa Aktarma & Eşitleme & Temizleme Butonları */}
          <div className="grid grid-cols-3 gap-2 border-t border-zinc-800 bg-zinc-950 p-3">
            <button
              type="button"
              onClick={() => exportScansToCSV(scans)}
              disabled={scans.length === 0}
              className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-3 text-xs font-extrabold text-zinc-950 active:scale-95 disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              <span>Excel İndir</span>
            </button>

            <button
              type="button"
              onClick={handleSync}
              disabled={scans.length === 0 || isSyncing}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/15 px-3 py-3 text-xs font-bold text-sky-300 active:scale-95 disabled:opacity-40"
            >
              <RefreshCw
                className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`}
              />
              <span>Sunucuya Aktar</span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              disabled={scans.length === 0}
              className="flex items-center justify-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/15 px-3 py-3 text-xs font-bold text-rose-300 active:scale-95 disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
              <span>Listeyi Temizle</span>
            </button>
          </div>
        </div>
      )}

      {/* LİSTEYİ TEMİZLEME ONAY MODALI */}
      {confirmClearOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-modal-title"
            className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500/20 text-rose-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <h3
                id="clear-modal-title"
                className="text-base font-bold text-zinc-50"
              >
                Tüm listeyi silmek istediğinize emin misiniz?
              </h3>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              Cihaz hafızasındaki {scans.length} kalem ({totalUnits} adet ürün)
              kalıcı olarak silinecektir. Bu işlem geri alınamaz.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmClearOpen(false)}
                className="flex-1 rounded-xl border border-zinc-700 bg-zinc-800 py-2.5 text-xs font-bold text-zinc-200 active:scale-95"
              >
                Vazgeç
              </button>
              <button
                type="button"
                onClick={() => void handleClearConfirmed()}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white active:scale-95"
              >
                Evet, Tümünü Sil
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
