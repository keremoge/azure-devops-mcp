// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getOrgFromUrl } from "./utils.js";

/**
 * Describes which Azure DevOps deployment the MCP server talks to.
 *
 *  - "cloud":  Azure DevOps Services (https://dev.azure.com/{org} or https://{org}.visualstudio.com)
 *  - "onprem": Azure DevOps Server (2020 Update 1, 2022.x, 26H2 RC, ...), addressed by its collection URL,
 *              e.g. https://tfs.contoso.com/tfs/DefaultCollection
 */
export type DeploymentKind = "cloud" | "onprem";

export interface ServerTarget {
  kind: DeploymentKind;
  /** Organization name (cloud) or collection name (on-prem, last segment of the collection URL). */
  orgName: string;
  /** Base URL used for all REST calls: https://dev.azure.com/{org} or the on-prem collection URL (no trailing slash). */
  orgUrl: string;
  /** Origin (protocol + host + port) of orgUrl. */
  origin: string;
  /** True when the on-prem collection URL uses plain http. */
  insecureHttp: boolean;
}

export interface ServerContext extends ServerTarget {
  /** Additional host names (on-prem only) that are trusted to receive credentials, e.g. the server's public URL. */
  trustedHosts: string[];
}

const CLOUD_HOST = "dev.azure.com";
const CLOUD_TRUSTED_HOSTS = new Set([CLOUD_HOST, "vssps.dev.azure.com", "almsearch.dev.azure.com"]);
const CLOUD_TRUSTED_HOST_SUFFIXES = [".dev.azure.com", ".visualstudio.com"];
const ORG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isCloudHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === CLOUD_HOST || host.endsWith(".dev.azure.com") || host === "visualstudio.com" || host.endsWith(".visualstudio.com");
}

function createCloudTarget(orgName: string): ServerTarget {
  return {
    kind: "cloud",
    orgName,
    orgUrl: `https://${CLOUD_HOST}/${orgName}`,
    origin: `https://${CLOUD_HOST}`,
    insecureHttp: false,
  };
}

/**
 * Parses the `<organization>` CLI argument.
 *
 * Accepted forms:
 *  - `contoso`                                       -> cloud organization
 *  - `https://dev.azure.com/contoso[/...]`           -> cloud organization
 *  - `https://contoso.visualstudio.com[/...]`        -> cloud organization
 *  - `https://tfs.contoso.com/tfs/DefaultCollection` -> Azure DevOps Server collection
 *  - `http://tfs01:8080/tfs/DefaultCollection`       -> Azure DevOps Server collection over plain http
 */
export function parseServerTarget(input: string): ServerTarget {
  const value = (input ?? "").trim();
  if (!value) {
    throw new Error("An Azure DevOps organization name or Azure DevOps Server collection URL is required.");
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!ORG_NAME_PATTERN.test(value)) {
      throw new Error(`Invalid organization '${value}'. Provide an Azure DevOps organization name (e.g. 'contoso') or a full collection URL (e.g. 'https://tfs.contoso.com/tfs/DefaultCollection').`);
    }
    return createCloudTarget(value);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid organization URL '${value}'.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol '${url.protocol}' in organization URL '${value}'. Use https:// (or http:// for servers without TLS).`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials must not be embedded in the organization URL. Use the --authentication option instead.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();

  if (isCloudHost(host)) {
    if (url.protocol !== "https:") {
      throw new Error("Azure DevOps Services URLs must use https://.");
    }
    if (host === "visualstudio.com" || host.endsWith(".visualstudio.com")) {
      const subdomain = host.split(".")[0];
      if (!subdomain || subdomain === "visualstudio") {
        throw new Error(`Could not determine the organization from '${value}'.`);
      }
      return createCloudTarget(subdomain);
    }
    const org = segments[0];
    if (!org) {
      throw new Error(`Could not determine the organization from '${value}'. Expected https://dev.azure.com/{organization}.`);
    }
    return createCloudTarget(decodeURIComponent(org));
  }

  if (segments.length === 0) {
    throw new Error(`The Azure DevOps Server URL '${value}' must include the collection, e.g. '${url.origin}/tfs/DefaultCollection' or '${url.origin}/DefaultCollection'.`);
  }

  const collectionPath = "/" + segments.join("/");
  return {
    kind: "onprem",
    orgName: decodeURIComponent(segments[segments.length - 1]),
    orgUrl: `${url.origin}${collectionPath}`,
    origin: url.origin,
    insecureHttp: url.protocol === "http:",
  };
}

/** Normalizes a list of host names supplied via --trusted-host. Accepts bare host names or URLs. */
export function normalizeTrustedHosts(hosts: string[] | string | undefined): string[] {
  if (!hosts) return [];
  const list = Array.isArray(hosts) ? hosts : [hosts];
  const result = new Set<string>();
  for (const raw of list.flatMap((h) => String(h).split(","))) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let host = trimmed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      try {
        host = new URL(trimmed).host;
      } catch {
        continue;
      }
    }
    result.add(host.toLowerCase());
  }
  return Array.from(result);
}

let currentContext: ServerContext = { ...createCloudTarget("unknown"), trustedHosts: [] };

export function setServerContext(target: ServerTarget, trustedHosts: string[] = []): ServerContext {
  currentContext = { ...target, trustedHosts: target.kind === "onprem" ? normalizeTrustedHosts(trustedHosts) : [] };
  return currentContext;
}

export function getServerContext(): ServerContext {
  return currentContext;
}

export function isOnPremises(): boolean {
  return currentContext.kind === "onprem";
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Resolves the organization name for cloud URLs, preferring the connection URL when available. */
function resolveCloudOrg(serverUrl?: string): string {
  return (serverUrl && getOrgFromUrl(serverUrl)) || currentContext.orgName;
}

/**
 * Base URL for the Search REST APIs (code, wiki, work item and commit search).
 * Cloud: https://almsearch.dev.azure.com/{org}. On-prem: the collection URL (Search extension).
 */
export function getSearchBaseUrl(serverUrl?: string): string {
  if (currentContext.kind === "onprem") {
    return trimTrailingSlash(serverUrl || currentContext.orgUrl);
  }
  return `https://almsearch.dev.azure.com/${resolveCloudOrg(serverUrl)}`;
}

/**
 * Base URL for the Identities (IMS) REST APIs.
 * Cloud: https://vssps.dev.azure.com/{org}. On-prem: the collection URL.
 */
export function getIdentitiesBaseUrl(serverUrl?: string): string {
  if (currentContext.kind === "onprem") {
    return trimTrailingSlash(serverUrl || currentContext.orgUrl);
  }
  return `https://vssps.dev.azure.com/${resolveCloudOrg(serverUrl)}`;
}

/**
 * Returns true if the given URL may receive Azure DevOps credentials.
 *
 * Cloud: https + an Azure DevOps Services host.
 * On-prem: the configured collection origin (http allowed only if the collection URL itself is http), or a
 * host explicitly trusted with --trusted-host (https only, or http when the collection URL is http).
 */
export function isTrustedServerUrl(input: URL | string): boolean {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const ctx = currentContext;

  // Azure DevOps Services hosts are trusted (over https) only when connected to Azure DevOps Services.
  if (url.protocol === "https:" && (CLOUD_TRUSTED_HOSTS.has(hostname) || CLOUD_TRUSTED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))) {
    return ctx.kind === "cloud";
  }

  if (ctx.kind !== "onprem") {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  if (url.protocol === "http:" && !ctx.insecureHttp) {
    return false;
  }

  if (url.origin.toLowerCase() === ctx.origin.toLowerCase()) {
    return true;
  }

  const host = url.host.toLowerCase();
  return ctx.trustedHosts.includes(host) || ctx.trustedHosts.includes(hostname);
}

/**
 * Extracts the Azure DevOps Services organization from a cloud URL, or null for any other host.
 * Supports https://dev.azure.com/{org}/... and https://{org}.visualstudio.com/...
 */
export const getCloudOrgFromUrl = getOrgFromUrl;

/**
 * Returns true when the URL points into the configured organization (cloud) or collection (on-prem).
 * Used to block cross-organization/collection requests built from user supplied URLs.
 */
export function isSameCollection(url: string, configuredUrl: string = currentContext.orgUrl): boolean {
  let candidate: URL;
  let configured: URL;
  try {
    candidate = new URL(url);
    configured = new URL(configuredUrl);
  } catch {
    return false;
  }

  if (isCloudHost(configured.hostname)) {
    const configuredOrg = getCloudOrgFromUrl(configuredUrl);
    return !!configuredOrg && getCloudOrgFromUrl(url) === configuredOrg;
  }

  const sameOrigin = candidate.origin.toLowerCase() === configured.origin.toLowerCase() || (currentContext.kind === "onprem" && currentContext.trustedHosts.includes(candidate.host.toLowerCase()));
  if (!sameOrigin) return false;

  const configuredPath = configured.pathname.replace(/\/+$/, "").toLowerCase();
  const candidatePath = decodeURIComponent(candidate.pathname).toLowerCase();
  const configuredDecoded = decodeURIComponent(configuredPath);
  return candidatePath === configuredDecoded || candidatePath.startsWith(configuredDecoded + "/");
}

/** Returns a short human readable description of the configured target (used in errors). */
export function describeTarget(url: string): string {
  const org = getCloudOrgFromUrl(url);
  if (org) return org;
  if (currentContext.kind === "cloud") return "unknown";
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const wikiIndex = segments.indexOf("_wiki");
    const collectionSegments = wikiIndex > 1 ? segments.slice(0, wikiIndex - 1) : segments;
    return `${u.origin}/${collectionSegments.join("/")}`;
  } catch {
    return "unknown";
  }
}
