// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import type { WebApi } from "azure-devops-node-api";

jest.mock("../../src/logger.js", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { parseServerTarget, setServerContext } from "../../src/server-context";
import {
  API_ENDPOINTS,
  apiVersionToProfile,
  clampApiVersion,
  configureServerVersion,
  getConfiguredServerVersion,
  getServerVersionInfo,
  negotiateApiVersion,
  negotiateWithLocation,
  parseApiVersion,
  parseServerVersionChoice,
  resetServerVersionState,
  SERVER_VERSION_CHOICES,
  SERVER_VERSION_PROFILES,
  supportsMarkdownComments,
} from "../../src/server-version";

interface Location {
  maxVersion: string;
  releasedVersion: string;
  resourceVersion: number;
}

function createConnection(locations: Record<string, Location | undefined> | ((area: string, id: string) => Promise<Location | undefined>)) {
  const beginGetLocation = jest.fn(async (area: string, id: string) => {
    if (typeof locations === "function") return locations(area, id);
    return locations[`${area}/${id}`];
  });
  const connection = { serverUrl: "https://tfs.contoso.com/tfs/DefaultCollection", vsoClient: { beginGetLocation } } as unknown as WebApi;
  return { connection, beginGetLocation };
}

const coreKey = `${API_ENDPOINTS.coreProjects.area}/${API_ENDPOINTS.coreProjects.locationId}`;
const location = (maxVersion: string, releasedVersion: string, resourceVersion: number): Location => ({ maxVersion, releasedVersion, resourceVersion });

describe("server version profiles", () => {
  it("covers Azure DevOps Server 2020 Update 1, 2022.x and 26H2", () => {
    expect(SERVER_VERSION_PROFILES["2020"].apiVersion).toBe("6.0");
    expect(SERVER_VERSION_PROFILES["2022"].apiVersion).toBe("7.0");
    expect(SERVER_VERSION_PROFILES["2022.1"].apiVersion).toBe("7.1");
    expect(SERVER_VERSION_PROFILES["2022.2"].apiVersion).toBe("7.1");
    expect(SERVER_VERSION_PROFILES["26h2"].apiVersion).toBe("7.2");
    expect(SERVER_VERSION_CHOICES).toEqual(["auto", "2020", "2022", "2022.1", "2022.2", "26h2"]);
  });

  it.each([
    ["6.0", "2020"],
    ["5.1", "2020"],
    ["7.0", "2022"],
    ["7.1", "2022.1"],
    ["7.2", "26h2"],
    ["7.3", "26h2"],
    ["garbage", "2020"],
  ])("maps REST API %s to profile %s", (version, profile) => {
    expect(apiVersionToProfile(version)).toBe(profile);
  });

  it.each([
    [undefined, "auto"],
    ["AUTO", "auto"],
    ["2020", "2020"],
    ["2020.1", "2020"],
    ["2020u1", "2020"],
    ["2022", "2022"],
    ["2022.0", "2022"],
    ["2022.1", "2022.1"],
    ["2022.2", "2022.2"],
    ["26H2", "26h2"],
    ["rc", "26h2"],
  ])("parses --server-version %s", (input, expected) => {
    expect(parseServerVersionChoice(input)).toBe(expected);
  });

  it("rejects unknown server versions", () => {
    expect(() => parseServerVersionChoice("2019")).toThrow(/Unsupported server version '2019'/);
  });
});

describe("api version helpers", () => {
  it("parses api versions", () => {
    expect(parseApiVersion("7.2-preview.4")).toEqual({ version: 7.2, versionString: "7.2", isPreview: true, resourceVersion: 4 });
    expect(parseApiVersion("6.0-preview")).toEqual({ version: 6, versionString: "6.0", isPreview: true, resourceVersion: undefined });
    expect(parseApiVersion("7.1")).toEqual({ version: 7.1, versionString: "7.1", isPreview: false, resourceVersion: undefined });
    expect(parseApiVersion("latest")).toBeUndefined();
  });

  it.each([
    ["7.2-preview.1", "6.0", "6.0-preview"],
    ["7.2-preview.3", "7.0", "7.0-preview"],
    ["7.1", "6.0", "6.0"],
    ["7.1", "7.1", "7.1"],
    ["7.2-preview.4", "7.2", "7.2-preview.4"],
    ["5.0", "6.0", "5.0"],
    ["weird", "6.0", "weird"],
    ["7.1", "weird", "7.1"],
  ])("clamps %s on a %s server to %s", (requested, ceiling, expected) => {
    expect(clampApiVersion(requested, ceiling)).toBe(expected);
  });

  it.each([
    // Requested version available on the server: keep it.
    ["7.1", location("7.2", "7.1", 1), "7.1"],
    ["7.2-preview.4", location("7.2", "7.1", 4), "7.2-preview.4"],
    ["7.2-preview", location("7.2", "7.1", 1), "7.2-preview"],
    // Azure DevOps Server 2020: resources top out at 6.0.
    ["7.2-preview.1", location("6.0", "6.0", 1), "6.0"],
    ["7.2-preview.4", location("6.0", "5.1", 3), "6.0-preview.3"],
    ["7.1", location("6.0", "6.0", 1), "6.0"],
    // Resource version too new for the server.
    ["7.1-preview.4", location("7.1", "7.0", 3), "7.1-preview.3"],
    ["7.0-preview.4", location("7.1", "6.0", 3), "7.0-preview"],
    // Unparseable request falls back to the location's latest version.
    ["bogus", location("7.0", "7.0", 1), "7.0"],
  ])("negotiates %s against %j to %s", (requested, loc, expected) => {
    expect(negotiateWithLocation(loc, requested)).toBe(expected);
  });

  it.each([
    ["7.2-preview.4", true],
    ["7.1-preview.4", true],
    ["7.1-preview.3", false],
    ["7.2-preview", true],
    ["7.1", false],
    ["6.0-preview.3", false],
    ["6.0", false],
    ["nope", false],
  ])("supportsMarkdownComments(%s) = %s", (version, expected) => {
    expect(supportsMarkdownComments(version)).toBe(expected);
  });
});

describe("negotiateApiVersion / getServerVersionInfo", () => {
  beforeEach(() => {
    resetServerVersionState();
  });

  afterEach(() => {
    setServerContext(parseServerTarget("unknown"));
    resetServerVersionState();
  });

  describe("cloud", () => {
    beforeEach(() => setServerContext(parseServerTarget("contoso")));

    it("returns the requested version without contacting the server", async () => {
      const { connection, beginGetLocation } = createConnection({});
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.workItemComments)).resolves.toBe("7.2-preview.4");
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.orgPullRequests)).resolves.toBe("7.1");
      expect(beginGetLocation).not.toHaveBeenCalled();
    });

    it("reports the cloud profile", async () => {
      const { connection } = createConnection({});
      await expect(getServerVersionInfo(connection)).resolves.toEqual({ profile: "cloud", apiVersion: "7.2", source: "cloud" });
    });
  });

  describe("on-premises", () => {
    beforeEach(() => setServerContext(parseServerTarget("https://tfs.contoso.com/tfs/DefaultCollection")));

    it("negotiates against the resource location advertised by the server", async () => {
      const { connection, beginGetLocation } = createConnection({
        [`wit/${API_ENDPOINTS.workItemComments.locationId}`]: location("6.0", "5.1", 3),
      });
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.workItemComments)).resolves.toBe("6.0-preview.3");
      expect(beginGetLocation).toHaveBeenCalledWith("wit", API_ENDPOINTS.workItemComments.locationId);
    });

    it("caches resource locations", async () => {
      const { connection, beginGetLocation } = createConnection({
        [`testplan/${API_ENDPOINTS.testPlans.locationId}`]: location("7.0", "7.0", 1),
      });
      await negotiateApiVersion(connection, API_ENDPOINTS.testPlans);
      await negotiateApiVersion(connection, API_ENDPOINTS.testPlans);
      expect(beginGetLocation).toHaveBeenCalledTimes(1);
    });

    it("falls back to the detected server ceiling when the location is unknown", async () => {
      const { connection } = createConnection({ [coreKey]: location("7.0", "7.0", 1) });
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.codeSearch)).resolves.toBe("7.0-preview");
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.commitSearch)).resolves.toBe("7.0-preview");
    });

    it("falls back to the lowest profile when nothing can be detected", async () => {
      const { connection } = createConnection(async () => {
        throw new Error("network down");
      });
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.orgPullRequests)).resolves.toBe("6.0");
      await expect(getServerVersionInfo(connection)).resolves.toEqual({ profile: "2020", apiVersion: "6.0", source: "fallback" });
    });

    it("retries detection after a failure", async () => {
      let attempts = 0;
      const { connection } = createConnection(async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return location("7.1", "7.1", 1);
      });
      await expect(getServerVersionInfo(connection)).resolves.toMatchObject({ source: "fallback" });
      await expect(getServerVersionInfo(connection)).resolves.toEqual({ profile: "2022.1", apiVersion: "7.1", source: "detected" });
    });

    it.each([
      ["6.0", "2020"],
      ["7.0", "2022"],
      ["7.1", "2022.1"],
      ["7.2", "26h2"],
    ])("auto-detects REST API %s as profile %s", async (maxVersion, profile) => {
      const { connection } = createConnection({ [coreKey]: location(maxVersion, maxVersion, 1) });
      await expect(getServerVersionInfo(connection)).resolves.toEqual({ profile, apiVersion: maxVersion, source: "detected" });
    });

    it("treats a missing core location as a detection failure", async () => {
      const { connection } = createConnection({});
      await expect(getServerVersionInfo(connection)).resolves.toMatchObject({ profile: "2020", source: "fallback" });
    });

    it("uses the configured --server-version without detection", async () => {
      configureServerVersion("2022");
      expect(getConfiguredServerVersion()).toBe("2022");
      const { connection, beginGetLocation } = createConnection({});
      await expect(getServerVersionInfo(connection)).resolves.toEqual({ profile: "2022", apiVersion: "7.0", source: "configured" });
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.workItemComments)).resolves.toBe("7.0-preview");
      // Resource location lookup is still attempted (it is more precise), but not core detection.
      expect(beginGetLocation).toHaveBeenCalledWith("wit", API_ENDPOINTS.workItemComments.locationId);
      expect(beginGetLocation).not.toHaveBeenCalledWith("core", API_ENDPOINTS.coreProjects.locationId);
    });

    it("keeps versions the server already supports", async () => {
      configureServerVersion("26h2");
      const { connection } = createConnection({});
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.workItemComments)).resolves.toBe("7.2-preview.4");
      await expect(negotiateApiVersion(connection, API_ENDPOINTS.wikiPages)).resolves.toBe("7.1");
    });
  });
});
