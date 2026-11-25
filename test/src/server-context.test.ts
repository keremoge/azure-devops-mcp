// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, afterEach } from "@jest/globals";
import {
  describeTarget,
  getIdentitiesBaseUrl,
  getSearchBaseUrl,
  getServerContext,
  isOnPremises,
  isSameCollection,
  isTrustedServerUrl,
  normalizeTrustedHosts,
  parseServerTarget,
  setServerContext,
} from "../../src/server-context";

describe("parseServerTarget", () => {
  it("treats a bare name as an Azure DevOps Services organization", () => {
    expect(parseServerTarget("contoso")).toEqual({
      kind: "cloud",
      orgName: "contoso",
      orgUrl: "https://dev.azure.com/contoso",
      origin: "https://dev.azure.com",
      insecureHttp: false,
    });
  });

  it("trims whitespace around the organization", () => {
    expect(parseServerTarget("  contoso  ").orgUrl).toBe("https://dev.azure.com/contoso");
  });

  it.each([
    ["https://dev.azure.com/contoso", "contoso"],
    ["https://dev.azure.com/contoso/", "contoso"],
    ["https://dev.azure.com/contoso/MyProject/_git/repo", "contoso"],
    ["https://contoso.visualstudio.com", "contoso"],
    ["https://contoso.visualstudio.com/DefaultCollection", "contoso"],
  ])("normalizes cloud URL %s to organization %s", (input, org) => {
    const target = parseServerTarget(input);
    expect(target.kind).toBe("cloud");
    expect(target.orgName).toBe(org);
    expect(target.orgUrl).toBe(`https://dev.azure.com/${org}`);
  });

  it.each([
    ["https://tfs.contoso.com/tfs/DefaultCollection", "https://tfs.contoso.com/tfs/DefaultCollection", "DefaultCollection", "https://tfs.contoso.com"],
    ["https://tfs.contoso.com/tfs/DefaultCollection/", "https://tfs.contoso.com/tfs/DefaultCollection", "DefaultCollection", "https://tfs.contoso.com"],
    ["https://ado.contoso.com/ProductCollection", "https://ado.contoso.com/ProductCollection", "ProductCollection", "https://ado.contoso.com"],
    ["https://tfs01:8443/tfs/Fabrikam", "https://tfs01:8443/tfs/Fabrikam", "Fabrikam", "https://tfs01:8443"],
    ["https://ado.contoso.com/tfs/My%20Collection", "https://ado.contoso.com/tfs/My%20Collection", "My Collection", "https://ado.contoso.com"],
  ])("parses Azure DevOps Server collection URL %s", (input, orgUrl, orgName, origin) => {
    expect(parseServerTarget(input)).toEqual({ kind: "onprem", orgUrl, orgName, origin, insecureHttp: false });
  });

  it("accepts plain http collection URLs and flags them as insecure", () => {
    const target = parseServerTarget("http://tfs01:8080/tfs/DefaultCollection");
    expect(target.kind).toBe("onprem");
    expect(target.insecureHttp).toBe(true);
    expect(target.origin).toBe("http://tfs01:8080");
  });

  it("drops query strings and fragments from the collection URL", () => {
    expect(parseServerTarget("https://tfs.contoso.com/tfs/DefaultCollection?x=1#top").orgUrl).toBe("https://tfs.contoso.com/tfs/DefaultCollection");
  });

  it("requires a collection path for Azure DevOps Server", () => {
    expect(() => parseServerTarget("https://tfs.contoso.com")).toThrow(/must include the collection/);
    expect(() => parseServerTarget("https://tfs.contoso.com/")).toThrow(/must include the collection/);
  });

  it("rejects empty, invalid and unsupported inputs", () => {
    expect(() => parseServerTarget("")).toThrow(/required/);
    expect(() => parseServerTarget("contoso org")).toThrow(/Invalid organization/);
    expect(() => parseServerTarget("ftp://tfs.contoso.com/tfs/DefaultCollection")).toThrow(/Unsupported protocol/);
    expect(() => parseServerTarget("https://")).toThrow(/Invalid organization URL/);
    expect(() => parseServerTarget("http://dev.azure.com/contoso")).toThrow(/must use https/);
    expect(() => parseServerTarget("https://dev.azure.com/")).toThrow(/Could not determine the organization/);
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() => parseServerTarget("https://user:secret@tfs.contoso.com/tfs/DefaultCollection")).toThrow(/Credentials must not be embedded/);
  });
});

describe("normalizeTrustedHosts", () => {
  it("normalizes host names, URLs and comma separated values", () => {
    expect(normalizeTrustedHosts(["Public.Contoso.com", "https://alias.contoso.com:8443/tfs", "a.contoso.com, b.contoso.com", " "])).toEqual([
      "public.contoso.com",
      "alias.contoso.com:8443",
      "a.contoso.com",
      "b.contoso.com",
    ]);
  });

  it("handles undefined and single values", () => {
    expect(normalizeTrustedHosts(undefined)).toEqual([]);
    expect(normalizeTrustedHosts("host.contoso.com")).toEqual(["host.contoso.com"]);
  });
});

describe("server context", () => {
  afterEach(() => {
    setServerContext(parseServerTarget("unknown"));
  });

  describe("cloud", () => {
    it("builds Search and Identities URLs on Azure DevOps Services hosts", () => {
      setServerContext(parseServerTarget("contoso"));
      expect(isOnPremises()).toBe(false);
      expect(getSearchBaseUrl()).toBe("https://almsearch.dev.azure.com/contoso");
      expect(getIdentitiesBaseUrl()).toBe("https://vssps.dev.azure.com/contoso");
      expect(getSearchBaseUrl("https://dev.azure.com/other")).toBe("https://almsearch.dev.azure.com/other");
      expect(getIdentitiesBaseUrl("https://dev.azure.com/other")).toBe("https://vssps.dev.azure.com/other");
    });

    it("ignores trusted hosts for cloud", () => {
      const ctx = setServerContext(parseServerTarget("contoso"), ["evil.example.com"]);
      expect(ctx.trustedHosts).toEqual([]);
      expect(isTrustedServerUrl("https://evil.example.com/x")).toBe(false);
    });

    it("trusts only Azure DevOps Services hosts over https", () => {
      setServerContext(parseServerTarget("contoso"));
      expect(isTrustedServerUrl("https://dev.azure.com/contoso/_apis")).toBe(true);
      expect(isTrustedServerUrl(new URL("https://artifacts.dev.azure.com/contoso"))).toBe(true);
      expect(isTrustedServerUrl("https://contoso.visualstudio.com/_apis")).toBe(true);
      expect(isTrustedServerUrl("http://dev.azure.com/contoso")).toBe(false);
      expect(isTrustedServerUrl("https://tfs.contoso.com/tfs/DefaultCollection")).toBe(false);
      expect(isTrustedServerUrl("not a url")).toBe(false);
    });

    it("compares organizations for cross-organization checks", () => {
      setServerContext(parseServerTarget("contoso"));
      expect(isSameCollection("https://dev.azure.com/contoso/p/_wiki/wikis/w", "https://dev.azure.com/contoso")).toBe(true);
      expect(isSameCollection("https://contoso.visualstudio.com/p/_wiki/wikis/w", "https://dev.azure.com/Contoso")).toBe(true);
      expect(isSameCollection("https://dev.azure.com/fabrikam/p/_wiki/wikis/w", "https://dev.azure.com/contoso")).toBe(false);
      expect(isSameCollection("https://custom.example.com/p/_wiki/wikis/w", "https://dev.azure.com/contoso")).toBe(false);
      expect(isSameCollection("not a url", "https://dev.azure.com/contoso")).toBe(false);
    });

    it("describes cloud targets by organization", () => {
      setServerContext(parseServerTarget("contoso"));
      expect(describeTarget("https://dev.azure.com/contoso/p")).toBe("contoso");
      expect(describeTarget("https://custom.example.com/p/_wiki/wikis/w")).toBe("unknown");
    });
  });

  describe("on-premises", () => {
    const collectionUrl = "https://tfs.contoso.com/tfs/DefaultCollection";

    it("uses the collection URL for Search and Identities", () => {
      setServerContext(parseServerTarget(collectionUrl));
      expect(isOnPremises()).toBe(true);
      expect(getServerContext().orgName).toBe("DefaultCollection");
      expect(getSearchBaseUrl()).toBe(collectionUrl);
      expect(getIdentitiesBaseUrl()).toBe(collectionUrl);
      expect(getSearchBaseUrl(collectionUrl + "/")).toBe(collectionUrl);
      expect(getIdentitiesBaseUrl(collectionUrl)).toBe(collectionUrl);
    });

    it("trusts only the configured origin (https)", () => {
      setServerContext(parseServerTarget(collectionUrl));
      expect(isTrustedServerUrl(`${collectionUrl}/_apis/projects`)).toBe(true);
      expect(isTrustedServerUrl("https://TFS.contoso.com/tfs/OtherCollection/_apis")).toBe(true);
      expect(isTrustedServerUrl("http://tfs.contoso.com/tfs/DefaultCollection")).toBe(false);
      expect(isTrustedServerUrl("https://tfs.contoso.com:8443/tfs/DefaultCollection")).toBe(false);
      expect(isTrustedServerUrl("https://evil.example.com/tfs/DefaultCollection")).toBe(false);
      expect(isTrustedServerUrl("https://dev.azure.com/contoso")).toBe(false);
      expect(isTrustedServerUrl("ftp://tfs.contoso.com/x")).toBe(false);
    });

    it("trusts plain http only when the collection URL is http", () => {
      setServerContext(parseServerTarget("http://tfs01:8080/tfs/DefaultCollection"));
      expect(isTrustedServerUrl("http://tfs01:8080/tfs/DefaultCollection/_apis")).toBe(true);
      expect(isTrustedServerUrl("http://tfs01/tfs/DefaultCollection/_apis")).toBe(false);
      expect(isTrustedServerUrl("http://other:8080/x")).toBe(false);
    });

    it("trusts additional hosts configured with --trusted-host", () => {
      setServerContext(parseServerTarget(collectionUrl), ["public.contoso.com", "alias.contoso.com:8443"]);
      expect(isTrustedServerUrl("https://public.contoso.com/tfs/DefaultCollection/_apis/resources")).toBe(true);
      expect(isTrustedServerUrl("https://alias.contoso.com:8443/x")).toBe(true);
      expect(isTrustedServerUrl("http://public.contoso.com/x")).toBe(false);
      expect(isTrustedServerUrl("https://other.contoso.com/x")).toBe(false);
    });

    it("checks that URLs belong to the configured collection", () => {
      setServerContext(parseServerTarget(collectionUrl));
      expect(isSameCollection(`${collectionUrl}/Project/_wiki/wikis/Wiki?pagePath=%2FHome`, collectionUrl)).toBe(true);
      expect(isSameCollection("https://tfs.contoso.com/tfs/defaultcollection/Project/_wiki/wikis/Wiki", collectionUrl)).toBe(true);
      expect(isSameCollection(collectionUrl, collectionUrl + "/")).toBe(true);
      expect(isSameCollection("https://tfs.contoso.com/tfs/OtherCollection/Project/_wiki/wikis/Wiki", collectionUrl)).toBe(false);
      expect(isSameCollection("https://tfs.contoso.com/tfs/DefaultCollectionX/Project/_wiki/wikis/Wiki", collectionUrl)).toBe(false);
      expect(isSameCollection("https://other.contoso.com/tfs/DefaultCollection/Project/_wiki/wikis/Wiki", collectionUrl)).toBe(false);
    });

    it("accepts trusted host aliases for the same collection", () => {
      setServerContext(parseServerTarget(collectionUrl), ["public.contoso.com"]);
      expect(isSameCollection("https://public.contoso.com/tfs/DefaultCollection/Project/_wiki/wikis/Wiki", collectionUrl)).toBe(true);
    });

    it("uses the configured collection by default", () => {
      setServerContext(parseServerTarget(collectionUrl));
      expect(isSameCollection(`${collectionUrl}/Project/_wiki/wikis/Wiki`)).toBe(true);
    });

    it("describes on-prem targets by collection URL", () => {
      setServerContext(parseServerTarget(collectionUrl));
      expect(describeTarget("https://tfs.contoso.com/tfs/Other/Project/_wiki/wikis/Wiki")).toBe("https://tfs.contoso.com/tfs/Other");
      expect(describeTarget(collectionUrl)).toBe(collectionUrl);
      expect(describeTarget("::")).toBe("unknown");
    });
  });
});
