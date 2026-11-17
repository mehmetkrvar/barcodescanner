import type { ProductInfo } from "@/types/scanner";

interface RawProductItem {
  id?: string;
  name?: string;
  barcodes?: string[];
  picURL?: string;
}

let cachedMap: Map<string, ProductInfo> | null = null;
let loadPromise: Promise<Map<string, ProductInfo>> | null = null;

export async function loadProductCatalog(): Promise<Map<string, ProductInfo>> {
  if (cachedMap) return cachedMap;

  if (!loadPromise) {
    loadPromise = fetch("/product.json")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Ürün kataloğu yüklenemedi (${res.status})`);
        }
        const rawList = (await res.json()) as RawProductItem[];
        const map = new Map<string, ProductInfo>();

        if (Array.isArray(rawList)) {
          for (const item of rawList) {
            if (!item || !item.name || !Array.isArray(item.barcodes)) continue;
            const info: ProductInfo = {
              id: item.id ?? "",
              name: item.name.trim(),
              picURL: item.picURL?.trim() || undefined,
            };

            for (const rawCode of item.barcodes) {
              if (typeof rawCode !== "string") continue;
              const code = rawCode.trim();
              if (!code) continue;
              if (!map.has(code)) {
                map.set(code, info);
              }
            }
          }
        }

        cachedMap = map;
        return map;
      })
      .catch(() => {
        loadPromise = null;
        return new Map<string, ProductInfo>();
      });
  }

  return loadPromise;
}

export function findProductByBarcode(
  barcode: string,
  catalog: Map<string, ProductInfo> | null = cachedMap
): ProductInfo | null {
  if (!catalog || catalog.size === 0) return null;

  const trimmed = barcode.trim();
  if (!trimmed) return null;

  const exact = catalog.get(trimmed);
  if (exact) return exact;

  // EAN-13 (0 + 12 hane) <-> UPC-A (12 hane) dönüşümlerini kontrol et
  if (trimmed.length === 13 && trimmed.startsWith("0")) {
    const withoutZero = catalog.get(trimmed.slice(1));
    if (withoutZero) return withoutZero;
  } else if (trimmed.length === 12) {
    const withZero = catalog.get(`0${trimmed}`);
    if (withZero) return withZero;
  }

  return null;
}
