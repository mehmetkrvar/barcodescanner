import {
  prepareZXingModule,
  readBarcodes,
  type ReadInputBarcodeFormat,
} from "zxing-wasm/reader";
import {
  WAREHOUSE_FORMATS,
  type BarcodeFormatFilter,
  type DecodedBarcodeItem,
  type SolverEngine,
  type SupportedBarcodeFormat,
  type WorkerRequest,
  type WorkerResponse,
} from "@/types/scanner";

interface NativeDetectedBarcode {
  rawValue?: string;
  format?: string;
}

interface NativeBarcodeDetector {
  detect(image: ImageBitmapSource): Promise<NativeDetectedBarcode[]>;
}

interface NativeBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

const TO_ZXING_FORMAT: Record<SupportedBarcodeFormat, ReadInputBarcodeFormat> = {
  ean_13: "EAN13",
  ean_8: "EAN8",
  code_128: "Code128",
  code_39: "Code39",
  qr_code: "QRCode",
  upc_a: "UPCA",
};

const FROM_ZXING_FORMAT: Record<string, SupportedBarcodeFormat> = {
  EAN13: "ean_13",
  "EAN-13": "ean_13",
  EAN8: "ean_8",
  "EAN-8": "ean_8",
  Code128: "code_128",
  "Code 128": "code_128",
  Code39: "code_39",
  "Code 39": "code_39",
  Code39Std: "code_39",
  Code39Ext: "code_39",
  QRCode: "qr_code",
  "QR Code": "qr_code",
  QRCodeModel1: "qr_code",
  QRCodeModel2: "qr_code",
  MicroQRCode: "qr_code",
  RMQRCode: "qr_code",
  UPCA: "upc_a",
  "UPC-A": "upc_a",
};

const WAREHOUSE_FORMAT_SET = new Set<string>(WAREHOUSE_FORMATS);

let activeEngine: SolverEngine | null = null;
let nativeDetectorCache: Map<BarcodeFormatFilter, NativeBarcodeDetector> =
  new Map();
let zxingReadyPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;

let cropCanvas: OffscreenCanvas | null = null;
let cropCtx: OffscreenCanvasRenderingContext2D | null = null;

function postWorkerMessage(message: WorkerResponse): void {
  self.postMessage(message);
}

function getTargetFormats(
  filter: BarcodeFormatFilter
): SupportedBarcodeFormat[] {
  return filter === "all" ? [...WAREHOUSE_FORMATS] : [filter];
}

function ensureCropContext(
  width: number,
  height: number
): OffscreenCanvasRenderingContext2D {
  if (!cropCanvas) {
    cropCanvas = new OffscreenCanvas(width, height);
    cropCtx = cropCanvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    });
  } else if (cropCanvas.width !== width || cropCanvas.height !== height) {
    cropCanvas.width = width;
    cropCanvas.height = height;
  }

  if (!cropCtx) {
    cropCtx = cropCanvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    });
  }

  if (!cropCtx) {
    throw new Error("OffscreenCanvas 2D bağlamı oluşturulamadı.");
  }

  return cropCtx;
}

async function ensureZXingReady(): Promise<void> {
  if (!zxingReadyPromise) {
    const origin =
      typeof self !== "undefined" && self.location?.origin
        ? self.location.origin
        : "";

    zxingReadyPromise = prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => {
          if (path.endsWith(".wasm")) {
            return `${origin}/wasm/zxing_reader.wasm`;
          }
          return `${prefix}${path}`;
        },
      },
      fireImmediately: true,
    }).then(() => undefined);
  }
  await zxingReadyPromise;
}

async function initializeEngine(
  formatFilter: BarcodeFormatFilter
): Promise<SolverEngine> {
  const DetectorCtor = (
    globalThis as unknown as {
      BarcodeDetector?: NativeBarcodeDetectorConstructor;
    }
  ).BarcodeDetector;

  if (DetectorCtor) {
    try {
      const supported = DetectorCtor.getSupportedFormats
        ? await DetectorCtor.getSupportedFormats()
        : [...WAREHOUSE_FORMATS];

      const allWarehouseSupported = WAREHOUSE_FORMATS.every((fmt) =>
        supported.includes(fmt)
      );

      if (allWarehouseSupported) {
        const detector = new DetectorCtor({
          formats: getTargetFormats(formatFilter),
        });
        nativeDetectorCache.set(formatFilter, detector);
        activeEngine = "BarcodeDetector";
        return activeEngine;
      }
    } catch {
      // Native BarcodeDetector başarısız oldu, WASM'a geç
    }
  }

  await ensureZXingReady();
  activeEngine = "ZXing-WASM";
  return activeEngine;
}

function getNativeDetector(
  filter: BarcodeFormatFilter
): NativeBarcodeDetector {
  let detector = nativeDetectorCache.get(filter);
  if (!detector) {
    const DetectorCtor = (
      globalThis as unknown as {
        BarcodeDetector?: NativeBarcodeDetectorConstructor;
      }
    ).BarcodeDetector;
    if (!DetectorCtor) {
      throw new Error("BarcodeDetector kullanılamıyor");
    }
    detector = new DetectorCtor({
      formats: getTargetFormats(filter),
    });
    nativeDetectorCache.set(filter, detector);
  }
  return detector;
}

function normalizeNativeFormat(
  rawFormat: string | undefined
): SupportedBarcodeFormat | null {
  if (!rawFormat) return null;
  if (WAREHOUSE_FORMAT_SET.has(rawFormat)) {
    return rawFormat as SupportedBarcodeFormat;
  }
  return null;
}

async function decodeWithZXing(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  formatFilter: BarcodeFormatFilter
): Promise<DecodedBarcodeItem[]> {
  await ensureZXingReady();
  const imageData = ctx.getImageData(0, 0, width, height);
  const zxingFormats = getTargetFormats(formatFilter).map(
    (fmt) => TO_ZXING_FORMAT[fmt]
  );

  const results = await readBarcodes(imageData, {
    formats: zxingFormats,
    tryHarder: true,
    tryRotate: true,
    tryInvert: false,
    tryDownscale: false,
    binarizer: "LocalAverage",
    maxNumberOfSymbols: 2,
  });

  const decoded: DecodedBarcodeItem[] = [];
  for (const item of results) {
    if (!item.isValid || !item.text) continue;
    const mappedFormat = FROM_ZXING_FORMAT[item.format];
    if (!mappedFormat) continue;
    if (formatFilter !== "all" && mappedFormat !== formatFilter) continue;
    decoded.push({
      rawValue: item.text,
      format: mappedFormat,
    });
  }

  return decoded;
}

async function handleInit(formatFilter: BarcodeFormatFilter): Promise<void> {
  if (!initPromise) {
    initPromise = initializeEngine(formatFilter).then(() => undefined);
  }
  await initPromise;
  postWorkerMessage({
    type: "ready",
    engine: activeEngine ?? "ZXing-WASM",
    supportedFormats: [...WAREHOUSE_FORMATS],
  });
}

async function handleDecode(
  request: Extract<WorkerRequest, { type: "decode" }>
): Promise<void> {
  const { bitmap, roi, formatFilter, frameTimestamp } = request;
  const t0 = performance.now();

  try {
    if (!activeEngine) {
      if (!initPromise) {
        initPromise = initializeEngine(formatFilter).then(() => undefined);
      }
      await initPromise;
    }

    const sx = Math.max(0, Math.floor(roi.sx));
    const sy = Math.max(0, Math.floor(roi.sy));
    const sw = Math.max(
      16,
      Math.min(bitmap.width - sx, Math.floor(roi.sw))
    );
    const sh = Math.max(
      16,
      Math.min(bitmap.height - sy, Math.floor(roi.sh))
    );

    // Geniş ROI karelerini 1280px ile sınırlayarak 15-40ms hedefini koru
    const maxCropWidth = 1280;
    const scale = sw > maxCropWidth ? maxCropWidth / sw : 1;
    const targetWidth = Math.max(16, Math.round(sw * scale));
    const targetHeight = Math.max(16, Math.round(sh * scale));

    const ctx = ensureCropContext(targetWidth, targetHeight);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  } finally {
    bitmap.close();
  }

  try {
    let barcodes: DecodedBarcodeItem[] = [];

    if (activeEngine === "BarcodeDetector" && cropCanvas) {
      try {
        const detector = getNativeDetector(formatFilter);
        const detected = await detector.detect(cropCanvas);
        for (const item of detected) {
          const rawValue = item.rawValue?.trim();
          const format = normalizeNativeFormat(item.format);
          if (!rawValue || !format) continue;
          if (formatFilter !== "all" && format !== formatFilter) continue;
          barcodes.push({ rawValue, format });
        }
      } catch {
        // Çalışma zamanında native algılama hata verirse ZXing-WASM'a düş
        activeEngine = "ZXing-WASM";
        if (cropCtx && cropCanvas) {
          barcodes = await decodeWithZXing(
            cropCtx,
            cropCanvas.width,
            cropCanvas.height,
            formatFilter
          );
        }
      }
    } else if (cropCtx && cropCanvas) {
      barcodes = await decodeWithZXing(
        cropCtx,
        cropCanvas.width,
        cropCanvas.height,
        formatFilter
      );
    }

    const decodeTimeMs = Math.round((performance.now() - t0) * 10) / 10;

    postWorkerMessage({
      type: "result",
      barcodes,
      decodeTimeMs,
      engine: activeEngine ?? "ZXing-WASM",
      frameTimestamp,
    });
  } catch (err) {
    postWorkerMessage({
      type: "error",
      message:
        err instanceof Error
          ? err.message
          : "Barkod çözümleme sırasında beklenmeyen hata oluştu.",
    });
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data;
  if (payload.type === "init") {
    void handleInit(payload.formatFilter).catch((err) => {
      postWorkerMessage({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Barkod motoru başlatılamadı.",
      });
    });
  } else if (payload.type === "decode") {
    void handleDecode(payload);
  }
});
