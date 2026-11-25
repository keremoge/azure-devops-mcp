// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";

jest.mock("../../src/logger.js", () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock("@azure/identity", () => ({
  AzureCliCredential: jest.fn(),
  ChainedTokenCredential: jest.fn(),
  DefaultAzureCredential: jest.fn(),
}));

jest.mock("@azure/msal-node", () => ({ PublicClientApplication: jest.fn() }));
jest.mock("@azure/msal-node-extensions", () => ({ NativeBrokerPlugin: jest.fn() }));
jest.mock("open", () => jest.fn());

import {
  AUTHENTICATION_TYPES,
  ON_PREMISES_AUTHENTICATION_TYPES,
  createAuthenticator,
  decodeBasicCredential,
  installBasicAuthFetchInterceptor,
  installPatFetchInterceptor,
  isBasicCredentialAuthType,
  validateAuthenticationForDeployment,
} from "../../src/auth";
import { parseServerTarget, setServerContext } from "../../src/server-context";

describe("Azure DevOps Server authentication", () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  const basicValue = Buffer.from(":my-onprem-pat").toString("base64");

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    setServerContext(parseServerTarget("unknown"));
  });

  describe("authentication types", () => {
    it("exposes basic authentication and the on-prem subset", () => {
      expect(AUTHENTICATION_TYPES).toContain("basic");
      expect(ON_PREMISES_AUTHENTICATION_TYPES).toEqual(["pat", "basic"]);
      expect(isBasicCredentialAuthType("pat")).toBe(true);
      expect(isBasicCredentialAuthType("basic")).toBe(true);
      expect(isBasicCredentialAuthType("interactive")).toBe(false);
      expect(isBasicCredentialAuthType("envvar")).toBe(false);
    });

    it.each(["pat", "basic"])("allows '%s' for Azure DevOps Server", (type) => {
      expect(() => validateAuthenticationForDeployment(type, "onprem")).not.toThrow();
    });

    it.each(["interactive", "azcli", "env", "envvar"])("rejects Entra-based '%s' for Azure DevOps Server", (type) => {
      expect(() => validateAuthenticationForDeployment(type, "onprem")).toThrow(/not supported with Azure DevOps Server/);
    });

    it.each(["interactive", "azcli", "env", "envvar", "pat"])("allows '%s' for Azure DevOps Services", (type) => {
      expect(() => validateAuthenticationForDeployment(type, "cloud")).not.toThrow();
    });

    it("rejects basic authentication for Azure DevOps Services", () => {
      expect(() => validateAuthenticationForDeployment("basic", "cloud")).toThrow(/only supported with Azure DevOps Server/);
    });
  });

  describe("createAuthenticator('basic')", () => {
    it("encodes ADO_MCP_USERNAME and ADO_MCP_PASSWORD as a Basic credential", async () => {
      process.env["ADO_MCP_USERNAME"] = "CONTOSO\\builder";
      process.env["ADO_MCP_PASSWORD"] = "p@ss:word";

      const value = await createAuthenticator("basic")();

      expect(Buffer.from(value, "base64").toString("utf8")).toBe("CONTOSO\\builder:p@ss:word");
      expect(decodeBasicCredential(value)).toEqual({ username: "CONTOSO\\builder", secret: "p@ss:word" });
    });

    it.each([
      [undefined, "password"],
      ["user", undefined],
      ["", "password"],
      ["user", ""],
    ])("requires both variables (username=%s, password=%s)", async (username, password) => {
      if (username === undefined) delete process.env["ADO_MCP_USERNAME"];
      else process.env["ADO_MCP_USERNAME"] = username;
      if (password === undefined) delete process.env["ADO_MCP_PASSWORD"];
      else process.env["ADO_MCP_PASSWORD"] = password;

      await expect(createAuthenticator("basic")()).rejects.toThrow("Environment variables 'ADO_MCP_USERNAME' and 'ADO_MCP_PASSWORD' must be set");
    });

    it("rejects user names containing ':'", async () => {
      process.env["ADO_MCP_USERNAME"] = "bad:user";
      process.env["ADO_MCP_PASSWORD"] = "secret";
      await expect(createAuthenticator("basic")()).rejects.toThrow("must not contain ':'");
    });
  });

  describe("decodeBasicCredential", () => {
    it("splits on the first ':' only", () => {
      expect(decodeBasicCredential(Buffer.from("user@example.com:tok:en").toString("base64"))).toEqual({ username: "user@example.com", secret: "tok:en" });
    });

    it("supports PATs without a user name", () => {
      expect(decodeBasicCredential(basicValue)).toEqual({ username: "", secret: "my-onprem-pat" });
    });

    it("treats a value without ':' as the secret", () => {
      expect(decodeBasicCredential(Buffer.from("rawtoken").toString("base64"))).toEqual({ username: "", secret: "rawtoken" });
    });
  });

  describe("fetch interceptor with an Azure DevOps Server collection", () => {
    function install(collectionUrl: string, trustedHosts: string[] = []) {
      setServerContext(parseServerTarget(collectionUrl), trustedHosts);
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(new Response());
      globalThis.fetch = fetchMock;
      installPatFetchInterceptor(basicValue);
      return fetchMock;
    }

    it("rewrites Bearer to Basic for the configured collection", async () => {
      const fetchMock = install("https://tfs.contoso.com/tfs/DefaultCollection");

      await fetch("https://tfs.contoso.com/tfs/DefaultCollection/_apis/connectionData", { headers: { Authorization: `Bearer ${basicValue}` } });

      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Basic ${basicValue}`);
    });

    it("allows plain http when the collection URL is http", async () => {
      const fetchMock = install("http://tfs01:8080/tfs/DefaultCollection");

      await fetch("http://tfs01:8080/tfs/DefaultCollection/_apis/projects", { headers: { Authorization: `Bearer ${basicValue}` } });

      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Basic ${basicValue}`);
    });

    it("rewrites for hosts configured with --trusted-host", async () => {
      const fetchMock = install("https://tfs01/tfs/DefaultCollection", ["tfs.contoso.com"]);

      await fetch("https://tfs.contoso.com/tfs/DefaultCollection/_apis/resources/Containers/1", { headers: { Authorization: `Bearer ${basicValue}` } });

      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Basic ${basicValue}`);
    });

    it.each([
      "http://tfs.contoso.com/tfs/DefaultCollection/_apis/projects",
      "https://tfs.contoso.com:8443/tfs/DefaultCollection/_apis/projects",
      "https://attacker.example/tfs/DefaultCollection",
      "https://dev.azure.com/contoso",
      "https://vssps.dev.azure.com/contoso",
    ])("refuses to send the credential to %s", async (url) => {
      const fetchMock = install("https://tfs.contoso.com/tfs/DefaultCollection");

      await expect(fetch(url, { headers: { Authorization: `Bearer ${basicValue}` } })).rejects.toThrow("Refusing to send a Personal Access Token to untrusted destination");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts a custom trust policy", async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(new Response());
      globalThis.fetch = fetchMock;
      installBasicAuthFetchInterceptor(basicValue, (url) => url.hostname === "only.example");

      await fetch("https://only.example/x", { headers: { Authorization: `Bearer ${basicValue}` } });
      await expect(fetch("https://dev.azure.com/org", { headers: { Authorization: `Bearer ${basicValue}` } })).rejects.toThrow("untrusted destination");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
