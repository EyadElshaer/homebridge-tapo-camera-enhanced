import { spawn } from "child_process";
import { EventEmitter } from "events";
import { Logging } from "homebridge";
import ffmpegPath from "ffmpeg-for-homebridge";
import { TAPOCamera } from "../tapoCamera";
import { CameraConfig } from "../cameraAccessory";

export interface NightVisionState {
  isDark: boolean;
  ambientLux: number;
  colorDiff: number;
  luminance: number;
}

export function analyzeRgbFrame(
  buffer: Buffer,
  threshold = 6.0
): NightVisionState {
  if (buffer.length < 3) {
    return {
      isDark: false,
      ambientLux: 100,
      colorDiff: 100,
      luminance: 100,
    };
  }

  let totalDiff = 0;
  let totalLum = 0;
  const numPixels = Math.floor(buffer.length / 3);

  for (let i = 0; i < numPixels * 3; i += 3) {
    const r = buffer[i];
    const g = buffer[i + 1];
    const b = buffer[i + 2];

    totalDiff += Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
    totalLum += 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const avgColorDiff = totalDiff / numPixels;
  const avgLuminance = totalLum / numPixels;

  // A monochrome (IR night vision) frame has very low color channel difference.
  // Also treat pitch-black scenes (low luminance < 5) as dark.
  const isDark = avgColorDiff < threshold || avgLuminance < 5.0;

  // Compute realistic HomeKit ambient lux reading:
  // Night/Dark: 0.1 - 1.0 lux based on luminance
  // Light/Day: 10 - 500+ lux based on luminance
  let ambientLux: number;
  if (isDark) {
    ambientLux = Math.max(0.1, Math.min(1.0, (avgLuminance / 255) * 1.0));
  } else {
    ambientLux = Math.max(10, Math.min(1000, (avgLuminance / 255) * 500));
  }

  return {
    isDark,
    ambientLux: Math.round(ambientLux * 10) / 10,
    colorDiff: Math.round(avgColorDiff * 100) / 100,
    luminance: Math.round(avgLuminance * 100) / 100,
  };
}

export class NightVisionDetector extends EventEmitter {
  private readonly videoProcessor: string;
  private pollTimer: NodeJS.Timeout | undefined;
  private isChecking = false;
  private lastCheckTime = 0;
  private currentState: NightVisionState = {
    isDark: false,
    ambientLux: 100,
    colorDiff: 50,
    luminance: 100,
  };

  constructor(
    private readonly log: Logging,
    private readonly config: CameraConfig,
    private readonly camera: TAPOCamera,
    videoProcessor?: string
  ) {
    super();
    this.videoProcessor =
      videoProcessor ||
      (typeof ffmpegPath === "string" ? ffmpegPath : "ffmpeg");
  }

  public getState(): NightVisionState {
    return this.currentState;
  }

  public get isDark(): boolean {
    return this.currentState.isDark;
  }

  public get ambientLux(): number {
    return this.currentState.ambientLux;
  }

  /**
   * Start periodic background darkness polling.
   */
  public start(intervalSeconds = 5): void {
    this.stop();
    const intervalMs = Math.max(1, intervalSeconds) * 1000;

    this.pollTimer = setInterval(() => {
      void this.checkDarkness();
    }, intervalMs);

    // Initial fast check
    setTimeout(() => {
      void this.checkDarkness();
    }, 500);
  }

  /**
   * Stop background polling.
   */
  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Trigger an immediate check with debouncing (e.g. on motion detected).
   */
  public triggerCheck(debounceMs = 1000): void {
    const now = Date.now();
    if (now - this.lastCheckTime < debounceMs) {
      this.log.debug(
        "NightVisionDetector: Skipping check because recent check occurred within debounce window"
      );
      return;
    }
    void this.checkDarkness();
  }

  /**
   * Captures a single 64x36 raw RGB frame via FFmpeg and analyzes color divergence.
   */
  public async checkDarkness(): Promise<NightVisionState> {
    if (this.isChecking) {
      return this.currentState;
    }

    if (!this.config.streamUser || !this.config.streamPassword) {
      return this.currentState;
    }

    this.isChecking = true;
    this.lastCheckTime = Date.now();

    try {
      const streamUrl = this.camera.getAuthenticatedStreamUrl(true);
      const rtspTransport = this.config.rtspTransport ?? "tcp";

      const ffmpegArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        rtspTransport,
        "-flags",
        "low_delay",
        "-fflags",
        "+nobuffer+discardcorrupt",
        "-probesize",
        "32768",
        "-analyzeduration",
        "0",
        "-i",
        streamUrl,
        "-vframes",
        "1",
        "-s",
        "64x36",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ];

      this.log.debug(
        `NightVisionDetector: Capturing frame for darkness analysis: ${this.videoProcessor} ${ffmpegArgs.join(" ")}`
      );

      const frameBuffer = await this.captureFrame(ffmpegArgs);
      const threshold = this.config.nightVisionThreshold ?? 6.0;
      const newState = analyzeRgbFrame(frameBuffer, threshold);

      const stateChanged = newState.isDark !== this.currentState.isDark;
      this.currentState = newState;

      this.log.debug(
        `NightVisionDetector: Analysis result -> isDark: ${newState.isDark}, colorDiff: ${newState.colorDiff} (threshold: ${threshold}), luminance: ${newState.luminance}, lux: ${newState.ambientLux}`
      );

      if (stateChanged) {
        this.log.info(
          `NightVisionDetector: Camera switched to ${newState.isDark ? "DARK (Night Vision / B&W)" : "LIGHT (Day / Color)"} mode`
        );
        this.emit("change", newState);
      }

      this.emit("update", newState);
      return newState;
    } catch (err) {
      this.log.debug(
        `NightVisionDetector: Error capturing frame for darkness analysis (${err instanceof Error ? err.message : err})`
      );
      return this.currentState;
    } finally {
      this.isChecking = false;
    }
  }

  private captureFrame(args: string[]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const ffmpeg = spawn(this.videoProcessor, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let stderrOutput = "";
      let isResolved = false;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          try {
            ffmpeg.kill("SIGKILL");
          } catch {
            // ignore
          }
          reject(new Error("FFmpeg frame capture timed out after 4000ms"));
        }
      }, 4000);

      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      ffmpeg.stderr.on("data", (chunk: Buffer) => {
        stderrOutput += chunk.toString("utf8");
      });

      ffmpeg.on("error", (err) => {
        clearTimeout(timeout);
        if (!isResolved) {
          isResolved = true;
          reject(err);
        }
      });

      ffmpeg.on("close", (code) => {
        clearTimeout(timeout);
        if (isResolved) return;
        isResolved = true;

        if (code === 0 || chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(
            new Error(
              `FFmpeg exited with code ${code}. Stderr: ${stderrOutput.trim()}`
            )
          );
        }
      });
    });
  }
}
