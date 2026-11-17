export type SupportedBarcodeFormat =
  | "ean_13"
  | "ean_8"
  | "code_128"
  | "code_39"
  | "qr_code"
  | "upc_a";

export type BarcodeFormatFilter = "all" | SupportedBarcodeFormat;

export const WAREHOUSE_FORMATS: readonly SupportedBarcodeFormat[] = [
  "ean_13",
  "ean_8",
  "code_128",
  "code_39",
  "qr_code",
  "upc_a",
] as const;

export const FORMAT_LABELS: Record<BarcodeFormatFilter, string> = {
  all: "Tümü (Depo)",
  ean_13: "EAN-13",
  ean_8: "EAN-8",
  code_128: "Code 128",
  code_39: "Code 39",
  qr_code: "QR Kod",
  upc_a: "UPC-A",
};

export interface ScanRecord {
  id: string;
  barcode: string;
  format: SupportedBarcodeFormat;
  quantity: number;
  timestamp: number;
  synced: boolean;
}

export type ScanMode = "serial" | "single";

export type SolverEngine = "BarcodeDetector" | "ZXing-WASM";

export type LaserState = "scanning" | "success" | "duplicate";

export interface RoiRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface DecodedBarcodeItem {
  rawValue: string;
  format: SupportedBarcodeFormat;
}

export type WorkerRequest =
  | {
      type: "init";
      formatFilter: BarcodeFormatFilter;
    }
  | {
      type: "decode";
      bitmap: ImageBitmap;
      roi: RoiRect;
      formatFilter: BarcodeFormatFilter;
      frameTimestamp: number;
    };

export type WorkerResponse =
  | {
      type: "ready";
      engine: SolverEngine;
      supportedFormats: SupportedBarcodeFormat[];
    }
  | {
      type: "result";
      barcodes: DecodedBarcodeItem[];
      decodeTimeMs: number;
      engine: SolverEngine;
      frameTimestamp: number;
    }
  | {
      type: "error";
      message: string;
    };

export interface ScannerTelemetry {
  decodeTimeMs: number;
  fps: number;
  engine: SolverEngine | null;
}
