// Test-only: fake Bigul JWTs (unsigned; nothing here checks signatures).

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Shaped like the Bigul app's session JWT, the SSO bypass `token`. */
export const appToken = (claims: Record<string, unknown>) =>
  [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ DeviceType: "Android", exp: 4_102_444_800, ...claims }),
    "c2lnbmF0dXJl",
  ].join(".");

/** Shaped like Connect's access_token for our app (app_key "k"). */
export const accessToken = (clientCode: string, appKey = "k") =>
  [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({
      tokenData: { app_key: appKey, client_code: clientCode, type: "CLIENT" },
      exp: 4_102_444_800,
    }),
    // Real tokens carry "+" and "/" as sent by Bigul; keep them in tests.
    "c2ln+bmF0/dXJl",
  ].join(".");
