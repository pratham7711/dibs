import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TWITCH_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "channel:read:redemptions",
] as const;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const DEVICE_URL = "https://id.twitch.tv/oauth2/device";

export interface TwitchTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id?: string;
  login?: string;
  scope?: string[];
}

interface DeviceResponse {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
}

interface AuthOptions {
  clientId?: string;
  directory?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class TwitchAuth {
  private readonly env: Record<string, string | undefined>;
  private readonly clientId: string;
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private tokens?: TwitchTokens;

  constructor(options: AuthOptions = {}) {
    this.env = options.env ?? process.env;
    this.clientId = options.clientId ?? this.env.TWITCH_CLIENT_ID ?? "";
    this.directory = options.directory ?? join(process.cwd(), ".dibs");
    this.fetcher = options.fetch ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get tokenPath(): string {
    return join(this.directory, "tokens.json");
  }

  async authorize(
    onCode: (code: string, url: string) => void = console.log,
  ): Promise<TwitchTokens> {
    this.requireClientId();
    const device = await this.startDeviceFlow();
    onCode(device.user_code, device.verification_uri);
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
      await this.sleep(device.interval * 1000);
      const response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: device.device_code,
          grant_type: DEVICE_GRANT,
          scopes: TWITCH_SCOPES.join(" "),
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.ok) {
        this.tokens = this.tokenFromResponse(body);
        await this.save();
        return this.tokens;
      }
      if (body.message === "authorization_pending") continue;
      if (body.message === "slow_down") {
        device.interval += 5;
        continue;
      }
      throw new Error(
        `Twitch device authorization failed: ${String(body.message ?? response.status)}`,
      );
    }
    throw new Error(
      "Twitch device authorization expired. Run npm run auth to try again.",
    );
  }

  async getAccessToken(): Promise<string> {
    this.requireClientId();
    this.tokens ??= await this.readSavedTokens();
    if (this.tokens.expires_at <= Date.now() + 60_000) {
      await this.refresh();
    }
    return this.tokens.access_token;
  }

  async getTokens(): Promise<TwitchTokens> {
    await this.getAccessToken();
    return this.tokens!;
  }

  async validateAccessToken(): Promise<TwitchTokens> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetcher(
      "https://id.twitch.tv/oauth2/validate",
      {
        headers: { Authorization: `OAuth ${accessToken}` },
      },
    );
    const body = (await response.json()) as {
      user_id?: string;
      login?: string;
      expires_in?: number;
      scopes?: string[];
      message?: string;
    };
    if (!response.ok)
      throw new Error(
        `Twitch token validation failed: ${body.message ?? response.status}`,
      );
    this.tokens = {
      ...this.tokens!,
      ...(body.user_id ? { user_id: body.user_id } : {}),
      ...(body.login ? { login: body.login } : {}),
      ...(body.scopes ? { scope: body.scopes } : {}),
      ...(body.expires_in
        ? { expires_at: Date.now() + body.expires_in * 1000 }
        : {}),
    };
    await this.save();
    return this.tokens;
  }

  async refresh(): Promise<TwitchTokens> {
    this.requireClientId();
    this.tokens ??= await this.readSavedTokens();
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: "refresh_token",
        refresh_token: this.tokens.refresh_token,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(
        `Twitch token refresh failed: ${String(body.message ?? response.status)}`,
      );
    this.tokens = { ...this.tokens, ...this.tokenFromResponse(body) };
    await this.save();
    return this.tokens;
  }

  private async startDeviceFlow(): Promise<DeviceResponse> {
    const response = await this.fetcher(DEVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        scopes: TWITCH_SCOPES.join(" "),
      }),
    });
    const body = (await response.json()) as DeviceResponse & {
      message?: string;
    };
    if (!response.ok)
      throw new Error(
        `Could not start Twitch authorization: ${body.message ?? response.status}`,
      );
    return body;
  }

  private tokenFromResponse(body: Record<string, unknown>): TwitchTokens {
    if (
      typeof body.access_token !== "string" ||
      typeof body.refresh_token !== "string"
    ) {
      throw new Error("Twitch returned an incomplete token response.");
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + Number(body.expires_in ?? 14_400) * 1000,
      ...(Array.isArray(body.scope) ? { scope: body.scope.map(String) } : {}),
    };
  }

  private async readSavedTokens(): Promise<TwitchTokens> {
    try {
      return JSON.parse(await readFile(this.tokenPath, "utf8")) as TwitchTokens;
    } catch {
      throw new Error("No Twitch tokens found. Run npm run auth first.");
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.tokenPath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(this.tokens, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, this.tokenPath);
  }

  private requireClientId(): void {
    if (!this.clientId)
      throw new Error("Set TWITCH_CLIENT_ID before connecting Twitch.");
  }
}

export async function runAuthCommand(): Promise<void> {
  const auth = new TwitchAuth();
  const tokens = await auth.authorize((code, url) => {
    console.log(`Open ${url} and enter code ${code}`);
  });
  console.log(
    `Authorized as Twitch user ${tokens.user_id ?? "(token saved)"}. Tokens saved to ${auth.tokenPath}`,
  );
}
