import {
  API,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HAP,
  HDSProtocolSpecificErrorReason,
  Logging,
  RecordingPacket,
} from "homebridge";
import { spawn, ChildProcess } from "child_process";
import readline from "readline";
import ffmpegPath from "ffmpeg-for-homebridge";
import { CameraConfig } from "../cameraAccessory";
import { TAPOCamera } from "../tapoCamera";
import { parseFragmentedMP4 } from "./mp4Parser";

export interface HKSVConfig {
  source?: string;
  vcodec?: string;
  acodec?: string;
  audio?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxFPS?: number;
  maxBitrate?: number;
  encoderOptions?: string;
}

const MAX_RECORDING_MINUTES = 2;

export class RecordingDelegate implements CameraRecordingDelegate {
  private configuration?: CameraRecordingConfiguration;
  private active = false;
  private currentProcess?: ChildProcess;
  private forceCloseTimer?: NodeJS.Timeout;
  private isClosing = false;
  private readonly videoProcessor: string;

  constructor(
    private readonly log: Logging,
    private readonly cameraConfig: CameraConfig,
    private readonly api: API,
    private readonly hap: HAP,
    private readonly camera: TAPOCamera,
    private readonly getMotionDetected: () => boolean,
    private readonly isAudioActive: () => boolean,
    videoProcessor?: string
  ) {
    this.videoProcessor =
      videoProcessor ||
      (typeof ffmpegPath === "string" ? ffmpegPath : "ffmpeg");
  }

  updateRecordingActive(active: boolean): void {
    this.log.debug(`HSV Recording active state updated: ${active}`);
    this.active = active;
  }

  updateRecordingConfiguration(
    configuration: CameraRecordingConfiguration | undefined
  ): void {
    this.log.debug(
      `HSV Recording configuration updated: ${JSON.stringify(configuration)}`
    );
    this.configuration = configuration;
  }

  async *handleRecordingStreamRequest(
    streamId: number
  ): AsyncGenerator<RecordingPacket> {
    this.log.info(
      `Video fragments requested for HSV recording (streamId: ${streamId})`
    );

    if (!this.configuration) {
      this.log.error(
        "Cannot start recording stream: No recording configuration selected by HomeKit."
      );
      return;
    }

    this.isClosing = false;
    const streamUrl =
      this.cameraConfig.hksvConfig?.source ||
      this.camera.getAuthenticatedStreamUrl(
        Boolean(this.cameraConfig.lowQuality)
      );

    const rtspTransport = this.cameraConfig.rtspTransport ?? "tcp";
    const ffmpegInput: string[] = [
      "-hide_banner",
      "-loglevel",
      this.cameraConfig.debug ? "verbose" : "error",
      "-fflags",
      "+nobuffer+genpts+discardcorrupt",
      "-flags",
      "low_delay",
      "-analyzeduration",
      "500000",
      "-probesize",
      "500000",
      "-rtsp_transport",
      rtspTransport,
      "-i",
      streamUrl,
    ];

    const videoArguments: string[] = [];
    const vcodec =
      this.cameraConfig.hksvConfig?.vcodec ||
      (this.cameraConfig.videoCodec &&
      this.cameraConfig.videoCodec !== "copy"
        ? this.cameraConfig.videoCodec
        : "libx264");

    const profile =
      this.configuration.videoCodec.parameters.profile ===
      this.hap.H264Profile.HIGH
        ? "high"
        : this.configuration.videoCodec.parameters.profile ===
          this.hap.H264Profile.MAIN
        ? "main"
        : "baseline";

    const level =
      this.configuration.videoCodec.parameters.level ===
      this.hap.H264Level.LEVEL4_0
        ? "4.0"
        : this.configuration.videoCodec.parameters.level ===
          this.hap.H264Level.LEVEL3_2
        ? "3.2"
        : "3.1";

    const width =
      this.cameraConfig.hksvConfig?.maxWidth ||
      this.configuration.videoCodec.resolution[0];
    const height =
      this.cameraConfig.hksvConfig?.maxHeight ||
      this.configuration.videoCodec.resolution[1];
    const fps =
      this.cameraConfig.hksvConfig?.maxFPS ||
      this.configuration.videoCodec.resolution[2] ||
      25;
    const videoBitrate =
      this.cameraConfig.hksvConfig?.maxBitrate ||
      this.configuration.videoCodec.parameters.bitRate;
    const iFrameInterval =
      this.configuration.videoCodec.parameters.iFrameInterval || 4000;
    const gop = Math.max(1, Math.round((iFrameInterval / 1000) * fps));

    if (vcodec === "copy") {
      videoArguments.push("-vcodec", "copy");
    } else {
      videoArguments.push(
        "-sn",
        "-dn",
        "-vcodec",
        vcodec,
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        profile,
        "-level:v",
        level,
        "-b:v",
        `${videoBitrate}k`,
        "-bufsize",
        `${videoBitrate * 2}k`,
        "-maxrate",
        `${videoBitrate}k`,
        "-vf",
        `scale=w=${width}:h=${height}:force_original_aspect_ratio=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        "-sws_flags",
        "fast_bilinear",
        "-r",
        `${fps}`,
        "-g",
        `${gop}`,
        "-keyint_min",
        `${gop}`,
        "-force_key_frames",
        `expr:gte(t,n_forced*${iFrameInterval / 1000})`
      );

      if (this.cameraConfig.hksvConfig?.encoderOptions) {
        videoArguments.push(
          ...this.cameraConfig.hksvConfig.encoderOptions.split(/\s+/)
        );
      } else if (vcodec === "libx264") {
        videoArguments.push(
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-threads",
          "0",
          "-sc_threshold",
          "0"
        );
      }
    }

    const audioArguments: string[] = [];
    const audioActiveInHomeKit = this.isAudioActive();
    const audioConfigured =
      this.cameraConfig.hksvConfig?.audio !== false &&
      (this.cameraConfig.videoConfig?.audio ?? true);

    if (audioActiveInHomeKit && audioConfigured) {
      const acodec = this.cameraConfig.hksvConfig?.acodec || "aac";
      let samplerate = "32";

      switch (this.configuration.audioCodec.samplerate) {
        case this.hap.AudioRecordingSamplerate.KHZ_8:
          samplerate = "8";
          break;
        case this.hap.AudioRecordingSamplerate.KHZ_16:
          samplerate = "16";
          break;
        case this.hap.AudioRecordingSamplerate.KHZ_24:
          samplerate = "24";
          break;
        case this.hap.AudioRecordingSamplerate.KHZ_32:
          samplerate = "32";
          break;
        case this.hap.AudioRecordingSamplerate.KHZ_44_1:
          samplerate = "44.1";
          break;
        case this.hap.AudioRecordingSamplerate.KHZ_48:
          samplerate = "48";
          break;
        default:
          samplerate = "32";
          break;
      }

      const isAacEld =
        this.configuration.audioCodec.type ===
        this.hap.AudioRecordingCodecType.AAC_ELD;

      if (acodec === "libfdk_aac") {
        audioArguments.push(
          "-acodec",
          "libfdk_aac",
          "-profile:a",
          isAacEld ? "aac_eld" : "aac_low"
        );
      } else {
        audioArguments.push("-acodec", "aac");
      }

      audioArguments.push(
        "-ar",
        `${samplerate}k`,
        "-b:a",
        `${this.configuration.audioCodec.bitrate || 64}k`,
        "-ac",
        `${this.configuration.audioCodec.audioChannels || 1}`,
        "-af",
        "aresample=async=1000"
      );
    } else {
      audioArguments.push("-an");
    }

    const fmp4Arguments: string[] = [
      ...ffmpegInput,
      ...videoArguments,
      ...audioArguments,
      "-f",
      "mp4",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    ];

    this.log.debug(
      `HSV FFmpeg recording command: ${this.videoProcessor} ${fmp4Arguments.join(
        " "
      )}`
    );

    const cp = spawn(this.videoProcessor, fmp4Arguments, {
      env: process.env,
    });
    this.currentProcess = cp;

    cp.on("error", (error: Error) => {
      this.log.error(`HSV FFmpeg process error: ${error.message}`);
    });

    cp.stdout?.on("error", (err: Error) => {
      this.log.debug(`[HSV FFmpeg stdout error] ${err.message}`);
    });

    cp.stderr?.on("error", (err: Error) => {
      this.log.debug(`[HSV FFmpeg stderr error] ${err.message}`);
    });

    cp.stdin?.on("error", (err: Error) => {
      this.log.debug(`[HSV FFmpeg stdin error] ${err.message}`);
    });

    if (cp.stderr) {
      const stderrInterface = readline.createInterface({
        input: cp.stderr,
        terminal: false,
      });

      stderrInterface.on("line", (line: string) => {
        if (this.cameraConfig.debug || /\[(panic|fatal|error)\]/.test(line)) {
          this.log.debug(`[HSV FFmpeg] ${line}`);
        }
      });

      stderrInterface.on("error", () => {
        // ignore
      });
    }

    cp.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.log.debug(
        `HSV FFmpeg process exited with code ${code} and signal ${signal}`
      );
    });

    if (this.forceCloseTimer) {
      clearTimeout(this.forceCloseTimer);
    }
    this.forceCloseTimer = setTimeout(() => {
      this.log.warn(
        `HSV recording process reached max runtime of ${MAX_RECORDING_MINUTES} minutes and is being closed.`
      );
      this.closeRecordingStream(streamId);
    }, MAX_RECORDING_MINUTES * 60 * 1000);

    const POST_MOTION_FRAGMENTS = 2; // ~8 seconds of post-roll footage after motion ends
    let postMotionRemaining = POST_MOTION_FRAGMENTS;
    let pending: Buffer[] = [];

    try {
      if (!cp.stdout) {
        throw new Error("FFmpeg stdout is not readable");
      }

      for await (const box of parseFragmentedMP4(cp.stdout)) {
        pending.push(box.header, box.data);

        if (box.type === "moov") {
          const fragment = Buffer.concat(pending);
          pending = [];

          yield {
            data: fragment,
            isLast: false,
          };
        } else if (box.type === "mdat") {
          const fragment = Buffer.concat(pending);
          pending = [];

          let motion = false;
          try {
            motion =
              typeof this.getMotionDetected === "function"
                ? Boolean(this.getMotionDetected())
                : false;
          } catch {
            motion = false;
          }

          if (motion) {
            postMotionRemaining = POST_MOTION_FRAGMENTS;
          } else {
            postMotionRemaining--;
          }

          const isLast = postMotionRemaining <= 0 || this.isClosing;

          yield {
            data: fragment,
            isLast,
          };

          if (isLast) {
            this.log.debug(
              "Ending HSV recording session cleanly with endOfStream."
            );
            break;
          }
        }
      }
    } catch (err) {
      this.log.debug(`HSV recording generator exited: ${err}`);
    } finally {
      if (this.forceCloseTimer) {
        clearTimeout(this.forceCloseTimer);
        this.forceCloseTimer = undefined;
      }
      this.closeProcess();
    }
  }

  private closeProcess(): void {
    if (this.currentProcess) {
      const proc = this.currentProcess;
      this.currentProcess = undefined;
      try {
        if (!proc.killed) {
          proc.kill();
        }
      } catch {
        // ignore
      }
    }
  }

  closeRecordingStream(
    streamId: number,
    reason?: HDSProtocolSpecificErrorReason
  ): void {
    try {
      this.log.info(
        `Closing HSV recording stream (streamId: ${streamId}, reason: ${reason ?? "NORMAL"})`
      );
      this.isClosing = true;

      if (this.forceCloseTimer) {
        clearTimeout(this.forceCloseTimer);
        this.forceCloseTimer = undefined;
      }

      this.closeProcess();
    } catch (err) {
      this.log.debug(`Error in closeRecordingStream: ${err}`);
    }
  }

  acknowledgeStream(streamId: number): void {
    try {
      this.log.debug(`HSV recording stream acknowledged (streamId: ${streamId})`);
      this.closeRecordingStream(streamId);
    } catch (err) {
      this.log.debug(`Error in acknowledgeStream: ${err}`);
    }
  }
}
