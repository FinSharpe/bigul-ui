import { generateKeyPairSync } from "node:crypto";

// Test-only: a throwaway RSA key in the PKCS#8 PEM form BIGUL_SESSION_PRIVATE_KEY takes.
export function testPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Blank values for every auth env var, so tests never see the shell's. */
export const BLANK_AUTH_ENV: Record<string, string> = {
  BIGUL_SESSION_PRIVATE_KEY: "",
  BIGUL_SESSION_PRIVATE_KEY_B64: "",
  BIGUL_SESSION_ISSUER: "",
  BIGUL_SESSION_AUDIENCE: "",
  BIGUL_SSO_LOGIN_URL: "",
  BIGUL_SSO_APP_KEY: "",
  BIGUL_SSO_PLATFORMS: "",
  BIGUL_SSO_REDIRECT_URL: "",
  BIGUL_API_BASE_URL: "",
  BIGUL_API_SOURCE: "",
  BIGUL_API_KEY: "",
  BIGUL_API_SECRET: "",
  BIGUL_PARTNER_CODE: "",
  BIGUL_PARTNER_PASSWORD: "",
  BIGUL_OUTBOUND_PROXY_URLS: "",
  AUTH_DEV_LOGIN: "",
  LANGGRAPH_API_URL: "",
  LANGSMITH_API_KEY: "",
};
