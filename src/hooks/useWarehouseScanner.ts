"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BarcodeFormatFilter,
  DecodedBarcodeItem,
  LaserState,
  RoiRect,
  ScannerTelemetry,
  SupportedBarcodeFormat,
  WorkerRequest,
  WorkerResponse,
} from "@/types/scanner";

interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: {
    min: number;
    max: number;
    step?: number;
  };
  focusMode?: string[];
}

interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
  zoom?: number;
  focusMode?: string;
}

export type DetectionOutcome = "accepted" | "duplicate" | "ignored";

interface UseWarehouseScannerOptions {
  formatFilter: BarcodeFormatFilter;
  paused?: boolean;
  onDetected: (item: DecodedBarcodeItem) => DetectionOutcome;
}

export interface UseWarehouseScannerReturn {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  roiRef: React.RefObject<HTMLDivElement | null>;
  isStarting: boolean;
  isActive: boolean;
  error: string | null;
  laserState: LaserState;
  telemetry: ScannerTelemetry;
  hasTorch: boolean;
  torchOn: boolean;
  zoom: number;
  hasHardwareZoom: boolean;
  digitalZoomScale: number;
  liveDetected: DecodedBarcodeItem | null;
  isTriggerArmed: boolean;
  triggerScan: () => void;
  toggleTorch: () => Promise<void>;
  setZoom: (value: number) => Promise<void>;
  restartCamera: () => Promise<void>;
  triggerLaserFeedback: (state: "success" | "duplicate") => void;
}

const LIVE_DETECT_HOLD_MS = 600;
const TRIGGER_ARM_TIMEOUT_MS = 4000;
const LASER_FEEDBACK_MS = 150;

export function useWarehouseScanner({
  formatFilter,
  paused = false,
  onDetected,
}: UseWarehouseScannerOptions): UseWarehouseScannerReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const roiRef = useRef<HTMLDivElement | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const workerBusyRef = useRef<boolean>(false);
  const lastVideoTimeRef = useRef<number>(-1);
  const lastLaserTimerRef = useRef<number | null>(null);

  const formatFilterRef = useRef<BarcodeFormatFilter>(formatFilter);
  const pausedRef = useRef<boolean>(paused);
  const onDetectedRef = useRef(onDetected);

  const liveDetectedRef = useRef<{
    item: DecodedBarcodeItem;
    seenAt: number;
  } | null>(null);
  const triggerArmedRef = useRef<boolean>(false);
  const triggerTimeoutRef = useRef<number | null>(null);

  const frameCounterRef = useRef<{ count: number; windowStart: number }>({
    count: 0,
    windowStart: 0,
  });
  const hardwareZoomRangeRef = useRef<{ min: number; max: number } | null>(
    null
  );

  const [isStarting, setIsStarting] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [laserState, setLaserState] = useState<LaserState>("scanning");
  const [telemetry, setTelemetry] = useState<ScannerTelemetry>({
    decodeTimeMs: 0,
    fps: 0,
    engine: null,
  });

  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [hasHardwareZoom, setHasHardwareZoom] = useState(false);
  const [liveDetected, setLiveDetected] = useState<DecodedBarcodeItem | null>(
    null
  );
  const [isTriggerArmed, setIsTriggerArmed] = useState(false);

  formatFilterRef.current = formatFilter;
  pausedRef.current = paused;
  onDetectedRef.current = onDetected;

  const disarmTrigger = useCallback(() => {
    if (triggerTimeoutRef.current !== null) {
      window.clearTimeout(triggerTimeoutRef.current);
      triggerTimeoutRef.current = null;
    }
    triggerArmedRef.current = false;
    setIsTriggerArmed(false);
  }, []);

  useEffect(() => {
    if (paused) {
      disarmTrigger();
    }
  }, [paused, disarmTrigger]);

  const triggerLaserFeedback = useCallback(
    (state: "success" | "duplicate") => {
      if (lastLaserTimerRef.current !== null) {
        window.clearTimeout(lastLaserTimerRef.current);
      }
      setLaserState(state);
      lastLaserTimerRef.current = window.setTimeout(() => {
        setLaserState("scanning");
        lastLaserTimerRef.current = null;
      }, LASER_FEEDBACK_MS);
    },
    []
  );

  const computeRoi = useCallback((video: HTMLVideoElement): RoiRect => {
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;

    const roiEl = roiRef.current;
    if (roiEl) {
      const vRect = video.getBoundingClientRect();
      const rRect = roiEl.getBoundingClientRect();

      if (vRect.width > 0 && vRect.height > 0 && rRect.width > 0 && rRect.height > 0) {
        const coverScale = Math.max(vRect.width / videoW, vRect.height / videoH);
        const dispW = videoW * coverScale;
        const dispH = videoH * coverScale;

        const videoLeft = vRect.left + (vRect.width - dispW) / 2;
        const videoTop = vRect.top + (vRect.height - dispH) / 2;

        const rawSx = (rRect.left - videoLeft) / coverScale;
        const rawSy = (rRect.top - videoTop) / coverScale;
        const rawSw = rRect.width / coverScale;
        const rawSh = rRect.height / coverScale;

        const sx = Math.max(0, Math.min(videoW - 16, Math.floor(rawSx)));
        const sy = Math.max(0, Math.min(videoH - 16, Math.floor(rawSy)));
        const sw = Math.max(16, Math.min(videoW - sx, Math.floor(rawSw)));
        const sh = Math.max(16, Math.min(videoH - sy, Math.floor(rawSh)));

        return { sx, sy, sw, sh };
      }
    }

    // Varsayılan ROI: merkez %85 genişlik × %25 yükseklik yatay şerit
    const sw = Math.max(16, Math.floor(videoW * 0.85));
    const sh = Math.max(16, Math.floor(videoH * 0.25));
    const sx = Math.floor((videoW - sw) / 2);
    const sy = Math.floor((videoH - sh) / 2);
    return { sx, sy, sw, sh };
  }, []);

  const stopCameraStream = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    trackRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsActive(false);
    setTorchOn(false);
  }, []);

  const startScanLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    const tick = () => {
      rafIdRef.current = requestAnimationFrame(tick);

      if (pausedRef.current || workerBusyRef.current) return;

      const video = videoRef.current;
      const worker = workerRef.current;
      if (
        !video ||
        !worker ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
      ) {
        return;
      }

      if (video.currentTime === lastVideoTimeRef.current) {
        return;
      }

      lastVideoTimeRef.current = video.currentTime;
      workerBusyRef.current = true;

      const roi = computeRoi(video);
      const frameTimestamp = performance.now();

      createImageBitmap(video)
        .then((bitmap) => {
          if (!workerRef.current) {
            bitmap.close();
            workerBusyRef.current = false;
            return;
          }

          const message: WorkerRequest = {
            type: "decode",
            bitmap,
            roi,
            formatFilter: formatFilterRef.current,
            frameTimestamp,
          };

          workerRef.current.postMessage(message, [bitmap]);
        })
        .catch(() => {
          workerBusyRef.current = false;
        });
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [computeRoi]);

  const startCamera = useCallback(async () => {
    if (typeof window === "undefined") return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setIsStarting(false);
      setIsActive(false);
      setError(
        window.isSecureContext
          ? "Bu tarayıcı kamera akışını (getUserMedia) desteklemiyor."
          : "Kamera erişimi için HTTPS veya localhost bağlantısı gereklidir."
      );
      return;
    }

    setIsStarting(true);
    setError(null);
    stopCameraStream();

    const constraintAttempts: MediaStreamConstraints[] = [
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60, min: 30 },
        },
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
        },
      },
      {
        audio: false,
        video: true,
      },
    ];

    let acquiredStream: MediaStream | null = null;
    let lastError: unknown = null;

    for (const constraints of constraintAttempts) {
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
        if (
          err instanceof DOMException &&
          (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
        ) {
          break;
        }
      }
    }

    if (!acquiredStream) {
      setIsStarting(false);
      setIsActive(false);
      if (lastError instanceof DOMException) {
        if (
          lastError.name === "NotAllowedError" ||
          lastError.name === "PermissionDeniedError"
        ) {
          setError(
            "Kamera izni reddedildi. Barkod okutmak için tarayıcı ayarlarından kamera erişimine izin verin."
          );
          return;
        }
        if (lastError.name === "NotFoundError") {
          setError("Cihazda kullanılabilir kamera bulunamadı.");
          return;
        }
        if (lastError.name === "NotReadableError") {
          setError(
            "Kamera başka bir uygulama tarafından kullanılıyor olabilir."
          );
          return;
        }
      }
      setError("Kamera başlatılamadı. Lütfen cihaz izinlerini kontrol edin.");
      return;
    }

    streamRef.current = acquiredStream;
    const videoTrack = acquiredStream.getVideoTracks()[0] ?? null;
    trackRef.current = videoTrack;

    if (videoTrack) {
      try {
        const capabilities =
          typeof videoTrack.getCapabilities === "function"
            ? (videoTrack.getCapabilities() as ExtendedMediaTrackCapabilities)
            : ({} as ExtendedMediaTrackCapabilities);

        if (
          Array.isArray(capabilities.focusMode) &&
          capabilities.focusMode.includes("continuous")
        ) {
          await videoTrack.applyConstraints({
            advanced: [
              { focusMode: "continuous" } as ExtendedMediaTrackConstraintSet,
            ],
          });
        }

        setHasTorch(Boolean(capabilities.torch));

        if (
          capabilities.zoom &&
          typeof capabilities.zoom.min === "number" &&
          typeof capabilities.zoom.max === "number" &&
          capabilities.zoom.max > capabilities.zoom.min
        ) {
          hardwareZoomRangeRef.current = {
            min: capabilities.zoom.min,
            max: capabilities.zoom.max,
          };
          setHasHardwareZoom(true);
        } else {
          hardwareZoomRangeRef.current = null;
          setHasHardwareZoom(false);
        }
      } catch {
        setHasTorch(false);
        setHasHardwareZoom(false);
      }
    }

    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.srcObject = acquiredStream;
      try {
        await videoEl.play();
      } catch {
        // Otomatik oynatma ilk etkileşim sonrası devam edebilir
      }
    }

    setZoomState(1);
    setIsStarting(false);
    setIsActive(true);
    startScanLoop();
  }, [startScanLoop, stopCameraStream]);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/barcode.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;

      if (data.type === "ready") {
        setTelemetry((prev) => ({
          ...prev,
          engine: data.engine,
        }));
        return;
      }

      if (data.type === "error") {
        workerBusyRef.current = false;
        return;
      }

      if (data.type === "result") {
        workerBusyRef.current = false;

        const now = performance.now();
        const counter = frameCounterRef.current;
        if (counter.windowStart === 0) {
          counter.windowStart = now;
        }
        counter.count += 1;

        const elapsed = now - counter.windowStart;
        if (elapsed >= 450) {
          const fps = Math.round((counter.count * 1000) / elapsed);
          counter.count = 0;
          counter.windowStart = now;
          setTelemetry({
            decodeTimeMs: data.decodeTimeMs,
            fps,
            engine: data.engine,
          });
        } else if (data.barcodes.length > 0) {
          setTelemetry((prev) => ({
            ...prev,
            decodeTimeMs: data.decodeTimeMs,
            engine: data.engine,
          }));
        }

        if (!pausedRef.current) {
          if (data.barcodes.length > 0) {
            const detectedItem: DecodedBarcodeItem = {
              rawValue: data.barcodes[0].rawValue,
              format: data.barcodes[0].format as SupportedBarcodeFormat,
            };

            liveDetectedRef.current = { item: detectedItem, seenAt: now };
            setLiveDetected((prev) =>
              prev &&
              prev.rawValue === detectedItem.rawValue &&
              prev.format === detectedItem.format
                ? prev
                : detectedItem
            );

            // Tuşla okutma (Trigger Mode) bekleniyorsa ilk algılanan barkodu kaydet
            if (triggerArmedRef.current) {
              disarmTrigger();
              const outcome = onDetectedRef.current(detectedItem);
              if (outcome === "accepted") {
                triggerLaserFeedback("success");
              } else if (outcome === "duplicate") {
                triggerLaserFeedback("duplicate");
              }
            }
          } else if (
            liveDetectedRef.current &&
            now - liveDetectedRef.current.seenAt > LIVE_DETECT_HOLD_MS
          ) {
            liveDetectedRef.current = null;
            setLiveDetected(null);
          }
        }
      }
    };

    worker.onerror = () => {
      workerBusyRef.current = false;
    };

    const initMsg: WorkerRequest = {
      type: "init",
      formatFilter: formatFilterRef.current,
    };
    worker.postMessage(initMsg);

    void startCamera();

    return () => {
      if (lastLaserTimerRef.current !== null) {
        window.clearTimeout(lastLaserTimerRef.current);
      }
      disarmTrigger();
      stopCameraStream();
      worker.terminate();
      workerRef.current = null;
    };
  }, [disarmTrigger, startCamera, stopCameraStream, triggerLaserFeedback]);

  const triggerScan = useCallback(() => {
    if (pausedRef.current) return;

    // Halihazırda bekleniyorsa ikinci basışta aramayı iptal et
    if (triggerArmedRef.current) {
      disarmTrigger();
      return;
    }

    const current = liveDetectedRef.current;
    const now = performance.now();

    // Lazer altında canlı algılanmış bir barkod varsa 0 ms gecikmeyle anında okut
    if (current && now - current.seenAt <= LIVE_DETECT_HOLD_MS) {
      const outcome = onDetectedRef.current(current.item);
      if (outcome === "accepted") {
        triggerLaserFeedback("success");
      } else if (outcome === "duplicate") {
        triggerLaserFeedback("duplicate");
      }
      return;
    }

    // Barkod henüz kadrajda değilse ilk girecek barkodu yakalamak için tetikle
    triggerArmedRef.current = true;
    setIsTriggerArmed(true);
    triggerTimeoutRef.current = window.setTimeout(() => {
      disarmTrigger();
    }, TRIGGER_ARM_TIMEOUT_MS);
  }, [disarmTrigger, triggerLaserFeedback]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track || !hasTorch) return;

    const nextState = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: nextState } as ExtendedMediaTrackConstraintSet],
      });
      setTorchOn(nextState);
    } catch {
      // Bazı cihazlar flaş değişimini reddedebilir
    }
  }, [hasTorch, torchOn]);

  const setZoom = useCallback(
    async (value: number) => {
      const clamped = Math.max(1, Math.min(3, Math.round(value * 10) / 10));
      setZoomState(clamped);

      const track = trackRef.current;
      const hwRange = hardwareZoomRangeRef.current;
      if (track && hasHardwareZoom && hwRange) {
        const hwTarget = Math.max(
          hwRange.min,
          Math.min(hwRange.max, clamped)
        );
        try {
          await track.applyConstraints({
            advanced: [{ zoom: hwTarget } as ExtendedMediaTrackConstraintSet],
          });
        } catch {
          // Donanımsal zoom başarısız olursa state güncel kalır
        }
      }
    },
    [hasHardwareZoom]
  );

  const digitalZoomScale = hasHardwareZoom ? 1 : zoom;

  return {
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
    hasHardwareZoom,
    digitalZoomScale,
    liveDetected,
    isTriggerArmed,
    triggerScan,
    toggleTorch,
    setZoom,
    restartCamera: startCamera,
    triggerLaserFeedback,
  };
}
