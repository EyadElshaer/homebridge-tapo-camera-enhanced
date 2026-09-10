import { Logging } from "homebridge";
import { CameraConfig } from "./cameraAccessory";
import crypto from "crypto";
import { OnvifCamera } from "./onvifCamera";
import type {
  TAPOBasicInfo,
  TAPOCameraEncryptedRequest,
  TAPOCameraEncryptedResponse,
  TAPOCameraLoginResponse,
  TAPOCameraRefreshStokResponse,
  TAPOCameraRequest,
  TAPOCameraResponse,
  TAPOCameraResponseDeviceInfo,
  TAPOCameraGetRequest,
  TAPOCameraSetRequest,
} from "./types/tapo";
import { Agent } from "undici";

const MAX_LOGIN_RETRIES = 2;
const AES_BLOCK_SIZE = 16;
const ERROR_CODES_MAP = {
  "-40401": "Invalid stok value",
  "-40210": "Function not supported",
  "-64303": "Action cannot be done while camera is in patrol mode.",
  "-64324": "Privacy mode is ON, not able to execute",
  "-64302": "Preset ID not found",
  "-64321": "Preset ID was deleted so no longer exists",
  "-40106": "Parameter to get/do does not exist",
  "-40105": "Method does not exist",
  "-40101": "Parameter to set does not exist",
  "-40209": "Invalid login credentials",
  "-64304": "Maximum Pan/Tilt range reached",
  "-71103": "User ID is not authorized",
};

export type Status = {
  eyes: boolean | undefined;
  alarm: boolean | undefined;
  notifications: boolean | undefined;
  motionDetection: boolean | undefined;
  led: boolean | undefined;
  floodLight: boolean | undefined;
};

export class TAPOCamera extends OnvifCamera {
  private readonly kStreamPort = 554;
  private readonly fetchAgent: Agent;

  private readonly hashedPassword: string;
  private readonly hashedSha256Password: string;
  private readonly hashedSha1Password: string;
  private passwordEncryptionMethod: "md5" | "sha256" | "sha1" | null = null;

  private isSecureConnectionValue: boolean | null = null;



  private readonly cnonce: string;
  private lsk: Buffer | undefined;
  private ivb: Buffer | undefined;
  private seq: number | undefined;
  private stok: string | undefined;

  constructor(
    protected readonly log: Logging,
    protected readonly config: CameraConfig
  ) {
    super(log, config);

    this.fetchAgent = new Agent({
      connectTimeout: 5_000,
      connect: {
        // TAPO devices have self-signed certificates
        rejectUnauthorized: false,
        ciphers: "ALL:@SECLEVEL=0",
      },
    });

    this.cnonce = this.generateCnonce();

    this.hashedPassword = crypto
      .createHash("md5")
      .update(config.password)
      .digest("hex")
      .toUpperCase();
    this.hashedSha256Password = crypto
      .createHash("sha256")
      .update(config.password)
      .digest("hex")
      .toUpperCase();
    this.hashedSha1Password = crypto
      .createHash("sha1")
      .update(config.password)
      .digest("hex")
      .toUpperCase();
  }

  private getUsername() {
    return this.config.username || "admin";
  }

  private getHeaders(): Record<string, string> {
    return {
      Host: `https://${this.config.ipAddress}`,
      Referer: `https://${this.config.ipAddress}`,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": "Tapo CameraClient Android",
      Connection: "close",
      requestByApp: "true",
      "Content-Type": "application/json; charset=UTF-8",
    };
  }

  private getHashedPassword() {
    if (this.passwordEncryptionMethod === "md5") {
      return this.hashedPassword;
    } else if (this.passwordEncryptionMethod === "sha256") {
      return this.hashedSha256Password;
    } else if (this.passwordEncryptionMethod === "sha1") {
      return this.hashedSha1Password;
    } else {
      throw new Error("Unknown password encryption method");
    }
  }

  private fetch(url: string, data: RequestInit) {
    return fetch(url, {
      headers: this.getHeaders(),
      // @ts-expect-error Dispatcher type not there
      dispatcher: this.fetchAgent,
      ...data,
    });
  }

  private generateEncryptionToken(tokenType: string, nonce: string): Buffer {
    const hashedKey = crypto
      .createHash("sha256")
      .update(this.cnonce + this.getHashedPassword() + nonce)
      .digest("hex")
      .toUpperCase();
    return crypto
      .createHash("sha256")
      .update(tokenType + this.cnonce + nonce + hashedKey)
      .digest()
      .slice(0, 16);
  }

  getAuthenticatedStreamUrl(lowQuality = false) {
    const prefix = `rtsp://${this.config.streamUser}:${this.config.streamPassword}@${this.config.ipAddress}:${this.kStreamPort}`;
    return lowQuality ? `${prefix}/stream2` : `${prefix}/stream1`;
  }

  private generateCnonce() {
    return crypto.randomBytes(8).toString("hex").toUpperCase();
  }

  private validateDeviceConfirm(nonce: string, deviceConfirm: string) {
    this.passwordEncryptionMethod = null;

    const hashedNoncesWithSHA256 = crypto
      .createHash("sha256")
      .update(this.cnonce + this.hashedSha256Password + nonce)
      .digest("hex")
      .toUpperCase();
    if (deviceConfirm === hashedNoncesWithSHA256 + nonce + this.cnonce) {
      this.passwordEncryptionMethod = "sha256";
      return true;
    }

    const hashedNoncesWithMD5 = crypto
      .createHash("md5")
      .update(this.cnonce + this.hashedPassword + nonce)
      .digest("hex")
      .toUpperCase();
    if (deviceConfirm === hashedNoncesWithMD5 + nonce + this.cnonce) {
      this.passwordEncryptionMethod = "md5";
      return true;
    }

    const hashedNoncesWithSHA1 = crypto
      .createHash("sha1")
      .update(this.cnonce + this.hashedSha1Password + nonce)
      .digest("hex")
      .toUpperCase();
    if (deviceConfirm === hashedNoncesWithSHA1 + nonce + this.cnonce) {
      this.passwordEncryptionMethod = "sha1";
      return true;
    }

    this.log.debug(
      'Invalid device confirm, expected "sha256", "md5", or "sha1" to match, but none found',
      {
        hashedNoncesWithMD5,
        hashedNoncesWithSHA256,
        hashedNoncesWithSHA1,
        deviceConfirm,
        nonce,
        cnonce: this.cnonce,
      }
    );

    return this.passwordEncryptionMethod !== null;
  }

  async refreshStok(loginRetryCount = 0): Promise<void> {
    this.log.debug("refreshStok: Refreshing stok...");

    const isSecureConnection = await this.isSecureConnection();

    let fetchParams = {};
    if (isSecureConnection) {
      fetchParams = {
        method: "post",
        body: JSON.stringify({
          method: "login",
          params: {
            cnonce: this.cnonce,
            encrypt_type: "3",
            username: this.getUsername(),
          },
        }),
      };
    } else {
      fetchParams = {
        method: "post",
        body: JSON.stringify({
          method: "login",
          params: {
            username: this.getUsername(),
            password: this.hashedPassword,
            hashed: true,
          },
        }),
      };
    }

    const responseLogin = await this.fetch(
      `https://${this.config.ipAddress}`,
      fetchParams
    );
    const responseLoginData =
      (await responseLogin.json()) as TAPOCameraRefreshStokResponse;

    let response, responseData;

    if (!responseLoginData) {
      this.log.debug(
        "refreshStok: empty response login data, raising exception",
        responseLogin.status
      );
      throw new Error("Empty response login data");
    }

    this.log.debug(
      "refreshStok: Login response",
      responseLogin.status,
      responseLoginData
    );

    if (
      responseLogin.status === 401 &&
      responseLoginData.result?.data?.code === -40411
    ) {
      this.log.debug(
        "refreshStok: invalid credentials, raising exception",
        responseLogin.status
      );
      throw new Error("Invalid credentials");
    }

    if (isSecureConnection) {
      const nonce = responseLoginData.result?.data?.nonce;
      const deviceConfirm = responseLoginData.result?.data?.device_confirm;
      if (
        nonce &&
        deviceConfirm &&
        this.validateDeviceConfirm(nonce, deviceConfirm)
      ) {
        const digestPasswd = crypto
          .createHash("sha256")
          .update(this.getHashedPassword() + this.cnonce + nonce)
          .digest("hex")
          .toUpperCase();

        const digestPasswdFull = Buffer.concat([
          Buffer.from(digestPasswd, "utf8"),
          Buffer.from(this.cnonce!, "utf8"),
          Buffer.from(nonce, "utf8"),
        ]).toString("utf8");

        this.log.debug("refreshStok: sending start_seq request");

        response = await this.fetch(`https://${this.config.ipAddress}`, {
          method: "POST",
          body: JSON.stringify({
            method: "login",
            params: {
              cnonce: this.cnonce,
              encrypt_type: "3",
              digest_passwd: digestPasswdFull,
              username: this.getUsername(),
            },
          }),
        });

        responseData = (await response.json()) as TAPOCameraRefreshStokResponse;

        if (!responseData) {
          this.log.debug(
            "refreshStok: empty response start_seq data, raising exception",
            response.status
          );
          throw new Error("Empty response start_seq data");
        }

        this.log.debug(
          "refreshStok: start_seq response",
          response.status,
          JSON.stringify(responseData)
        );

        if (responseData.result?.start_seq) {
          if (responseData.result?.user_group !== "root") {
            this.log.debug("refreshStok: Incorrect user_group detected");

            // # encrypted control via 3rd party account does not seem to be supported
            // # see https://github.com/JurajNyiri/HomeAssistant-Tapo-Control/issues/456
            throw new Error("Incorrect user_group detected");
          }

          this.lsk = this.generateEncryptionToken("lsk", nonce);
          this.ivb = this.generateEncryptionToken("ivb", nonce);
          this.seq = responseData.result.start_seq;
        }
      } else {
        if (
          (responseLoginData.error_code === -40413 ||
            responseLoginData.error_code === -40211) &&
          loginRetryCount < MAX_LOGIN_RETRIES
        ) {
          this.log.debug(
            `refreshStok: Invalid device confirm, retrying: ${loginRetryCount}/${MAX_LOGIN_RETRIES}.`,
            responseLogin.status,
            responseLoginData
          );
          return this.refreshStok(loginRetryCount + 1);
        }

        this.log.debug(
          "refreshStok: Invalid device confirm and loginRetryCount exhausted, raising exception",
          loginRetryCount,
          responseLoginData
        );
        throw new Error("Invalid device confirm");
      }
    } else {
      this.passwordEncryptionMethod = "md5";
      response = responseLogin;
      responseData = responseLoginData;
    }

    const secLeft =
      responseData.result?.data?.sec_left ?? responseData.result?.sec_left;
    if (secLeft && secLeft > 0) {
      this.log.debug("refreshStok: temporary suspension", responseData);

      throw new Error(`Temporary Suspension: Try again in ${secLeft} seconds`);
    }

    if (
      responseData?.data?.code === -40404 &&
      responseData?.data?.sec_left &&
      responseData.data.sec_left > 0
    ) {
      this.log.debug("refreshStok: temporary suspension", responseData);

      throw new Error(
        `refreshStok: Temporary Suspension: Try again in ${responseData.data.sec_left} seconds`
      );
    }

    if (responseData?.result?.stok) {
      this.stok = responseData.result.stok;
      this.log.debug("refreshStok: Success in obtaining STOK", this.stok);
      return;
    }

    if (
      responseData?.error_code === -40413 &&
      loginRetryCount < MAX_LOGIN_RETRIES
    ) {
      this.log.debug(
        `refreshStok: Unexpected response, retrying: ${loginRetryCount}/${MAX_LOGIN_RETRIES}.`,
        response.status,
        responseData
      );
      return this.refreshStok(loginRetryCount + 1);
    }

    this.log.debug("refreshStok: Unexpected end of flow, raising exception");
    throw new Error("Invalid authentication data");
  }

  async isSecureConnection() {
    if (this.isSecureConnectionValue === null) {
      this.log.debug("isSecureConnection: Checking secure connection...");

      const response = await this.fetch(`https://${this.config.ipAddress}`, {
        method: "post",
        body: JSON.stringify({
          method: "login",
          params: {
            encrypt_type: "3",
            username: this.getUsername(),
          },
        }),
      });
      const responseData = (await response.json()) as TAPOCameraLoginResponse;

      this.log.debug(
        "isSecureConnection response",
        response.status,
        JSON.stringify(responseData)
      );

      const errCode = responseData?.error_code;
      this.isSecureConnectionValue =
        // -40211 = newer firmware requires cnonce in request (probe doesn't send it)
        errCode == -40211 ||
        (errCode == -40413 &&
          String(responseData.result?.data?.encrypt_type || "")?.includes("3"));
    }

    return this.isSecureConnectionValue;
  }

  private stokPromise: Promise<string> | undefined;

  getStok(loginRetryCount = 0): Promise<string> {
    if (this.stok) {
      return Promise.resolve(this.stok);
    }

    if (!this.stokPromise) {
      this.stokPromise = this.refreshStok(loginRetryCount)
        .then(() => {
          if (!this.stok) {
            throw new Error("STOK not found");
          }
          return this.stok;
        })
        .finally(() => {
          this.stokPromise = undefined;
        });
    }

    return this.stokPromise;
  }

  private async getAuthenticatedAPIURL(loginRetryCount = 0) {
    const token = await this.getStok(loginRetryCount);
    return `https://${this.config.ipAddress}/stok=${token}/ds`;
  }

  encryptRequest(request: string) {
    const cipher = crypto.createCipheriv("aes-128-cbc", this.lsk!, this.ivb!);
    let ct_bytes = cipher.update(
      this.encryptPad(request, AES_BLOCK_SIZE),
      "utf-8",
      "hex"
    );
    ct_bytes += cipher.final("hex");
    return Buffer.from(ct_bytes, "hex");
  }

  private encryptPad(text: string, blocksize: number) {
    const padSize = blocksize - (text.length % blocksize);
    const padding = String.fromCharCode(padSize).repeat(padSize);
    return text + padding;
  }

  private decryptResponse(response: string): string {
    const decipher = crypto.createDecipheriv(
      "aes-128-cbc",
      this.lsk!,
      this.ivb!
    );
    let decrypted = decipher.update(response, "base64", "utf-8");
    decrypted += decipher.final("utf-8");
    return this.encryptUnpad(decrypted, AES_BLOCK_SIZE);
  }

  private encryptUnpad(text: string, blockSize: number): string {
    const paddingLength = Number(text[text.length - 1]) || 0;
    if (paddingLength > blockSize || paddingLength > text.length) {
      throw new Error("Invalid padding");
    }
    for (let i = text.length - paddingLength; i < text.length; i++) {
      if (text.charCodeAt(i) !== paddingLength) {
        throw new Error("Invalid padding");
      }
    }
    return text.slice(0, text.length - paddingLength).toString();
  }

  private getTapoTag(request: TAPOCameraEncryptedRequest) {
    const tag = crypto
      .createHash("sha256")
      .update(this.getHashedPassword() + this.cnonce)
      .digest("hex")
      .toUpperCase();
    return crypto
      .createHash("sha256")
      .update(tag + JSON.stringify(request) + this.seq!.toString())
      .digest("hex")
      .toUpperCase();
  }

  private pendingAPIRequests: Map<string, Promise<TAPOCameraResponse>> =
    new Map();

  private async apiRequest<T extends TAPOCameraRequest>(
    req: T,
    loginRetryCount = 0
  ): Promise<TAPOCameraResponse> {
    const reqJson = JSON.stringify(req);

    if (this.pendingAPIRequests.has(reqJson)) {
      this.log.debug("API request already pending", reqJson);
      return this.pendingAPIRequests.get(
        reqJson
      ) as Promise<TAPOCameraResponse>;
    } else {
      this.log.debug("New API request", reqJson);
    }

    const reqPromise = (async () => {
      try {
        const url = await this.getAuthenticatedAPIURL(loginRetryCount);

        const fetchParams: Record<string, unknown> = { method: "post" };
        const isSecureConnection = await this.isSecureConnection();

        if (this.seq && isSecureConnection) {
          const encryptedRequest: TAPOCameraEncryptedRequest = {
            method: "securePassthrough",
            params: {
              request: Buffer.from(
                this.encryptRequest(JSON.stringify(req))
              ).toString("base64"),
            },
          };
          fetchParams.headers = {
            ...this.getHeaders(),
            Tapo_tag: this.getTapoTag(encryptedRequest),
            Seq: this.seq.toString(),
          };
          fetchParams.body = JSON.stringify(encryptedRequest);
          this.seq += 1;
        } else {
          fetchParams.body = JSON.stringify(req);
        }

        const response = await this.fetch(url, fetchParams);
        const responseDataTmp = await response.json();

        // Apparently the Tapo C200 returns 500 on successful requests,
        // but it's indicating an expiring token, therefore refresh the token next time
        if (isSecureConnection && response.status === 500) {
          this.log.debug(
            "Stok expired, reauthenticating on next request, setting STOK to undefined"
          );
          this.stok = undefined;
        }

        let responseData: TAPOCameraResponse | null = null;

        if (isSecureConnection) {
          const encryptedResponse =
            responseDataTmp as TAPOCameraEncryptedResponse;
          if (encryptedResponse?.result?.response) {
            const decryptedResponse = this.decryptResponse(
              encryptedResponse.result.response
            );
            responseData = JSON.parse(
              decryptedResponse
            ) as TAPOCameraResponse;
          }
        } else {
          responseData = responseDataTmp as TAPOCameraResponse;
        }

        this.log.debug(
          "API response",
          response.status,
          JSON.stringify(responseData)
        );

        // Log error codes
        if (responseData && responseData.error_code !== 0) {
          const errorCode = String(responseData.error_code);
          const errorMessage =
            errorCode in ERROR_CODES_MAP
              ? ERROR_CODES_MAP[errorCode as keyof typeof ERROR_CODES_MAP]
              : "Unknown error";
          this.log.debug(
            `API request failed with specific error code ${errorCode}: ${errorMessage}`
          );
        }

        if (
          !responseData ||
          responseData.error_code === -40401 ||
          responseData.error_code === -1
        ) {
          this.log.debug(
            "API request failed, reauth now and trying same request again",
            responseData
          );
          this.stok = undefined;
          return this.apiRequest(req, loginRetryCount + 1);
        }

        // Success
        return responseData;
      } finally {
        this.pendingAPIRequests.delete(reqJson);
      }
    })();

    this.pendingAPIRequests.set(reqJson, reqPromise);
    return reqPromise;
  }

  static SERVICE_MAP: Record<
    keyof Status,
    (value: boolean) => TAPOCameraSetRequest
  > = {
    eyes: (value) => ({
      method: "setLensMaskConfig",
      params: {
        lens_mask: {
          lens_mask_info: {
            // Watch out for the inversion
            enabled: value ? "off" : "on",
          },
        },
      },
    }),
    alarm: (value) => ({
      method: "setAlertConfig",
      params: {
        msg_alarm: {
          chn1_msg_alarm_info: {
            enabled: value ? "on" : "off",
          },
        },
      },
    }),
    notifications: (value) => ({
      method: "setMsgPushConfig",
      params: {
        msg_push: {
          chn1_msg_push_info: {
            notification_enabled: value ? "on" : "off",
            rich_notification_enabled: value ? "on" : "off",
          },
        },
      },
    }),
    motionDetection: (value) => ({
      method: "setDetectionConfig",
      params: {
        motion_detection: {
          motion_det: {
            enabled: value ? "on" : "off",
          },
        },
      },
    }),
    led: (value) => ({
      method: "setLedStatus",
      params: {
        led: {
          config: {
            enabled: value ? "on" : "off",
          },
        },
      },
    }),
    floodLight: (value) => ({
      method: "setWhitelampConfig",
      params: {
        image: {
          switch: {
            force_wtl_state: value ? "on" : "off",
            wtl_force_time: value ? 300 : 0,
          },
        },
      },
    }),
  };

  private workingFloodlightMethodIndex: number | null = null;

  private getFloodlightCandidateRequests(value: boolean): Array<{
    method: string;
    params: Record<string, unknown>;
  }> {
    const strVal = value ? "on" : "off";
    return [
      // 1. setNightVisionModeConfig with common night_vision_mode (Tapo C510W, C520WS, C500, C320WS standard spotlight mode)
      {
        method: "setNightVisionModeConfig",
        params: {
          image: {
            common: {
              night_vision_mode: value ? "wtl_night_vision" : "inf_night_vision",
            },
          },
        },
      },
      // 2. setNightVisionModeConfig with switch night_vision_mode
      {
        method: "setNightVisionModeConfig",
        params: {
          image: {
            switch: {
              night_vision_mode: value ? "wtl_night_vision" : "inf_night_vision",
            },
          },
        },
      },
      // 3. setNightVisionModeConfig with direct image night_vision_mode
      {
        method: "setNightVisionModeConfig",
        params: {
          image: {
            night_vision_mode: value ? "wtl_night_vision" : "inf_night_vision",
          },
        },
      },
      // 4. setNightVisionModeConfig with common full_color
      {
        method: "setNightVisionModeConfig",
        params: {
          image: {
            common: {
              night_vision_mode: value ? "full_color" : "inf_night_vision",
            },
          },
        },
      },
      // 5. setNightVisionModeConfig with switch full_color
      {
        method: "setNightVisionModeConfig",
        params: {
          image: {
            switch: {
              night_vision_mode: value ? "full_color" : "inf_night_vision",
            },
          },
        },
      },
      // 6. setNightVisionModeConfig with common smart (md_night_vision off fallback)
      {
        method: "setNightVisionModeConfig",
        params: {
          image: {
            common: {
              night_vision_mode: value ? "wtl_night_vision" : "md_night_vision",
            },
          },
        },
      },
      // 7. setWhitelampConfig with switch force_wtl_state and wtl_force_time (standard Tapo app payload)
      {
        method: "setWhitelampConfig",
        params: {
          image: {
            switch: {
              force_wtl_state: strVal,
              wtl_force_time: value ? 300 : 0,
            },
          },
        },
      },
      // 8. setWhitelampConfig with switch force_wtl_state only
      {
        method: "setWhitelampConfig",
        params: {
          image: {
            switch: {
              force_wtl_state: strVal,
            },
          },
        },
      },
      // 9. setWhitelampConfig with common force_wtl_state
      {
        method: "setWhitelampConfig",
        params: {
          image: {
            common: {
              force_wtl_state: strVal,
            },
          },
        },
      },
      // 10. setWhitelampConfig with direct image force_wtl_state
      {
        method: "setWhitelampConfig",
        params: {
          image: {
            force_wtl_state: strVal,
          },
        },
      },
      // 11. setForceWhitelampState with switch
      {
        method: "setForceWhitelampState",
        params: {
          image: {
            switch: {
              force_wtl_state: strVal,
            },
          },
        },
      },
      // 12. setForceWhitelampState with direct image force_wtl_state
      {
        method: "setForceWhitelampState",
        params: {
          image: {
            force_wtl_state: strVal,
          },
        },
      },
      // 13. setForceWhitelampState with root force_wtl_state
      {
        method: "setForceWhitelampState",
        params: {
          force_wtl_state: strVal,
        },
      },
      // 14. setWhitelampStatus with set_wtl_status (on/off)
      {
        method: "setWhitelampStatus",
        params: {
          image: {
            set_wtl_status: {
              status: strVal,
            },
          },
        },
      },
      // 15. setWhitelampStatus with set_wtl_status (numeric 1/0)
      {
        method: "setWhitelampStatus",
        params: {
          image: {
            set_wtl_status: {
              status: value ? 1 : 0,
            },
          },
        },
      },
      // 16. setWhitelampStatus with wtl_status (on/off)
      {
        method: "setWhitelampStatus",
        params: {
          image: {
            wtl_status: {
              status: strVal,
            },
          },
        },
      },
      // 17. setAlertConfig (light alarm / spotlight trigger)
      {
        method: "setAlertConfig",
        params: {
          msg_alarm: {
            chn1_msg_alarm_info: {
              alarm_mode: ["light"],
              enabled: strVal,
            },
          },
        },
      },
    ];
  }

  private async setFloodLightStatus(value: boolean): Promise<object> {
    const candidates = this.getFloodlightCandidateRequests(value);

    // If a working candidate index is already known, try it first
    if (this.workingFloodlightMethodIndex !== null) {
      const preferred = candidates[this.workingFloodlightMethodIndex];
      if (preferred) {
        try {
          const responseData = await this.apiRequest({
            method: "multipleRequest",
            params: {
              requests: [preferred as unknown as TAPOCameraSetRequest],
            },
          });
          if (responseData.error_code === 0) {
            const op = responseData.result.responses.find(
              (e) => e.method === preferred.method
            );
            if (op && op.error_code === 0) {
              this.log.debug(
                `Floodlight set to ${value ? "on" : "off"} using cached candidate #${this.workingFloodlightMethodIndex} (${preferred.method})`
              );
              return op.result || {};
            }
          }
        } catch (err) {
          this.log.debug(
            `Cached floodlight candidate #${this.workingFloodlightMethodIndex} failed, retrying other candidates:`,
            err
          );
        }
      }
      this.workingFloodlightMethodIndex = null;
    }

    const errors: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const responseData = await this.apiRequest({
          method: "multipleRequest",
          params: {
            requests: [candidate as unknown as TAPOCameraSetRequest],
          },
        });

        if (responseData.error_code !== 0) {
          errors.push(
            `#${i} (${candidate.method}): error_code ${responseData.error_code}`
          );
          continue;
        }

        const op = responseData.result.responses.find(
          (e) => e.method === candidate.method
        );
        if (op && op.error_code === 0) {
          this.workingFloodlightMethodIndex = i;
          this.log.info(
            `Successfully set floodlight to ${value ? "on" : "off"} on camera "${this.config.name}" using candidate #${i} (${candidate.method})`
          );
          return op.result || {};
        } else {
          errors.push(
            `#${i} (${candidate.method}): operation error_code ${op?.error_code}`
          );
        }
      } catch (err) {
        errors.push(
          `#${i} (${candidate.method}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const failureSummary = errors.join("; ");
    this.log.error(
      `Failed to set floodlight to ${value ? "on" : "off"} on camera "${this.config.name}". Attempts: ${failureSummary}`
    );
    throw new Error(
      `Failed to perform floodLight action on camera "${this.config.name}": ${failureSummary}`
    );
  }

  async setStatus(service: keyof Status, value: boolean) {
    if (service === "floodLight") {
      return this.setFloodLightStatus(value);
    }

    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests: [TAPOCamera.SERVICE_MAP[service](value)],
      },
    });

    if (responseData.error_code !== 0) {
      throw new Error(`Failed to perform ${service} action`);
    }

    const method = TAPOCamera.SERVICE_MAP[service](value).method;
    const operation = responseData.result.responses.find(
      (e) => e.method === method
    );
    if (operation?.error_code !== 0) {
      throw new Error(`Failed to perform ${service} action`);
    }

    return operation.result;
  }

  async getBasicInfo(): Promise<TAPOBasicInfo> {
    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests: [
          {
            method: "getDeviceInfo",
            params: {
              device_info: {
                name: ["basic_info"],
              },
            },
          },
        ],
      },
    });

    const info = responseData.result
      .responses[0] as TAPOCameraResponseDeviceInfo;
    return info.result.device_info.basic_info;
  }

  async getStatus(): Promise<Status> {
    const requests: (TAPOCameraGetRequest | TAPOCameraSetRequest)[] = [
      {
        method: "getAlertConfig",
        params: {
          msg_alarm: {
            name: "chn1_msg_alarm_info",
          },
        },
      },
      {
        method: "getLensMaskConfig",
        params: {
          lens_mask: {
            name: "lens_mask_info",
          },
        },
      },
      {
        method: "getMsgPushConfig",
        params: {
          msg_push: {
            name: "chn1_msg_push_info",
          },
        },
      },
      {
        method: "getDetectionConfig",
        params: {
          motion_detection: {
            name: "motion_det",
          },
        },
      },
      {
        method: "getLedStatus",
        params: {
          led: {
            name: "config",
          },
        },
      },
    ];

    if (this.config.enableFloodLightAccessory) {
      requests.push({
        method: "getWhitelampStatus",
        params: {
          image: {
            get_wtl_status: ["null"],
          },
        },
      } as TAPOCameraGetRequest);
      requests.push({
        method: "getWhitelampConfig",
        params: {
          image: {
            name: ["switch", "common", "get_wtl_status"],
          },
        },
      } as TAPOCameraGetRequest);
      requests.push({
        method: "getNightVisionModeConfig",
        params: {
          image: {
            name: ["common", "switch"],
          },
        },
      } as TAPOCameraGetRequest);
    }

    const responseData = await this.apiRequest({
      method: "multipleRequest",
      params: {
        requests,
      },
    });

    const operations = responseData.result.responses;

    const alert = operations.find((r) => r.method === "getAlertConfig");
    const lensMask = operations.find((r) => r.method === "getLensMaskConfig");
    const notifications = operations.find(
      (r) => r.method === "getMsgPushConfig"
    );
    const motionDetection = operations.find(
      (r) => r.method === "getDetectionConfig"
    );
    const led = operations.find((r) => r.method === "getLedStatus");

    let isFloodLightOn: boolean | undefined = undefined;
    if (this.config.enableFloodLightAccessory) {
      const wtlStatus = operations.find(
        (r) => r.method === "getWhitelampStatus"
      );
      const wtlConfig = operations.find(
        (r) => r.method === "getWhitelampConfig"
      );
      const nvConfig = operations.find(
        (r) => r.method === "getNightVisionModeConfig"
      );

      // 1. Parse getWhitelampStatus response
      if (
        wtlStatus &&
        wtlStatus.error_code === 0 &&
        wtlStatus.result &&
        typeof wtlStatus.result === "object"
      ) {
        const img = (wtlStatus.result as Record<string, unknown>).image as
          | Record<string, unknown>
          | undefined;
        if (img) {
          const wtlObj = (img.get_wtl_status ||
            img.wtl_status ||
            img.switch) as Record<string, unknown> | undefined;
          if (wtlObj) {
            const s = wtlObj.status ?? wtlObj.force_wtl_state;
            if (s === "on" || s === "1" || s === 1 || s === true) {
              isFloodLightOn = true;
            } else if (s === "off" || s === "0" || s === 0 || s === false) {
              isFloodLightOn = false;
            }
          }
        }
      }

      // 2. Parse getWhitelampConfig response
      if (
        isFloodLightOn === undefined &&
        wtlConfig &&
        wtlConfig.error_code === 0 &&
        wtlConfig.result &&
        typeof wtlConfig.result === "object"
      ) {
        const img = (wtlConfig.result as Record<string, unknown>).image as
          | Record<string, unknown>
          | undefined;
        if (img) {
          const sw = img.switch as Record<string, unknown> | undefined;
          const common = img.common as Record<string, unknown> | undefined;
          const forceState = (sw?.force_wtl_state ??
            common?.force_wtl_state ??
            img.force_wtl_state) as unknown;
          if (
            forceState === "on" ||
            forceState === "1" ||
            forceState === 1 ||
            forceState === true
          ) {
            isFloodLightOn = true;
          } else if (
            forceState === "off" ||
            forceState === "0" ||
            forceState === 0 ||
            forceState === false
          ) {
            isFloodLightOn = false;
          }
        }
      }

      // 3. Parse getNightVisionModeConfig response (fallback / Tapo C510W, C520WS, C500, C320WS)
      if (
        isFloodLightOn === undefined &&
        nvConfig &&
        nvConfig.error_code === 0 &&
        nvConfig.result &&
        typeof nvConfig.result === "object"
      ) {
        const img = (nvConfig.result as Record<string, unknown>).image as
          | Record<string, unknown>
          | undefined;
        if (img) {
          const common = img.common as Record<string, unknown> | undefined;
          const sw = img.switch as Record<string, unknown> | undefined;
          const mode = (common?.night_vision_mode ??
            sw?.night_vision_mode ??
            img.night_vision_mode) as unknown;
          if (typeof mode === "string") {
            const lowerMode = mode.toLowerCase();
            if (
              lowerMode === "wtl_night_vision" ||
              lowerMode === "full_color" ||
              lowerMode === "on"
            ) {
              isFloodLightOn = true;
            } else if (
              lowerMode === "inf_night_vision" ||
              lowerMode === "md_night_vision" ||
              lowerMode === "smart" ||
              lowerMode === "shed_night_vision" ||
              lowerMode === "dbl_night_vision" ||
              lowerMode === "off" ||
              lowerMode === "auto"
            ) {
              isFloodLightOn = false;
            }
          } else if (typeof mode === "boolean") {
            isFloodLightOn = mode;
          }
        }
      }
    }

    if (!alert) this.log.debug("No alert config found");
    if (!lensMask) this.log.debug("No lens mask config found");
    if (!notifications) this.log.debug("No notifications config found");
    if (!motionDetection) this.log.debug("No motion detection config found");
    if (!led) this.log.debug("No led config found");

    return {
      alarm: alert
        ? alert.result.msg_alarm.chn1_msg_alarm_info.enabled === "on"
        : undefined,
      // Watch out for the inversion
      eyes: lensMask
        ? lensMask.result.lens_mask.lens_mask_info.enabled === "off"
        : undefined,
      notifications: notifications
        ? notifications.result.msg_push.chn1_msg_push_info
            .notification_enabled === "on"
        : undefined,
      motionDetection: motionDetection
        ? motionDetection.result.motion_detection.motion_det.enabled === "on"
        : undefined,
      led: led ? led.result.led.config.enabled === "on" : undefined,
      floodLight: isFloodLightOn,
    };
  }
}
