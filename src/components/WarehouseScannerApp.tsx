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
  Package,
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
  findProductByBarcode,
  loadProductCatalog,
} from "@/lib/productCatalog";
import {
  clearAllScans,
  deleteScanRecord,
  exportScansToCSV,
  getAllScans,
  saveAllScans,
  saveScanRecord,
} from "@/lib/storage";
import { syncToServer } from "@/lib/syncService";
import {
  FORMAT_LABELS,
  WAREHOUSE_FORMATS,
  type BarcodeFormatFilter,
  type DecodedBarcodeItem,
  type ProductInfo,
  type ScanMode,
  type ScanRecord,
  type SupportedBarcodeFormat,
} from "@/types/scanner";

const FORMAT_FILTERS: BarcodeFormatFilter[] = ["all", ...WAREHOUSE_FORMATS];

const DEMO_BARCODES: Array<{
  rawValue: string;
  format: SupportedBarcodeFormat;
}> = [
  { rawValue: "8696368011332", format: "ean_13" },
  { rawValue: "8690632020297", format: "ean_13" },
  { rawValue: "8690627023401", format: "ean_13" },
  { rawValue: "90162602", format: "ean_8" },
  { rawValue: "BARKOD-DISI-URUN-99", format: "code_128" },
];

function createRecordId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ProductThumbnail({
  src,
  alt,
  sizeClass = "h-14 w-14",
}: {
  src?: string;
  alt: string;
  sizeClass?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src) return null;

  if (failedSrc === src) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-400 ${sizeClass}`}
      >
        <Package className="h-5 w-5" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className={`shrink-0 rounded-xl border border-zinc-700 bg-white object-contain p-0.5 ${sizeClass}`}
    />
  );
}

function QuantityEditor({
  quantity,
  onAdjust,
  onSetExact,
  compact = false,
}: {
  quantity: number;
  onAdjust: (delta: number) => void;
  onSetExact: (nextQty: number) => void;
  compact?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(String(quantity));

  const btnSize = compact ? "h-10 w-10" : "h-11 w-10";
  const inputSize = compact ? "h-10 w-14 text-base" : "h-11 w-16 text-lg";

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label="Adet azalt"
        onClick={() => onAdjust(-1)}
        disabled={quantity <= 1}
        className={`flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-100 active:scale-95 disabled:opacity-40 ${btnSize}`}
      >
        <Minus className="h-4 w-4" />
      </button>

      <div className="flex flex-col items-center">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          aria-label="Doğrudan adet gir"
          value={isEditing ? draft : String(quantity)}
          onFocus={(e) => {
            setIsEditing(true);
            setDraft(String(quantity));
            e.currentTarget.select();
          }}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const parsed = parseInt(raw, 10);
            if (!Number.isNaN(parsed) && parsed >= 1) {
              onSetExact(parsed);
            }
          }}
          onBlur={() => {
            setIsEditing(false);
            const parsed = parseInt(draft, 10);
            if (!Number.isNaN(parsed) && parsed >= 1 && parsed !== quantity) {
              onSetExact(parsed);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          className={`rounded-xl border border-zinc-700 bg-zinc-950 text-center font-mono font-black text-emerald-400 focus:border-emerald-400 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${inputSize}`}
        />
        {!compact && (
          <span className="mt-0.5 text-[9px] font-semibold uppercase text-zinc-400">
            Adet Gir
          </span>
        )}
      </div>

      <button
        type="button"
        aria-label="Adet artır"
        onClick={() => onAdjust(1)}
        className={`flex items-center justify-center rounded-xl bg-emerald-500 text-zinc-950 active:scale-95 ${btnSize}`}
      >
        <Plus className="h-4 w-4 stroke-[2.5]" />
      </button>
    </div>
  );
}

export default function WarehouseScannerApp() {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [formatFilter, setFormatFilter] = useState<BarcodeFormatFilter>("all");
  const [scanMode, setScanMode] = useState<ScanMode>("serial");
  const [muted, setMuted] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [catalogCount, setCatalogCount] = useState(0);

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
  const catalogRef = useRef<Map<string, ProductInfo> | null>(null);
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

  // İlk yüklemede yerel depolamadan kayıtları ve product.json kataloğunu getir
  useEffect(() => {
    let active = true;

    void Promise.all([getAllScans(), loadProductCatalog()]).then(
      ([loadedScans, catalog]) => {
        if (!active) return;

        catalogRef.current = catalog;
        setCatalogCount(catalog.size);

        let enrichedAny = false;
        const enriched = loadedScans.map((record) => {
          if (record.productName) return record;
          const match = findProductByBarcode(record.barcode, catalog);
          if (!match) return record;
          enrichedAny = true;
          return {
            ...record,
            productName: match.name,
            productImage: match.picURL,
          };
        });

        scansRef.current = enriched;
        setScans(enriched);
        if (enrichedAny) {
          void saveAllScans(enriched);
        }
      }
    );

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
        active = false;
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }

    return () => {
      active = false;
    };
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

      const product = findProductByBarcode(item.rawValue, catalogRef.current);
      const now = Date.now();
      let updatedRecord: ScanRecord;
      let nextList: ScanRecord[];

      if (existing) {
        updatedRecord = {
          ...existing,
          quantity: existing.quantity + 1,
          timestamp: now,
          synced: false,
          productName: existing.productName ?? product?.name,
          productImage: existing.productImage ?? product?.picURL,
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
          productName: product?.name,
          productImage: product?.picURL,
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
    liveDetected,
    isTriggerArmed,
    triggerScan,
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

  const updateRecordQuantity = useCallback((id: string, nextQty: number) => {
    const safeQty = Math.max(1, Math.floor(nextQty));
    const target = scansRef.current.find((r) => r.id === id);
    if (!target || target.quantity === safeQty) return;

    const updated: ScanRecord = {
      ...target,
      quantity: safeQty,
      timestamp: Date.now(),
      synced: false,
    };

    const nextList = scansRef.current.map((r) => (r.id === id ? updated : r));
    scansRef.current = nextList;
    setScans(nextList);
    void saveScanRecord(updated);
  }, []);

  const handleAdjustQuantity = useCallback(
    (id: string, delta: number) => {
      soundSynthesizer.unlock();
      playClickTick(mutedRef.current);
      const target = scansRef.current.find((r) => r.id === id);
      if (!target) return;
      updateRecordQuantity(id, Math.max(1, target.quantity + delta));
    },
    [updateRecordQuantity]
  );

  const handleSetExactQuantity = useCallback(
    (id: string, nextQty: number) => {
      soundSynthesizer.unlock();
      updateRecordQuantity(id, nextQty);
    },
    [updateRecordQuantity]
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

  const handleTriggerButtonPress = useCallback(() => {
    soundSynthesizer.unlock();
    playClickTick(mutedRef.current);
    triggerScan();
  }, [triggerScan]);

  const liveProduct = useMemo(() => {
    if (!liveDetected || catalogCount === 0) return null;
    return findProductByBarcode(liveDetected.rawValue, catalogRef.current);
  }, [liveDetected, catalogCount]);

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
      const productName = (item.productName ?? "").toLowerCase();
      return (
        item.barcode.toLowerCase().includes(q) ||
        formatLabel.includes(q) ||
        productName.includes(q)
      );
    });
  }, [scans, searchQuery]);

  const laserLineClasses =
    laserState === "success"
      ? "h-1 bg-emerald-400 shadow-[0_0_20px_5px_rgba(52,211,153,0.95)] scale-y-125"
      : laserState === "duplicate"
        ? "h-1 bg-amber-400 shadow-[0_0_18px_4px_rgba(251,191,36,0.95)]"
        : liveDetected
          ? "h-[3px] bg-emerald-400 shadow-[0_0_14px_3px_rgba(52,211,153,0.85)]"
          : "h-[2px] bg-red-500 shadow-[0_0_12px_2px_rgba(239,68,68,0.85)]";

  const cornerBorderClasses =
    laserState === "success" || liveDetected
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
              title="Kamera olmadan örnek ürün barkodunu test et"
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
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center overflow-hidden pb-24">
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
                ? "TUŞLA OKUMA MODU"
                : `${FORMAT_LABELS[formatFilter]} KİLİTLİ`}
            </div>
          </div>

          {/* Canlı Algılanan Ürün Önizlemesi / Alt Hedef İpucu */}
          {liveDetected ? (
            <div className="mt-3 flex max-w-[85%] items-center gap-2.5 rounded-2xl border border-emerald-400/50 bg-zinc-950/90 px-3 py-2 text-xs shadow-xl backdrop-blur-md">
              {liveProduct?.picURL && (
                <ProductThumbnail
                  src={liveProduct.picURL}
                  alt={liveProduct.name}
                  sizeClass="h-10 w-10"
                />
              )}
              <div className="min-w-0">
                {liveProduct && (
                  <p className="truncate font-bold text-zinc-50">
                    {liveProduct.name}
                  </p>
                )}
                <p className="font-mono text-[11px] font-semibold text-emerald-300">
                  {liveDetected.rawValue} • Okutmak için tuşa basın
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-1.5 rounded-full border border-zinc-800/80 bg-zinc-950/85 px-3.5 py-1.5 text-xs font-medium text-zinc-200 backdrop-blur-sm">
              {laserState === "success" ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-emerald-300">Barkod Okundu!</span>
                </>
              ) : isTriggerArmed ? (
                <span className="animate-pulse text-amber-300">
                  Barkod aranıyor... Barkodu çizgiye tutun
                </span>
              ) : (
                <span>Barkodu çizgiye hizalayın ve BARKOD OKUT tuşuna basın</span>
              )}
            </div>
          )}
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
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-zinc-950/90 p-6 pb-28 text-center backdrop-blur-sm">
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

        {/* BAŞPARMAK DOSTU TETİK BUTONU + DONANIM VE MOD KONTROLLERİ */}
        <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 bg-gradient-to-t from-zinc-950 via-zinc-950/90 to-transparent px-3 pt-6 pb-2.5">
          {/* BÜYÜK BARKOD OKUT BUTONU */}
          <button
            type="button"
            onClick={handleTriggerButtonPress}
            disabled={!isActive}
            className={`flex w-full items-center justify-center gap-2.5 rounded-2xl py-3.5 text-sm font-black tracking-wide transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 ${
              isTriggerArmed
                ? "animate-pulse border-2 border-amber-300 bg-amber-400 text-zinc-950 shadow-[0_0_24px_rgba(251,191,36,0.45)]"
                : liveDetected
                  ? "bg-emerald-400 text-zinc-950 shadow-[0_0_25px_rgba(52,211,153,0.55)] ring-2 ring-emerald-300/70"
                  : "bg-emerald-500 text-zinc-950 shadow-lg"
            }`}
          >
            <ScanBarcode className="h-5 w-5 stroke-[2.5]" />
            <span>
              {isTriggerArmed
                ? "ARANİYOR... (İPTAL ET)"
                : liveDetected
                  ? "BARKOD OKUT (+1)"
                  : "BARKOD OKUT"}
            </span>
          </button>

          <div className="flex items-center justify-between gap-2">
            {/* Okuma Modu Geçiş Anahtarı */}
            <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/95 p-1">
              <button
                type="button"
                onClick={() => setScanMode("serial")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors active:scale-95 ${
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
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors active:scale-95 ${
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
              className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-bold transition-all active:scale-95 ${
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

      {/* ALT CANLI OKUMA KARTI & DOĞRUDAN ADET GİRİŞİ & ÇEKMECE */}
      <footer className="z-20 flex flex-col border-t border-zinc-800 bg-zinc-950 px-3 pt-2.5 pb-3">
        {latestScan ? (
          <div className="flex items-center justify-between gap-2.5 rounded-2xl border border-zinc-800 bg-zinc-900 p-2.5 shadow-lg">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {latestScan.productImage && (
                <ProductThumbnail
                  src={latestScan.productImage}
                  alt={latestScan.productName ?? latestScan.barcode}
                  sizeClass="h-14 w-14"
                />
              )}

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

                {latestScan.productName && (
                  <p className="mt-0.5 line-clamp-1 text-sm font-bold text-zinc-50">
                    {latestScan.productName}
                  </p>
                )}

                <p
                  className={`truncate font-mono font-extrabold tracking-tight ${
                    latestScan.productName
                      ? "text-xs text-zinc-400"
                      : "mt-1 text-base text-zinc-50"
                  }`}
                >
                  {latestScan.barcode}
                </p>
              </div>
            </div>

            {/* Basarak Artırma + Doğrudan Adet Yazma + Sil */}
            <div className="flex shrink-0 items-start gap-1">
              <QuantityEditor
                quantity={latestScan.quantity}
                onAdjust={(delta) => handleAdjustQuantity(latestScan.id, delta)}
                onSetExact={(qty) => handleSetExactQuantity(latestScan.id, qty)}
              />

              <button
                type="button"
                aria-label="Kaydı sil"
                onClick={() => handleDeleteRecord(latestScan.id)}
                className="flex h-11 w-9 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 active:scale-95"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/50 px-4 py-3 text-xs text-zinc-400">
            <span>
              Barkodu çizgiye hizalayın ve <strong>BARKOD OKUT</strong> tuşuna
              basın.
            </span>
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
                placeholder="Barkod veya ürün adı ara..."
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
                    : "Arama kriterine uygun ürün bulunamadı."}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {filteredScans.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2.5 rounded-2xl border border-zinc-800 bg-zinc-900 p-3"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      {item.productImage && (
                        <ProductThumbnail
                          src={item.productImage}
                          alt={item.productName ?? item.barcode}
                          sizeClass="h-12 w-12"
                        />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                            {FORMAT_LABELS[item.format] ?? item.format}
                          </span>
                          <span className="text-[11px] text-zinc-400">
                            {new Date(item.timestamp).toLocaleTimeString("tr-TR")}
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

                        {item.productName && (
                          <p className="mt-0.5 line-clamp-1 text-sm font-bold text-zinc-50">
                            {item.productName}
                          </p>
                        )}

                        <p
                          className={`truncate font-mono font-bold ${
                            item.productName
                              ? "text-xs text-zinc-400"
                              : "mt-1 text-base text-zinc-50"
                          }`}
                        >
                          {item.barcode}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <QuantityEditor
                        compact
                        quantity={item.quantity}
                        onAdjust={(delta) => handleAdjustQuantity(item.id, delta)}
                        onSetExact={(qty) =>
                          handleSetExactQuantity(item.id, qty)
                        }
                      />

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
