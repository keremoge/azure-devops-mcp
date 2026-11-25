// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { WebApi } from "azure-devops-node-api";
import { logger } from "./logger.js";
import { getServerContext } from "./server-context.js";
import { apiVersion, markdownCommentsApiVersion } from "./utils.js";

/**
 * Azure DevOps Server releases and the highest REST API version each one supports.
 *
 * | Release                          | REST API |
 * | -------------------------------- | -------- |
 * | Azure DevOps Server 2020 (Update 1) | 6.0   |
 * | Azure DevOps Server 2022         | 7.0      |
 * | Azure DevOps Server 2022.1/2022.2 | 7.1     |
 * | Azure DevOps Server 26H2 (RC)    | 7.2      |
 */
export const SERVER_VERSION_PROFILES = {
  "2020": { apiVersion: "6.0", displayName: "Azure DevOps Server 2020 (Update 1)" },
  "2022": { apiVersion: "7.0", displayName: "Azure DevOps Server 2022" },
  "2022.1": { apiVersion: "7.1", displayName: "Azure DevOps Server 2022.1" },
  "2022.2": { apiVersion: "7.1", displayName: "Azure DevOps Server 2022.2" },
  "26h2": { apiVersion: "7.2", displayName: "Azure DevOps Server 26H2 (RC)" },
} as const;

export type ServerVersionProfile = keyof typeof SERVER_VERSION_PROFILES;
export type ServerVersionChoice = ServerVersionProfile | "auto";

export const SERVER_VERSION_CHOICES: ServerVersionChoice[] = ["auto", ...(Object.keys(SERVER_VERSION_PROFILES) as ServerVersionProfile[])];

/** Lowest supported on-prem profile; used when auto-detection fails. */
export const LOWEST_SERVER_PROFILE: ServerVersionProfile = "2020";

export interface ServerVersionInfo {
  profile: ServerVersionProfile | "cloud";
  /** Highest REST API version (major.minor) the server supports. */
  apiVersion: string;
  /** How the information was obtained. */
  source: "cloud" | "configured" | "detected" | "fallback";
}

/** Minimal shape of an API resource location returned by the location service (OPTIONS /_apis/{area}). */
export interface ApiLocationVersions {
  maxVersion: string;
  releasedVersion: string;
  resourceVersion: number;
}

/** Describes a REST resource called directly (outside the azure-devops-node-api clients). */
export interface ApiEndpoint {
  /** Resource area, e.g. "wit", "wiki", "search". */
  area: string;
  /** Location id of the resource; when omitted only the server ceiling is used to downgrade the version. */
  locationId?: string;
  /** Version requested on Azure DevOps Services. */
  requested: string;
}

/**
 * REST resources called with raw fetch. Location ids come from the azure-devops-node-api / extension-api clients.
 */
export const API_ENDPOINTS = {
  coreProjects: { area: "core", locationId: "603fe2ac-9723-48b9-88ad-09305aa6c6e1", requested: apiVersion },
  identities: { area: "IMS", locationId: "28010c54-d0c0-4c89-a5b0-1c9e188b9fb7", requested: apiVersion },
  codeSearch: { area: "search", locationId: "e7f29993-5b82-4fca-9386-f5cfe683d524", requested: apiVersion },
  wikiSearch: { area: "search", locationId: "e90e7664-7049-4100-9a86-66b161d81080", requested: apiVersion },
  workItemSearch: { area: "search", locationId: "73b2c9e2-ff9e-4447-8cda-5f5b21ff7cae", requested: apiVersion },
  commitSearch: { area: "search", requested: apiVersion },
  orgPullRequests: { area: "git", locationId: "a5d28130-9cd2-40fa-9f08-902e7daa9efb", requested: "7.1" },
  buildStages: { area: "build", locationId: "b8aac6c9-744b-46e1-88fc-3550969f9313", requested: apiVersion },
  testPlans: { area: "testplan", locationId: "0e292477-a0c2-47f3-a9b6-34f153d627f4", requested: apiVersion },
  testSuites: { area: "testplan", locationId: "1046d5d3-ab61-4ca7-a65a-36118a978256", requested: apiVersion },
  testSuiteTestCases: { area: "testplan", locationId: "a9bd61ac-45cf-4d13-9441-43dcd01edf8d", requested: "7.2-preview.3" },
  wikiPages: { area: "wiki", locationId: "25d3fbc7-fe3d-46cb-b5a5-0b6f79caf27b", requested: "7.1" },
  wikiPagesList: { area: "wiki", locationId: "25d3fbc7-fe3d-46cb-b5a5-0b6f79caf27b", requested: apiVersion },
  wikiPageById: { area: "wiki", locationId: "ceddcf75-1068-452d-8b13-2d4d76e1f970", requested: "7.1" },
  workItemComments: { area: "wit", locationId: "608aac0a-32e1-4493-a863-b9cf4566d257", requested: markdownCommentsApiVersion },
} satisfies Record<string, ApiEndpoint>;

/** Comments resource version that introduced the `format` (markdown/html) parameter. */
export const MARKDOWN_COMMENTS_MIN_RESOURCE_VERSION = 4;

interface ParsedApiVersion {
  version: number;
  versionString: string;
  isPreview: boolean;
  resourceVersion?: number;
}

export function parseApiVersion(value: string): ParsedApiVersion | undefined {
  const match = /^(\d+(?:\.\d+)?)(-preview(?:\.(\d+))?)?$/.exec((value ?? "").trim());
  if (!match) return undefined;
  return {
    version: +match[1],
    versionString: match[1],
    isPreview: !!match[2],
    resourceVersion: match[3] !== undefined ? +match[3] : undefined,
  };
}

/**
 * Picks the api-version to send for a resource, given the versions the server advertises for it.
 * Mirrors the negotiation azure-devops-node-api performs for its own clients (VsoClient.autoNegotiateApiVersion).
 */
export function negotiateWithLocation(location: ApiLocationVersions, requested: string): string {
  const parsed = parseApiVersion(requested);
  if (parsed) {
    const maxVersion = +location.maxVersion;
    const releasedVersion = +location.releasedVersion;
    if (
      parsed.version <= releasedVersion ||
      (parsed.resourceVersion === undefined && parsed.isPreview && parsed.version <= maxVersion) ||
      (parsed.resourceVersion !== undefined && parsed.version <= maxVersion && parsed.resourceVersion <= +location.resourceVersion)
    ) {
      return requested;
    }
    if (parsed.version < maxVersion) {
      return `${parsed.versionString}-preview`;
    }
  }
  if (location.maxVersion === location.releasedVersion) {
    return location.maxVersion;
  }
  return `${location.maxVersion}-preview.${location.resourceVersion}`;
}

/**
 * Downgrades a requested api-version to the server ceiling when the resource location is unknown.
 *  - "7.2-preview.1" on 6.0 -> "6.0-preview"
 *  - "7.1"           on 6.0 -> "6.0"
 *  - "5.0"           on 6.0 -> "5.0"
 */
export function clampApiVersion(requested: string, ceiling: string): string {
  const parsed = parseApiVersion(requested);
  const parsedCeiling = parseApiVersion(ceiling);
  if (!parsed || !parsedCeiling) return requested;
  if (parsed.version <= parsedCeiling.version) return requested;
  return parsed.isPreview ? `${parsedCeiling.versionString}-preview` : parsedCeiling.versionString;
}

/** Maps the highest REST API version reported by a server to the closest known release profile. */
export function apiVersionToProfile(maxVersion: string | number): ServerVersionProfile {
  const version = +maxVersion;
  if (!Number.isFinite(version) || version < 7.0) return "2020";
  if (version < 7.1) return "2022";
  if (version < 7.2) return "2022.1";
  return "26h2";
}

export function parseServerVersionChoice(value: string | undefined): ServerVersionChoice {
  const normalized = (value ?? "auto").toString().trim().toLowerCase();
  const aliases: Record<string, ServerVersionChoice> = {
    "auto": "auto",
    "2020": "2020",
    "2020.1": "2020",
    "2020u1": "2020",
    "2022": "2022",
    "2022.0": "2022",
    "2022.1": "2022.1",
    "2022.2": "2022.2",
    "26h2": "26h2",
    "rc": "26h2",
  };
  const choice = aliases[normalized];
  if (!choice) {
    throw new Error(`Unsupported server version '${value}'. Supported values: ${SERVER_VERSION_CHOICES.join(", ")}.`);
  }
  return choice;
}

let configuredChoice: ServerVersionChoice = "auto";
let detectionPromise: Promise<ServerVersionInfo> | undefined;
const locationCache = new Map<string, Promise<ApiLocationVersions | undefined>>();

export function configureServerVersion(choice: ServerVersionChoice): void {
  configuredChoice = choice;
  detectionPromise = undefined;
  locationCache.clear();
}

/** Clears cached detection results (used by tests). */
export function resetServerVersionState(): void {
  configureServerVersion("auto");
}

/** Returns the value configured with --server-version (without contacting the server). */
export function getConfiguredServerVersion(): ServerVersionChoice {
  return configuredChoice;
}

function getLocation(connection: WebApi, area: string, locationId: string): Promise<ApiLocationVersions | undefined> {
  const key = `${getServerContext().orgUrl}|${area.toLowerCase()}|${locationId.toLowerCase()}`;
  let promise = locationCache.get(key);
  if (!promise) {
    promise = Promise.resolve()
      .then(() => connection.vsoClient.beginGetLocation(area, locationId))
      .then((location) => (location ? { maxVersion: String(location.maxVersion), releasedVersion: String(location.releasedVersion), resourceVersion: Number(location.resourceVersion) } : undefined));
    promise.catch(() => locationCache.delete(key));
    locationCache.set(key, promise);
  }
  return promise;
}

/**
 * Returns the server version profile. Cloud never contacts the server. On-prem uses the --server-version value,
 * or (auto) the max version of the core projects resource, falling back to the lowest supported release.
 */
export function getServerVersionInfo(connection: WebApi): Promise<ServerVersionInfo> {
  if (getServerContext().kind === "cloud") {
    return Promise.resolve({ profile: "cloud", apiVersion: "7.2", source: "cloud" });
  }
  if (configuredChoice !== "auto") {
    return Promise.resolve({ profile: configuredChoice, apiVersion: SERVER_VERSION_PROFILES[configuredChoice].apiVersion, source: "configured" });
  }
  if (!detectionPromise) {
    detectionPromise = getLocation(connection, API_ENDPOINTS.coreProjects.area, API_ENDPOINTS.coreProjects.locationId)
      .then((location): ServerVersionInfo => {
        const maxVersion = location ? parseApiVersion(location.maxVersion) : undefined;
        if (!maxVersion) {
          throw new Error("core/projects resource location not returned by the server");
        }
        const profile = apiVersionToProfile(maxVersion.version);
        logger.info(`Detected ${SERVER_VERSION_PROFILES[profile].displayName} (REST API ${maxVersion.versionString})`);
        return { profile, apiVersion: maxVersion.versionString, source: "detected" };
      })
      .catch((error): ServerVersionInfo => {
        logger.warn(`Could not detect the Azure DevOps Server version, assuming ${SERVER_VERSION_PROFILES[LOWEST_SERVER_PROFILE].displayName}. Use --server-version to set it explicitly.`, error);
        // Do not cache failures (e.g. transient network errors) so the next call can retry.
        detectionPromise = undefined;
        return { profile: LOWEST_SERVER_PROFILE, apiVersion: SERVER_VERSION_PROFILES[LOWEST_SERVER_PROFILE].apiVersion, source: "fallback" };
      });
  }
  return detectionPromise;
}

/**
 * Returns the api-version to use for a direct REST call.
 *
 * Azure DevOps Services: the requested version, unchanged (no extra requests).
 * Azure DevOps Server: negotiated against the resource location advertised by the server; if the location cannot be
 * read, the requested version is clamped to the server's REST API ceiling.
 */
export async function negotiateApiVersion(connection: WebApi, endpoint: ApiEndpoint): Promise<string> {
  if (getServerContext().kind === "cloud") {
    return endpoint.requested;
  }

  if (endpoint.locationId) {
    try {
      const location = await getLocation(connection, endpoint.area, endpoint.locationId);
      if (location) {
        return negotiateWithLocation(location, endpoint.requested);
      }
    } catch (error) {
      logger.debug(`Location lookup failed for ${endpoint.area}/${endpoint.locationId}; falling back to the server API ceiling`, error);
    }
  }

  const info = await getServerVersionInfo(connection);
  return clampApiVersion(endpoint.requested, info.apiVersion);
}

/** True when the negotiated comments api-version supports the `format` (markdown) query parameter. */
export function supportsMarkdownComments(negotiatedVersion: string): boolean {
  const parsed = parseApiVersion(negotiatedVersion);
  if (!parsed || parsed.version < 7.1) return false;
  if (parsed.resourceVersion !== undefined) return parsed.resourceVersion >= MARKDOWN_COMMENTS_MIN_RESOURCE_VERSION;
  return parsed.version >= 7.2;
}
