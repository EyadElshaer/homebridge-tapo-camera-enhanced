import { Logging } from "homebridge";
import { CameraConfig } from "./cameraAccessory";
import {
  DeviceInformation,
  NotificationMessage,
  Cam as ICam,
} from "./types/onvif";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Cam } from "onvif";
import { EventEmitter } from "stream";

export class OnvifCamera {
  private events: EventEmitter | undefined;
  private device: ICam | undefined;
  private isListening = false;
  private isConnecting = false;
  private connectPromise: Promise<ICam> | undefined;
  private reconnectTimeout: NodeJS.Timeout | undefined;
  private reconnectBackoffMs = 5000;
  private lastMotionValue = false;

  private readonly kOnvifPort = 2020;
  private readonly kOnvifTimeout = 10000;

  constructor(
    protected readonly log: Logging,
    protected readonly config: CameraConfig
  ) {}

  private async getDevice(): Promise<ICam> {
    if (this.device) {
      return this.device;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<ICam>((resolve, reject) => {
      let resolved = false;
      const device: ICam = new Cam(
        {
          hostname: this.config.ipAddress,
          username: this.config.streamUser,
          password: this.config.streamPassword,
          port: this.kOnvifPort,
          timeout: this.kOnvifTimeout,
        },
        (err: Error) => {
          if (resolved) return;
          resolved = true;
          this.connectPromise = undefined;
          if (err) {
            return reject(err);
          }
          this.device = device;
          return resolve(this.device);
        }
      );
    });

    return this.connectPromise;
  }

  get onvifConnected(): boolean {
    return Boolean(this.device && this.isListening);
  }

  async getEventEmitter(): Promise<EventEmitter> {
    if (this.events) {
      return this.events;
    }

    this.events = new EventEmitter();
    try {
      await this.startOnvifListener();
    } catch (err) {
      this.log.debug(
        "Failed initial ONVIF listener start, will retry automatically:",
        err instanceof Error ? err.message : err
      );
      this.scheduleAutoReconnect();
    }

    return this.events;
  }

  public resetMotionState(): void {
    if (this.lastMotionValue) {
      this.lastMotionValue = false;
      if (this.events) {
        this.events.emit("motion", false);
      }
    }
  }

  private stopOnvifListener(): void {
    this.isListening = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    if (this.device) {
      try {
        this.device.removeAllListeners("event");
        this.device.removeAllListeners("eventsError");
        this.device.removeAllListeners("error");
        this.device.removeAllListeners("rawResponse");
        this.device.removeAllListeners("rawRequest");
        if (typeof this.device.unsubscribe === "function") {
          try {
            this.device.unsubscribe(() => {}, true);
          } catch {
            // ignore unsubscribe failure during teardown
          }
        }
      } catch {
        // ignore errors during teardown
      }
      this.device = undefined;
    }
  }

  private scheduleAutoReconnect(delayMs?: number): void {
    if (this.reconnectTimeout) {
      return;
    }
    const delay = delayMs ?? this.reconnectBackoffMs;
    this.log.debug(`Scheduling ONVIF reconnect in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = undefined;
      try {
        const success = await this.restartOnvifConnection();
        if (success) {
          this.reconnectBackoffMs = 5000;
        } else {
          this.reconnectBackoffMs = Math.min(
            Math.round(this.reconnectBackoffMs * 1.5),
            60000
          );
          this.scheduleAutoReconnect();
        }
      } catch {
        this.reconnectBackoffMs = Math.min(
          Math.round(this.reconnectBackoffMs * 1.5),
          60000
        );
        this.scheduleAutoReconnect();
      }
    }, delay);
  }

  async restartOnvifConnection(): Promise<boolean> {
    if (!this.events) {
      return false;
    }
    if (this.isConnecting) {
      this.log.debug("ONVIF reconnection already in progress, waiting...");
      try {
        if (this.connectPromise) {
          await this.connectPromise;
          return this.onvifConnected;
        }
      } catch {
        return false;
      }
    }

    this.isConnecting = true;
    this.log.debug("Restarting ONVIF connection...");
    this.stopOnvifListener();

    try {
      await this.startOnvifListener();
      this.log.info("ONVIF motion listener successfully established.");
      this.reconnectBackoffMs = 5000;
      return true;
    } catch (err) {
      this.log.debug(
        "Failed to restart ONVIF connection:",
        err instanceof Error ? err.message : err
      );
      this.resetMotionState();
      this.stopOnvifListener();
      return false;
    } finally {
      this.isConnecting = false;
    }
  }

  private handleOnvifEvent(event: NotificationMessage): void {
    const rawTopic =
      typeof event?.topic === "string"
        ? event.topic
        : event?.topic?._;

    if (
      rawTopic &&
      (rawTopic.match(/CellMotionDetector\/Motion/i) ||
        rawTopic.match(/RuleEngine\/.*Motion/i) ||
        rawTopic.match(/VideoAnalytics\/.*Motion/i))
    ) {
      let motionValue: boolean | undefined = undefined;

      const simpleItem = event?.message?.message?.data?.simpleItem;
      if (simpleItem) {
        const items = Array.isArray(simpleItem) ? simpleItem : [simpleItem];
        for (const item of items) {
          const val = item?.$?.Value ?? item?.Value;
          if (val !== undefined) {
            if (typeof val === "boolean") {
              motionValue = val;
            } else if (typeof val === "string") {
              const lower = val.toLowerCase().trim();
              motionValue = lower === "true" || lower === "1" || lower === "on";
            } else if (typeof val === "number") {
              motionValue = val === 1;
            }
          }
        }
      }

      if (motionValue !== undefined && motionValue !== this.lastMotionValue) {
        this.lastMotionValue = motionValue;
        if (this.events) {
          this.events.emit("motion", motionValue);
        }
      }
    }
  }

  private async startOnvifListener(): Promise<void> {
    const onvifDevice = await this.getDevice();

    this.log.debug("Starting ONVIF listener...");

    onvifDevice.on("event", (event: NotificationMessage) => {
      this.handleOnvifEvent(event);
    });

    onvifDevice.on("eventsError", (err: Error) => {
      this.log.debug(
        "ONVIF events error received:",
        err?.message || err
      );
      this.isListening = false;
      this.resetMotionState();
      this.stopOnvifListener();
      this.scheduleAutoReconnect();
    });

    onvifDevice.on("error", (err: Error) => {
      this.log.debug(
        "ONVIF device error received:",
        err?.message || err
      );
      this.isListening = false;
      this.resetMotionState();
      this.stopOnvifListener();
      this.scheduleAutoReconnect();
    });

    this.isListening = true;
    this.reconnectBackoffMs = 5000;
  }

  async getDeviceInfo(): Promise<DeviceInformation> {
    const onvifDevice = await this.getDevice();
    return new Promise((resolve, reject) => {
      onvifDevice.getDeviceInformation((err, deviceInformation) => {
        if (err) return reject(err);
        resolve(deviceInformation);
      });
    });
  }
}
