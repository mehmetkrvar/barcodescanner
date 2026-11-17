import { NextResponse } from "next/server";
import type { ScanRecord } from "@/types/scanner";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { scans?: ScanRecord[] };

    if (!body || !Array.isArray(body.scans)) {
      return NextResponse.json(
        {
          success: false,
          error: "Geçersiz veri formatı: scans dizisi bekleniyor.",
        },
        { status: 400 }
      );
    }

    const validScans = body.scans.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.barcode === "string" &&
        typeof item.quantity === "number"
    );

    const syncedIds = validScans.map((item) => item.id);

    return NextResponse.json({
      success: true,
      count: syncedIds.length,
      syncedIds,
      syncedAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "İstek gövdesi çözümlenemedi.",
      },
      { status: 400 }
    );
  }
}
