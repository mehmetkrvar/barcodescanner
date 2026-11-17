class SoundSynthesizer {
  private ctx: AudioContext | null = null;

  private getContext(): AudioContext | null {
    if (typeof window === "undefined") return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {
        // Kullanıcı etkileşimi öncesi tarayıcı kısıtlamasını yoksay
      });
    }

    return this.ctx;
  }

  public unlock(): void {
    this.getContext();
  }

  public playSuccessBeep(muted: boolean): void {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate(50);
      } catch {
        // Titreşim desteklenmiyorsa sessizce geç
      }
    }

    if (muted) return;

    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      // El terminali keskin bip tonu: ~2200 Hz kare/sinüs karakterli dalga, 60 ms
      osc.type = "square";
      osc.frequency.setValueAtTime(2200, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.004);
      gain.gain.setValueAtTime(0.18, now + 0.045);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.062);
    } catch {
      // Ses sentezleme hatasını yoksay
    }
  }

  public playDuplicateWarningBeep(muted: boolean): void {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate([80, 40, 80]);
      } catch {
        // Titreşim desteklenmiyorsa sessizce geç
      }
    }

    if (muted) return;

    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      // Çift tonlu mükerrer uyarı sesi: 440 Hz -> 330 Hz, 120 ms
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(330, now + 0.06);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.005);
      gain.gain.setValueAtTime(0.16, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.125);
    } catch {
      // Ses sentezleme hatasını yoksay
    }
  }

  public playClickTick(muted: boolean): void {
    if (muted) return;

    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.018);
    } catch {
      // Ses sentezleme hatasını yoksay
    }
  }
}

export const soundSynthesizer = new SoundSynthesizer();

export function playSuccessBeep(muted: boolean): void {
  soundSynthesizer.playSuccessBeep(muted);
}

export function playDuplicateWarningBeep(muted: boolean): void {
  soundSynthesizer.playDuplicateWarningBeep(muted);
}

export function playClickTick(muted: boolean): void {
  soundSynthesizer.playClickTick(muted);
}
