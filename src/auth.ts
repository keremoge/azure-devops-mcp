// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential, TokenCredential } from "@azure/identity";
import { logger } from "./logger.js";
import { azureDevOpsScopes, OAuthAuthenticator } from "./oauth.js";
import { DeploymentKind, getServerContext, isTrustedServerUrl } from "./server-context.js";

const patAllowedHosts = new Set(["dev.azure.com", "vssps.dev.azure.com", "almsearch.dev.azure.com"]);

/** Authentication types accepted by the CLI. */
export const AUTHENTICATION_TYPES = ["interactive", "azcli", "env", "envvar", "pat", "basic"] as const;

/** Authentication types that work against Azure DevOps Server (on-premises). */
export const ON_PREMISES_AUTHENTICATION_TYPES = ["pat", "basic"] as const;

/** Authentication types whose credential is sent as an HTTP Basic header. */
export function isBasicCredentialAuthType(type: string): boolean {
  return type === "pat" || type === "basic";
}

/**
 * Validates that the selected authentication type can be used with the target deployment.
 * Azure DevOps Server does not accept Microsoft Entra ID tokens, so only PAT and Basic credentials work there.
 */
export function validateAuthenticationForDeployment(type: string, kind: DeploymentKind): void {
  if (kind === "onprem" && !(ON_PREMISES_AUTHENTICATION_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Authentication type '${type}' is not supported with Azure DevOps Server (on-premises). ` +
        `Azure DevOps Server does not accept Microsoft Entra ID tokens; use '--authentication pat' (PERSONAL_ACCESS_TOKEN) ` +
        `or '--authentication basic' (ADO_MCP_USERNAME / ADO_MCP_PASSWORD).`
    );
  }
  if (kind === "cloud" && type === "basic") {
    throw new Error("Authentication type 'basic' is only supported with Azure DevOps Server (on-premises). Use 'pat' or another authentication type for Azure DevOps Services.");
  }
}

function isPatAllowedHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return patAllowedHosts.has(normalizedHostname) || normalizedHostname.endsWith(".visualstudio.com");
}

/**
 * Default trust policy for Basic credentials: Azure DevOps Services hosts over https, or — when connected to
 * Azure DevOps Server — the configured collection origin (and --trusted-host entries).
 */
function isTrustedCredentialDestination(url: URL): boolean {
  if (getServerContext().kind === "onprem") {
    return isTrustedServerUrl(url);
  }
  return url.protocol === "https:" && isPatAllowedHost(url.hostname);
}

/**
 * Tools send `Authorization: Bearer <credential>` with raw fetch. For PAT/Basic authentication the credential is
 * a base64 `user:secret` pair, so this interceptor rewrites the header to `Basic <credential>` — but only for
 * trusted destinations; any other destination is refused so credentials never leak.
 */
function installBasicAuthFetchInterceptor(basicValue: string, isTrusted: (url: URL) => boolean = isTrustedCredentialDestination): void {
  const originalFetch = globalThis.fetch;
  const patBearerValue = `Bearer ${basicValue}`;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get("Authorization") !== patBearerValue) {
      return originalFetch(input, init);
    }

    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    if (!isTrusted(requestUrl)) {
      throw new Error(`Refusing to send a Personal Access Token to untrusted destination '${requestUrl.origin}'`);
    }

    headers.set("Authorization", `Basic ${basicValue}`);
    if (input instanceof Request) {
      return originalFetch(new Request(input, { ...init, headers }));
    }
    return originalFetch(input, { ...init, headers });
  };
}

function installPatFetchInterceptor(basicValue: string): void {
  installBasicAuthFetchInterceptor(basicValue);
}

/** Splits a base64 `user:secret` credential into its parts. */
export function decodeBasicCredential(basicValue: string): { username: string; secret: string } {
  const decoded = Buffer.from(basicValue, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return { username: "", secret: decoded };
  }
  return { username: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function createAuthenticator(type: string, tenantId?: string): () => Promise<string> {
  logger.debug(`Creating authenticator of type '${type}' with tenantId='${tenantId ?? "undefined"}'`);
  switch (type) {
    case "pat":
      logger.debug(`Authenticator: Using PAT authentication (PERSONAL_ACCESS_TOKEN)`);
      return async () => {
        logger.debug(`${type}: Reading token from PERSONAL_ACCESS_TOKEN environment variable`);
        const b64Pat = process.env["PERSONAL_ACCESS_TOKEN"];
        if (!b64Pat) {
          logger.error(`${type}: PERSONAL_ACCESS_TOKEN environment variable is not set or empty`);
          throw new Error("Environment variable 'PERSONAL_ACCESS_TOKEN' is not set or empty. Please set it with a valid base64-encoded Azure DevOps Personal Access Token.");
        }
        // Return base64 value as-is — caller uses it directly as the Basic auth credential
        logger.debug(`${type}: Successfully retrieved PAT from environment variable`);
        return b64Pat;
      };

    case "basic":
      logger.debug(`Authenticator: Using Basic authentication (ADO_MCP_USERNAME / ADO_MCP_PASSWORD)`);
      return async () => {
        const username = process.env["ADO_MCP_USERNAME"];
        const password = process.env["ADO_MCP_PASSWORD"];
        if (!username || !password) {
          logger.error(`${type}: ADO_MCP_USERNAME and/or ADO_MCP_PASSWORD environment variables are not set or empty`);
          throw new Error("Environment variables 'ADO_MCP_USERNAME' and 'ADO_MCP_PASSWORD' must be set for Basic authentication (e.g. DOMAIN\\user and the account password).");
        }
        if (username.includes(":")) {
          throw new Error("Environment variable 'ADO_MCP_USERNAME' must not contain ':'.");
        }
        logger.debug(`${type}: Successfully read Basic credentials from environment variables`);
        return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      };

    case "envvar":
      logger.debug(`Authenticator: Using environment variable authentication (ADO_MCP_AUTH_TOKEN)`);
      // Read token from fixed environment variable
      return async () => {
        logger.debug(`${type}: Reading token from ADO_MCP_AUTH_TOKEN environment variable`);
        const token = process.env["ADO_MCP_AUTH_TOKEN"];
        if (!token) {
          logger.error(`${type}: ADO_MCP_AUTH_TOKEN environment variable is not set or empty`);
          throw new Error("Environment variable 'ADO_MCP_AUTH_TOKEN' is not set or empty. Please set it with a valid Azure DevOps Personal Access Token.");
        }
        logger.debug(`${type}: Successfully retrieved token from environment variable`);
        return token;
      };

    case "azcli":
    case "env":
      if (type !== "env") {
        logger.debug(`${type}: Setting AZURE_TOKEN_CREDENTIALS to 'dev' for development credential chain`);
        process.env.AZURE_TOKEN_CREDENTIALS = "dev";
      }
      let credential: TokenCredential = new DefaultAzureCredential(); // CodeQL [SM05138] resolved by explicitly setting AZURE_TOKEN_CREDENTIALS
      if (tenantId) {
        // Use Azure CLI credential if tenantId is provided for multi-tenant scenarios
        const azureCliCredential = new AzureCliCredential({ tenantId });
        credential = new ChainedTokenCredential(azureCliCredential, credential);
      }
      return async () => {
        const result = await credential.getToken(azureDevOpsScopes);
        if (!result) {
          logger.error(`${type}: Failed to obtain token - credential.getToken returned null/undefined`);
          throw new Error("Failed to obtain Azure DevOps token. Ensure you have Azure CLI logged or use interactive type of authentication.");
        }
        logger.debug(`${type}: Successfully obtained Azure DevOps token`);
        return result.token;
      };

    default:
      logger.debug(`Authenticator: Using OAuth interactive authentication (default)`);
      const authenticator = new OAuthAuthenticator(tenantId);
      return () => {
        return authenticator.getToken();
      };
  }
}
export { createAuthenticator, installBasicAuthFetchInterceptor, installPatFetchInterceptor };
