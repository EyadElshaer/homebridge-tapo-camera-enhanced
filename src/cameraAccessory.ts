import {
  API,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  Service,
} from "homebridge";
import { StreamingDelegate } from "homebridge-camera-ffmpeg/dist/streamingDelegate";
import { Logger } from "homebridge-camera-ffmpeg/dist/logger";
import { Status, TAPOCamera } from "./tapoCamera";
import { PLUGIN_ID } from "./pkg";
import { CameraPlatform } from "./cameraPlatform";
import { VideoConfig } from "homebridge-camera-ffmpeg/dist/configTypes";
import { TAPOBasicInfo } from "./types/tapo";
import { RecordingDelegate, HKSVConfig } from "./services/recordingDelegate";
import {
  NightVisionDetector,
  NightVisionState,
} from "./services/nightVisionDetector";

export type CameraConfig = {
  name: string;
  ipAddress: string;
  username: string;
  password: string;
  streamUser?: string;
  streamPassword?: string;

  pullInterval?: number;
  disableStreaming?: boolean;
  debug?: boolean;
  hsv?: boolean;
  prebufferLength?: number;
  hksvConfig?: HKSVConfig;
  twoWayAudio?: boolean;
  returnAudioTarget?: string;
  debugReturn?: boolean;
  disableEyesToggleAccessory?: boolean;
  disableAlarmToggleAccessory?: boolean;
  disableNotificationsToggleAccessory?: boolean;
  disableMotionDetectionToggleAccessory?: boolean;
  disableLEDToggleAccessory?: boolean;
  enableFloodLightAccessory?: boolean;
  enableNightVisionSensor?: boolean;
  nightVisionSensorType?: "occupancy" | "light" | "contact" | "all";
  nightVisionSensorName?: string;
  nightVisionPollInterval?: number;
  nightVisionThreshold?: number;

  disableMotionSensorAccessory?: boolean;
  lowQuality?: boolean;
  rtspTransport?: "udp" | "tcp";

  videoMaxWidth?: number;
  videoMaxHeight?: number;
  videoMaxFPS?: number;
  videoForceMax?: boolean;
  videoMaxBitrate?: number;
  /** @deprecated misspelling of videoMaxBitrate, kept for configs that used it */
  videoMaxBirate?: number;
  videoPacketSize?: number;
  videoCodec?: string;

  videoConfig?: VideoConfig;

  eyesToggleAccessoryName?: string;
  alarmToggleAccessoryName?: string;
  notificationsToggleAccessoryName?: string;
  motionDetectionToggleAccessoryName?: string;
  ledToggleAccessoryName?: string;
  floodLightAccessoryName?: string;
};

export class CameraAccessory {
  private readonly log: Logging;
  private readonly api: API;

  private readonly camera: TAPOCamera;

  private pullIntervalTick: NodeJS.Timeout | undefined;

  private readonly accessory: PlatformAccessory;

  private infoAccessory: Service | undefined;
  private toggleAccessories: Partial<Record<keyof Status, Service>> = {};
  private cachedStatus: Partial<Status> = {};
  private isOffline = false;

  private motionSensorService: Service | undefined;
  private streamingDelegate: StreamingDelegate | undefined;
  private recordingDelegate: RecordingDelegate | undefined;
  private nightVisionDetector: NightVisionDetector | undefined;
  private nightVisionOccupancyService: Service | undefined;
  private nightVisionLightService: Service | undefined;
  private nightVisionContactService: Service | undefined;

  private readonly randomSeed = Math.random();

  public isLiveStreamingActive(): boolean {
    return Boolean(
      // @ts-expect-error ongoingSessions is internal to StreamingDelegate
      this.streamingDelegate?.ongoingSessions?.size > 0
    );
  }

  public isRecordingActive(): boolean {
    return Boolean(this.recordingDelegate?.isRecording);
  }

  public isStreamActive(): boolean {
    return this.isLiveStreamingActive() || this.isRecordingActive();
  }

  constructor(
    private readonly platform: CameraPlatform,
    private readonly config: CameraConfig
  ) {
    // @ts-expect-error - private property
    this.log = {
      ...this.platform.log,
      prefix: this.platform.log.prefix + `/${this.config.name}`,
    };

    this.api = this.platform.api;
    this.accessory = new this.api.platformAccessory(
      this.config.name,
      this.api.hap.uuid.generate(this.config.name),
      this.api.hap.Categories.CAMERA
    );
    this.camera = new TAPOCamera(this.log, this.config);
  }

  private hasStreamCredentials() {
    return Boolean(this.config.streamUser && this.config.streamPassword);
  }

  private isMotionSensorEnabled() {
    return (
      !this.config.disableMotionSensorAccessory && this.hasStreamCredentials()
    );
  }

  private setupInfoAccessory(basicInfo: TAPOBasicInfo) {
    this.infoAccessory =
      this.accessory.getService(this.api.hap.Service.AccessoryInformation) ||
      this.accessory.addService(this.api.hap.Service.AccessoryInformation);
    this.infoAccessory
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "TAPO")
      .setCharacteristic(
        this.api.hap.Characteristic.Model,
        basicInfo.device_info || basicInfo.device_model || "TAPO Camera"
      )
      .setCharacteristic(
        this.api.hap.Characteristic.SerialNumber,
        basicInfo.mac ||
          this.api.hap.uuid
            .generate(this.config.name)
            .replace(/-/g, "")
            .slice(0, 12)
            .toUpperCase()
      )
      .setCharacteristic(
        this.api.hap.Characteristic.FirmwareRevision,
        basicInfo.sw_version || "1.0.0"
      );
  }

  private setupToggleAccessory(
    name: string,
    tapoServiceStr: keyof Status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serviceType: any = this.api.hap.Service.Switch
  ) {
    try {
      const toggleService = this.accessory.addService(
        serviceType,
        name,
        tapoServiceStr
      );
      this.toggleAccessories[tapoServiceStr] = toggleService;

      toggleService.addOptionalCharacteristic(
        this.api.hap.Characteristic.ConfiguredName
      );
      toggleService.setCharacteristic(
        this.api.hap.Characteristic.ConfiguredName,
        name
      );

      toggleService
        .getCharacteristic(this.api.hap.Characteristic.On)
        .onGet(async () => {
          try {
            this.log.debug(`Getting "${tapoServiceStr}" status...`);

            const cachedValue = this.cachedStatus[tapoServiceStr];
            if (cachedValue !== undefined) {
              return cachedValue;
            }

            const currentValue = toggleService.getCharacteristic(
              this.api.hap.Characteristic.On
            ).value;

            void this.getStatusAndNotify();

            if (typeof currentValue === "boolean") {
              this.log.debug(
                `No cached status for "${tapoServiceStr}", returning Homebridge cached value`
              );
              return currentValue;
            }

            this.log.debug(
              `No cached status for "${tapoServiceStr}", returning fallback value`
            );
            return false;
          } catch (err) {
            this.log.error("Error getting status:", err);
            return false;
          }
        })
        .onSet(async (newValue) => {
          try {
            const value = Boolean(newValue);
            this.log.debug(
              `Setting "${tapoServiceStr}" to ${value ? "on" : "off"}...`
            );
            await this.camera.setStatus(tapoServiceStr, value);
            this.cachedStatus[tapoServiceStr] = value;
            toggleService
              .getCharacteristic(this.api.hap.Characteristic.On)
              .updateValue(value);
          } catch (err) {
            this.log.error("Error setting status:", err);
            throw new this.api.hap.HapStatusError(
              this.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST
            );
          }
        });
    } catch (err) {
      this.log.error(
        "Error setting up toggle accessory",
        name,
        tapoServiceStr,
        err
      );
    }
  }

  private getVideoConfig(): VideoConfig {
    const streamUrl = this.camera.getAuthenticatedStreamUrl(
      Boolean(this.config.lowQuality)
    );

    const isTwoWayAudio = Boolean(
      this.config.twoWayAudio ||
      this.config.returnAudioTarget ||
      this.config.videoConfig?.returnAudioTarget
    );

    const returnAudioTarget =
      this.config.returnAudioTarget ||
      this.config.videoConfig?.returnAudioTarget;

    const vcodec = this.config.videoCodec ?? "copy";
    const rtspTransport = this.config.rtspTransport ?? "tcp";
    const config: VideoConfig = {
      audio: true, // Set audio as true as most of TAPO cameras have audio
      vcodec: vcodec,
      // libx264: force Baseline profile and 1s keyframe interval for HomeKit compatibility.
      ...(vcodec === "libx264" && {
        encoderOptions: "-preset ultrafast -tune zerolatency -profile:v baseline -level:v 3.1 -g 30",
      }),
      maxWidth: this.config.videoMaxWidth,
      maxHeight: this.config.videoMaxHeight,
      maxFPS: this.config.videoMaxFPS,
      maxBitrate: this.config.videoMaxBitrate ?? this.config.videoMaxBirate,
      packetSize: this.config.videoPacketSize,
      forceMax: this.config.videoForceMax,
      // async resampling with 1000 max drift prevents audio/video delay accumulation while smoothing pcm_alaw timestamps
      mapaudio: "0:a:0 -af aresample=async=1000",
      ...(isTwoWayAudio && returnAudioTarget
        ? {
            returnAudioTarget,
            debugReturn: Boolean(
              this.config.debugReturn ?? this.config.videoConfig?.debugReturn
            ),
          }
        : {}),
      ...(this.config.videoConfig || {}),
      // We add this at the end as the user must not be able to override it
      source: `-rtsp_transport ${rtspTransport} -fflags +nobuffer+genpts+discardcorrupt -flags low_delay -analyzeduration 500000 -probesize 500000 -i ${streamUrl}`,
    };

    if (isTwoWayAudio && returnAudioTarget && !config.returnAudioTarget) {
      config.returnAudioTarget = returnAudioTarget;
    }

    this.log.debug("Video config", config);

    return config;
  }

  private async setupCameraStreaming(basicInfo: TAPOBasicInfo) {
    try {
      if (!this.hasStreamCredentials()) {
        this.log.error(
          "Camera streaming requires streamUser and streamPassword. Set disableStreaming to true for controls-only setups."
        );
        return;
      }

      const videoConfig = this.getVideoConfig();
      const isTwoWayAudio = Boolean(
        this.config.twoWayAudio ||
        this.config.returnAudioTarget ||
        videoConfig.returnAudioTarget
      );

      const delegate = new StreamingDelegate(
        new Logger(this.log),
        {
          name: this.config.name,
          manufacturer: "TAPO",
          model: basicInfo.device_info,
          serialNumber: basicInfo.mac,
          firmwareRevision: basicInfo.sw_version,
          unbridge: true,
          videoConfig: videoConfig,
        },
        this.api,
        this.api.hap
      );
      this.streamingDelegate = delegate;

      let isHsvSupported = true;
      if (
        this.config.hsv &&
        typeof this.api.versionGreaterOrEqual === "function" &&
        !this.api.versionGreaterOrEqual("1.4.0")
      ) {
        this.log.warn(
          "HSV cannot be activated. Incompatible Homebridge version detected! You must have at least Homebridge v1.4.0 installed."
        );
        isHsvSupported = false;
      }

      if (this.config.hsv && isHsvSupported) {
        this.log.info("Initializing HomeKit Secure Video (HSV)...");

        const recordingDelegate = new RecordingDelegate(
          this.log,
          this.config,
          this.api,
          this.api.hap,
          this.camera,
          () => {
            if (!this.motionSensorService) return false;
            return Boolean(
              this.motionSensorService.getCharacteristic(
                this.api.hap.Characteristic.MotionDetected
              ).value
            );
          },
          () => {
            const recordingManagement = this.accessory.getService(
              this.api.hap.Service.CameraRecordingManagement
            );
            if (recordingManagement) {
              const char = recordingManagement.getCharacteristic(
                this.api.hap.Characteristic.RecordingAudioActive
              );
              if (char && char.value !== undefined && char.value !== null) {
                return Boolean(char.value);
              }
            }

            const operatingMode = this.accessory.getService(
              this.api.hap.Service.CameraOperatingMode
            );
            if (operatingMode) {
              const char = operatingMode.getCharacteristic(
                this.api.hap.Characteristic.RecordingAudioActive
              );
              if (char && char.value !== undefined && char.value !== null) {
                return Boolean(char.value);
              }
            }

            return true;
          }
        );
        this.recordingDelegate = recordingDelegate;

        const recordingCodecs = [
          {
            type: this.api.hap.AudioRecordingCodecType.AAC_LC,
            bitrateMode: 0,
            samplerate: [
              this.api.hap.AudioRecordingSamplerate.KHZ_16,
              this.api.hap.AudioRecordingSamplerate.KHZ_24,
              this.api.hap.AudioRecordingSamplerate.KHZ_32,
              this.api.hap.AudioRecordingSamplerate.KHZ_44_1,
              this.api.hap.AudioRecordingSamplerate.KHZ_48,
            ],
            audioChannels: 1,
          },
          {
            type: this.api.hap.AudioRecordingCodecType.AAC_ELD,
            bitrateMode: 0,
            samplerate: [
              this.api.hap.AudioRecordingSamplerate.KHZ_16,
              this.api.hap.AudioRecordingSamplerate.KHZ_24,
              this.api.hap.AudioRecordingSamplerate.KHZ_32,
              this.api.hap.AudioRecordingSamplerate.KHZ_44_1,
              this.api.hap.AudioRecordingSamplerate.KHZ_48,
            ],
            audioChannels: 1,
          },
        ];

        const controller = new this.api.hap.CameraController({
          cameraStreamCount: this.config.videoConfig?.maxStreams || 2,
          delegate: delegate,
          streamingOptions: {
            supportedCryptoSuites: [
              this.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
            ],
            video: {
              resolutions: [
                [320, 180, 30],
                [320, 240, 15],
                [320, 240, 30],
                [480, 270, 30],
                [480, 360, 30],
                [640, 360, 30],
                [640, 480, 30],
                [1280, 720, 30],
                [1280, 960, 30],
                [1920, 1080, 30],
                [1600, 1200, 30],
              ],
              codec: {
                profiles: [
                  this.api.hap.H264Profile.BASELINE,
                  this.api.hap.H264Profile.MAIN,
                  this.api.hap.H264Profile.HIGH,
                ],
                levels: [
                  this.api.hap.H264Level.LEVEL3_1,
                  this.api.hap.H264Level.LEVEL3_2,
                  this.api.hap.H264Level.LEVEL4_0,
                ],
              },
            },
            audio: {
              twoWayAudio: isTwoWayAudio,
              codecs: [
                {
                  type: this.api.hap.AudioStreamingCodecType.AAC_ELD,
                  samplerate: this.api.hap.AudioStreamingSamplerate.KHZ_16,
                },
              ],
            },
          },
          recording: {
            options: {
              overrideEventTriggerOptions: [
                this.api.hap.EventTriggerOption.MOTION,
              ],
              prebufferLength: (this.config.prebufferLength || 4) * 1000,
              mediaContainerConfiguration: [
                {
                  type: this.api.hap.MediaContainerType.FRAGMENTED_MP4,
                  fragmentLength: 4000,
                },
              ],
              video: {
                type: this.api.hap.VideoCodecType.H264,
                parameters: {
                  profiles: [
                    this.api.hap.H264Profile.BASELINE,
                    this.api.hap.H264Profile.MAIN,
                    this.api.hap.H264Profile.HIGH,
                  ],
                  levels: [
                    this.api.hap.H264Level.LEVEL3_1,
                    this.api.hap.H264Level.LEVEL3_2,
                    this.api.hap.H264Level.LEVEL4_0,
                  ],
                },
                resolutions: [
                  [320, 180, 30],
                  [320, 240, 15],
                  [320, 240, 30],
                  [480, 270, 30],
                  [480, 360, 30],
                  [640, 360, 30],
                  [640, 480, 30],
                  [1280, 720, 30],
                  [1280, 960, 30],
                  [1920, 1080, 30],
                  [1600, 1200, 30],
                ],
              },
              audio: {
                codecs: recordingCodecs,
              },
            },
            delegate: recordingDelegate,
          },
          sensors: {
            motion: this.motionSensorService || true,
          },
        });

        // Keep delegate internal controller reference synced
        // @ts-expect-error - internal controller reassignment
        delegate.controller = controller;

        this.accessory.configureController(controller);
        this.log.info("HomeKit Secure Video (HSV) configured successfully");
      } else {
        this.accessory.configureController(delegate.controller);
      }

      this.log.debug("Camera streaming setup done");
    } catch (err) {
      this.log.error("Error setting up camera streaming:", err);
    }
  }

  private async setupMotionSensorAccessory() {
    try {
      if (!this.hasStreamCredentials()) {
        this.log.warn(
          "Motion sensor requires streamUser and streamPassword. Skipping motion sensor setup."
        );
        return;
      }

      this.motionSensorService = this.accessory.addService(
        this.platform.api.hap.Service.MotionSensor,
        "Motion Sensor",
        "motion"
      );

      this.motionSensorService.addOptionalCharacteristic(
        this.api.hap.Characteristic.ConfiguredName
      );
      this.motionSensorService.setCharacteristic(
        this.api.hap.Characteristic.ConfiguredName,
        "Motion Sensor"
      );

      const eventEmitter = await this.camera.getEventEmitter();
      eventEmitter.addListener("motion", (motionDetected) => {
        this.log.debug("Motion detected", motionDetected);

        this.motionSensorService?.updateCharacteristic(
          this.api.hap.Characteristic.MotionDetected,
          motionDetected
        );

        if (
          motionDetected &&
          this.nightVisionDetector &&
          !this.isStreamActive()
        ) {
          this.nightVisionDetector.triggerCheck();
        }
      });
    } catch (err) {
      this.log.error("Error setting up motion sensor accessory:", err);
    }
  }

  private setupNightVisionSensorAccessory() {
    try {
      if (!this.hasStreamCredentials()) {
        this.log.warn(
          "Night Vision / Darkness sensor requires streamUser and streamPassword. Skipping setup."
        );
        return;
      }

      this.nightVisionDetector = new NightVisionDetector(
        this.log,
        this.config,
        this.camera,
        () => this.isStreamActive()
      );

      const sensorType = this.config.nightVisionSensorType || "occupancy";
      const baseName = this.config.nightVisionSensorName || "Darkness";

      if (sensorType === "occupancy" || sensorType === "all") {
        this.nightVisionOccupancyService = this.accessory.addService(
          this.platform.api.hap.Service.OccupancySensor,
          baseName,
          "nightVisionOccupancy"
        );
        this.nightVisionOccupancyService.addOptionalCharacteristic(
          this.api.hap.Characteristic.ConfiguredName
        );
        this.nightVisionOccupancyService.setCharacteristic(
          this.api.hap.Characteristic.ConfiguredName,
          baseName
        );
        this.nightVisionOccupancyService
          .getCharacteristic(this.api.hap.Characteristic.OccupancyDetected)
          .onGet(() => {
            const isDark = this.nightVisionDetector?.isDark ?? false;
            return isDark
              ? this.api.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
              : this.api.hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
          });
      }

      if (sensorType === "light" || sensorType === "all") {
        const lightName =
          sensorType === "all" ? `${baseName} Light Level` : baseName;
        this.nightVisionLightService = this.accessory.addService(
          this.platform.api.hap.Service.LightSensor,
          lightName,
          "nightVisionLight"
        );
        this.nightVisionLightService.addOptionalCharacteristic(
          this.api.hap.Characteristic.ConfiguredName
        );
        this.nightVisionLightService.setCharacteristic(
          this.api.hap.Characteristic.ConfiguredName,
          lightName
        );
        this.nightVisionLightService
          .getCharacteristic(
            this.api.hap.Characteristic.CurrentAmbientLightLevel
          )
          .onGet(() => {
            return this.nightVisionDetector?.ambientLux ?? 100;
          });
      }

      if (sensorType === "contact" || sensorType === "all") {
        const contactName =
          sensorType === "all" ? `${baseName} Sensor` : baseName;
        this.nightVisionContactService = this.accessory.addService(
          this.platform.api.hap.Service.ContactSensor,
          contactName,
          "nightVisionContact"
        );
        this.nightVisionContactService.addOptionalCharacteristic(
          this.api.hap.Characteristic.ConfiguredName
        );
        this.nightVisionContactService.setCharacteristic(
          this.api.hap.Characteristic.ConfiguredName,
          contactName
        );
        this.nightVisionContactService
          .getCharacteristic(this.api.hap.Characteristic.ContactSensorState)
          .onGet(() => {
            const isDark = this.nightVisionDetector?.isDark ?? false;
            return isDark
              ? this.api.hap.Characteristic.ContactSensorState
                  .CONTACT_NOT_DETECTED
              : this.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED;
          });
      }

      this.nightVisionDetector.on("update", (state: NightVisionState) => {
        if (this.nightVisionOccupancyService) {
          this.nightVisionOccupancyService.updateCharacteristic(
            this.api.hap.Characteristic.OccupancyDetected,
            state.isDark
              ? this.api.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
              : this.api.hap.Characteristic.OccupancyDetected
                  .OCCUPANCY_NOT_DETECTED
          );
        }

        if (this.nightVisionLightService) {
          this.nightVisionLightService.updateCharacteristic(
            this.api.hap.Characteristic.CurrentAmbientLightLevel,
            state.ambientLux
          );
        }

        if (this.nightVisionContactService) {
          this.nightVisionContactService.updateCharacteristic(
            this.api.hap.Characteristic.ContactSensorState,
            state.isDark
              ? this.api.hap.Characteristic.ContactSensorState
                  .CONTACT_NOT_DETECTED
              : this.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
          );
        }
      });

      const pollInterval = this.config.nightVisionPollInterval || 30;
      this.nightVisionDetector.start(pollInterval);
    } catch (err) {
      this.log.error("Error setting up night vision sensor accessory:", err);
    }
  }

  private setupPolling() {
    if (this.pullIntervalTick) {
      clearInterval(this.pullIntervalTick);
    }

    this.pullIntervalTick = setInterval(() => {
      this.log.debug("Polling status...");
      this.getStatusAndNotify();
    }, this.config.pullInterval || this.platform.kDefaultPullInterval);
  }

  private async getStatusAndNotify() {
    try {
      const cameraStatus = await this.camera.getStatus();
      
      if (
        this.isOffline ||
        (this.isMotionSensorEnabled() && !this.camera.onvifConnected)
      ) {
        let onvifSuccess = true;
        if (this.isMotionSensorEnabled()) {
          this.log.info(
            "Camera is back online, restarting ONVIF connection..."
          );
          onvifSuccess = await this.camera.restartOnvifConnection();
        }

        if (onvifSuccess) {
          this.isOffline = false;
        } else {
          this.isOffline = true;
          this.log.error(
            "Failed to restart ONVIF connection, will retry next poll."
          );
        }
      }

      this.cachedStatus = {
        ...this.cachedStatus,
        ...cameraStatus,
      };
      this.log.debug("Notifying new values...", cameraStatus);

      for (const [key, value] of Object.entries(cameraStatus)) {
        const toggleService = this.toggleAccessories[key as keyof Status];
        if (toggleService && value !== undefined) {
          toggleService
            .getCharacteristic(this.api.hap.Characteristic.On)
            .updateValue(value);
        }
      }
    } catch (err) {
      this.log.error("Error getting status:", err);
      this.isOffline = true;
    }
  }

  async setup() {
    let basicInfo: TAPOBasicInfo;
    try {
      basicInfo = await this.camera.getBasicInfo();
      this.log.debug("Basic info", basicInfo);
    } catch (err) {
      this.log.warn(
        `Could not retrieve initial basic info for camera "${this.config.name}" (${err instanceof Error ? err.message : err}). Using fallback metadata so the camera is immediately published to HomeKit.`
      );
      basicInfo = {
        device_type: "SMART.IPCAMERA",
        device_model: "TAPO",
        device_info: "TAPO Camera",
        device_name: this.config.name,
        mac: this.api.hap.uuid
          .generate(this.config.name)
          .replace(/-/g, "")
          .slice(0, 12)
          .toUpperCase(),
        sw_version: "1.0.0",
        hw_version: "1.0.0",
      };
    }

    this.accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info("Identify requested", basicInfo);
    });

    this.setupInfoAccessory(basicInfo);

    if (!this.config.disableMotionSensorAccessory) {
      try {
        await this.setupMotionSensorAccessory();
      } catch (err) {
        this.log.warn("Error setting up motion sensor accessory:", err);
      }
    }

    if (!this.config.disableStreaming) {
      await this.setupCameraStreaming(basicInfo);
    }

    if (!this.config.disableEyesToggleAccessory) {
      this.setupToggleAccessory(
        this.config.eyesToggleAccessoryName || "Eyes",
        "eyes"
      );
    }

    if (!this.config.disableAlarmToggleAccessory) {
      this.setupToggleAccessory(
        this.config.alarmToggleAccessoryName || "Alarm",
        "alarm"
      );
    }

    if (!this.config.disableNotificationsToggleAccessory) {
      this.setupToggleAccessory(
        this.config.notificationsToggleAccessoryName || "Notifications",
        "notifications"
      );
    }

    if (!this.config.disableMotionDetectionToggleAccessory) {
      this.setupToggleAccessory(
        this.config.motionDetectionToggleAccessoryName || "Motion Detection",
        "motionDetection"
      );
    }

    if (!this.config.disableLEDToggleAccessory) {
      this.setupToggleAccessory(
        this.config.ledToggleAccessoryName || "LED",
        "led"
      );
    }

    if (this.config.enableFloodLightAccessory) {
      this.setupToggleAccessory(
        this.config.floodLightAccessoryName || "Floodlight",
        "floodLight",
        this.api.hap.Service.Lightbulb
      );
    }

    if (this.config.enableNightVisionSensor) {
      this.setupNightVisionSensorAccessory();
    }

    // Publish as external accessory
    this.log.info(
      `Camera "${this.config.name}" published as external accessory. To pair in Apple Home: tap (+) -> Add Accessory -> More options... -> select "${this.config.name}" and enter your Homebridge setup PIN.`
    );
    this.api.publishExternalAccessories(PLUGIN_ID, [this.accessory]);

    // Setup the polling by giving a random delay
    // to avoid all the cameras starting at the same time
    this.log.debug("Setting up polling...");
    setTimeout(() => {
      this.setupPolling();
    }, this.randomSeed * 3_000);

    this.log.debug("Notifying initial values...");
    void this.getStatusAndNotify();
  }
}
