// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";

jest.mock("../../../src/logger", () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { parseServerTarget, setServerContext } from "../../../src/server-context";
import { API_ENDPOINTS, configureServerVersion, resetServerVersionState } from "../../../src/server-version";
import { Domain } from "../../../src/shared/domains";
import { configureAllTools } from "../../../src/tools";
import { searchIdentities } from "../../../src/tools/auth";
import { configurePipelineTools } from "../../../src/tools/pipelines";
import { configureRepoTools } from "../../../src/tools/repositories";
import { configureSearchTools } from "../../../src/tools/search";
import { configureTestPlanTools } from "../../../src/tools/test-plans";
import { configureWikiTools } from "../../../src/tools/wiki";
import { configureWorkItemTools } from "../../../src/tools/work-items";

const COLLECTION_URL = "https://tfs.contoso.com/tfs/DefaultCollection";

interface Location {
  maxVersion: string;
  releasedVersion: string;
  resourceVersion: number;
}

/** REST locations as advertised by an Azure DevOps Server 2020 Update 1 collection. */
const SERVER_2020_LOCATIONS: Record<string, Location> = {
  [`core/${API_ENDPOINTS.coreProjects.locationId}`]: { maxVersion: "6.0", releasedVersion: "6.0", resourceVersion: 4 },
  [`wit/${API_ENDPOINTS.workItemComments.locationId}`]: { maxVersion: "6.0", releasedVersion: "5.1", resourceVersion: 3 },
  [`search/${API_ENDPOINTS.codeSearch.locationId}`]: { maxVersion: "6.0", releasedVersion: "0.0", resourceVersion: 1 },
  [`testplan/${API_ENDPOINTS.testPlans.locationId}`]: { maxVersion: "6.0", releasedVersion: "6.0", resourceVersion: 1 },
  [`wiki/${API_ENDPOINTS.wikiPageById.locationId}`]: { maxVersion: "6.0", releasedVersion: "6.0", resourceVersion: 1 },
  [`build/${API_ENDPOINTS.buildStages.locationId}`]: { maxVersion: "6.0", releasedVersion: "0.0", resourceVersion: 1 },
};

/** REST locations as advertised by an Azure DevOps Server 26H2 collection. */
const SERVER_26H2_LOCATIONS: Record<string, Location> = {
  [`core/${API_ENDPOINTS.coreProjects.locationId}`]: { maxVersion: "7.2", releasedVersion: "7.1", resourceVersion: 4 },
  [`wit/${API_ENDPOINTS.workItemComments.locationId}`]: { maxVersion: "7.2", releasedVersion: "7.1", resourceVersion: 4 },
};

function getHandler(server: McpServer, toolName: string) {
  const call = (server.tool as jest.Mock).mock.calls.find(([name]) => name === toolName);
  if (!call) throw new Error(`${toolName} tool not registered`);
  return call[call.length - 1] as (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("Azure DevOps Server (on-premises) tool behavior", () => {
  let server: McpServer;
  let tokenProvider: jest.MockedFunction<() => Promise<string>>;
  let connectionProvider: jest.MockedFunction<() => Promise<WebApi>>;
  let fetchMock: jest.Mock;
  let beginGetLocation: jest.Mock;
  let mockConnection: Record<string, unknown>;
  const originalFetch = global.fetch;
  const userAgentProvider = () => "Jest";

  function useLocations(locations: Record<string, Location>) {
    beginGetLocation.mockImplementation(async (area: string, id: string) => locations[`${area}/${id}`]);
  }

  beforeEach(() => {
    setServerContext(parseServerTarget(COLLECTION_URL), ["public.contoso.com"]);
    resetServerVersionState();
    server = { tool: jest.fn(), registerTool: jest.fn() } as unknown as McpServer;
    tokenProvider = jest.fn().mockResolvedValue("fake-token");
    beginGetLocation = jest.fn();
    useLocations(SERVER_2020_LOCATIONS);
    mockConnection = {
      serverUrl: COLLECTION_URL,
      vsoClient: { beginGetLocation },
      getGitApi: jest.fn().mockResolvedValue({ getItem: jest.fn() }),
    };
    connectionProvider = jest.fn().mockResolvedValue(mockConnection as unknown as WebApi);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setServerContext(parseServerTarget("unknown"));
    resetServerVersionState();
  });

  describe("search", () => {
    it("sends code search to the collection with a negotiated api-version", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ count: 0, results: [] }));
      configureSearchTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await getHandler(server, "search_code")({ searchText: "auth", includeFacets: false, skip: 0, top: 5 });

      expect(fetchMock).toHaveBeenCalledWith(`${COLLECTION_URL}/_apis/search/codesearchresults?api-version=6.0-preview.1`, expect.objectContaining({ method: "POST" }));
    });

    it("clamps wiki and work item search to the server ceiling when the location is unknown", async () => {
      fetchMock.mockImplementation(async () => jsonResponse({ count: 0, results: [] }));
      configureSearchTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await getHandler(server, "search_wiki")({ searchText: "x", includeFacets: false, skip: 0, top: 5 });
      await getHandler(server, "search_workitem")({ searchText: "x", includeFacets: false, skip: 0, top: 5 });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/_apis/search/wikisearchresults?api-version=6.0-preview`);
      expect(fetchMock.mock.calls[1][0]).toBe(`${COLLECTION_URL}/_apis/search/workitemsearchresults?api-version=6.0-preview`);
    });

    it("explains that the Search extension is required when search is not available", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 404, statusText: "Not Found" }));
      configureSearchTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await expect(getHandler(server, "search_code")({ searchText: "auth", includeFacets: false, skip: 0, top: 5 })).rejects.toThrow(/requires the Search extension/);
    });

    it("sends commit search to the collection", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ count: 0, results: [] }));
      configureRepoTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await getHandler(server, "repo_search_commits")({ searchText: "fix", includeFacets: false, skip: 0, top: 10 });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/_apis/search/commitSearchResults?api-version=6.0-preview`);
    });

    it("adds an on-prem hint when commit search is unavailable", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 404, statusText: "Not Found" }));
      configureRepoTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await expect(getHandler(server, "repo_search_commits")({ searchText: "fix", includeFacets: false, skip: 0, top: 10 })).rejects.toThrow(/Search extension/);
    });
  });

  describe("identities", () => {
    it("resolves identities from the collection instead of vssps.dev.azure.com", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ value: [{ id: "user-1" }] }));

      await searchIdentities("CONTOSO\\jdoe", tokenProvider, connectionProvider, userAgentProvider);

      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(`${url.origin}${url.pathname}`).toBe(`${COLLECTION_URL}/_apis/identities`);
      expect(url.searchParams.get("api-version")).toBe("6.0-preview");
      expect(url.searchParams.get("filterValue")).toBe("CONTOSO\\jdoe");
    });
  });

  describe("work item comments", () => {
    it("stores Markdown comments as HTML on Azure DevOps Server 2020", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ workItemId: 42, id: 7, version: 1, createdDate: "2026-01-01", url: "u" }));
      configureWorkItemTools(server, tokenProvider, connectionProvider, userAgentProvider);

      const result = await getHandler(server, "wit_work_item_comment_write")({ action: "add", project: "Fabrikam", workItemId: 42, text: "line 1\nline 2", format: "Markdown" });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/wit/workItems/42/comments?api-version=6.0-preview.3`);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "line 1<br>line 2" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("does not support Markdown comments");
    });

    it("keeps HTML comments unchanged on Azure DevOps Server 2020", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ workItemId: 42, id: 7, version: 2 }));
      configureWorkItemTools(server, tokenProvider, connectionProvider, userAgentProvider);

      const result = await getHandler(server, "wit_work_item_comment_write")({ action: "update", project: "Fabrikam", workItemId: 42, commentId: 7, text: "<b>hi</b>", format: "Html" });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/wit/workItems/42/comments/7?api-version=6.0-preview.3`);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "<b>hi</b>" });
      expect(result.content[0].text).not.toContain("does not support Markdown");
    });

    it("uses the Markdown format parameter on Azure DevOps Server 26H2", async () => {
      useLocations(SERVER_26H2_LOCATIONS);
      fetchMock.mockResolvedValue(jsonResponse({ workItemId: 42, id: 7, version: 1 }));
      configureWorkItemTools(server, tokenProvider, connectionProvider, userAgentProvider);

      const result = await getHandler(server, "wit_work_item_comment_write")({ action: "add", project: "Fabrikam", workItemId: 42, text: "**bold**", format: "Markdown" });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/wit/workItems/42/comments?format=0&api-version=7.2-preview.4`);
      expect(result.content[0].text).not.toContain("does not support Markdown");
    });

    it("honors an explicit --server-version when locations cannot be read", async () => {
      beginGetLocation.mockRejectedValue(new Error("OPTIONS blocked by proxy"));
      configureServerVersion("2022");
      fetchMock.mockResolvedValue(jsonResponse({ workItemId: 42, id: 7, version: 1 }));
      configureWorkItemTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await getHandler(server, "wit_work_item_comment_write")({ action: "add", project: "Fabrikam", workItemId: 42, text: "hello", format: "Markdown" });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/wit/workItems/42/comments?api-version=7.0-preview`);
    });
  });

  describe("wiki", () => {
    it("rejects wiki URLs from another collection", async () => {
      const mockWikiApi = { getPageText: jest.fn() };
      mockConnection.getWikiApi = jest.fn().mockResolvedValue(mockWikiApi);
      configureWikiTools(server, tokenProvider, connectionProvider, userAgentProvider);

      const result = await getHandler(server, "wiki")({ action: "get_page_content", url: "https://tfs.contoso.com/tfs/OtherCollection/Fabrikam/_wiki/wikis/Fabrikam.wiki?pagePath=%2FHome" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("https://tfs.contoso.com/tfs/OtherCollection");
      expect(result.content[0].text).toContain("Cross-organization requests are not allowed");
      expect(mockWikiApi.getPageText).not.toHaveBeenCalled();
    });

    it("reads wiki pages by id from the configured collection", async () => {
      const mockWikiApi = { getPageText: jest.fn() };
      mockConnection.getWikiApi = jest.fn().mockResolvedValue(mockWikiApi);
      fetchMock.mockResolvedValue(jsonResponse({ content: "# Home page", path: "/Home" }));
      configureWikiTools(server, tokenProvider, connectionProvider, userAgentProvider);

      const result = await getHandler(server, "wiki")({ action: "get_page_content", url: `${COLLECTION_URL}/Fabrikam/_wiki/wikis/Fabrikam.wiki/12/Home` });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/wiki/wikis/Fabrikam.wiki/pages/12?includeContent=true&api-version=6.0`);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("# Home page");
    });
  });

  describe("test plans", () => {
    it("lists test plans with a negotiated api-version", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ value: [{ id: 1, name: "Plan" }] }));
      configureTestPlanTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await getHandler(server, "testplan")({ action: "list_plans", project: "Fabrikam" });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/testplan/Plans?api-version=6.0`);
    });
  });

  describe("pipelines", () => {
    it("updates build stages with a negotiated api-version", async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
      configurePipelineTools(server, tokenProvider, connectionProvider, userAgentProvider);

      await getHandler(server, "pipelines_write")({ action: "update_build_stage", project: "Fabrikam", buildId: 5, stageName: "Build", status: "Retry", forceRetryAllJobs: false });

      expect(fetchMock.mock.calls[0][0]).toBe(`${COLLECTION_URL}/Fabrikam/_apis/build/builds/5/stages/Build?api-version=6.0-preview.1`);
    });

    it.each([`${COLLECTION_URL}/Fabrikam/_apis/build/builds/5/artifacts?artifactName=drop&$format=zip`, "https://public.contoso.com/tfs/DefaultCollection/_apis/resources/Containers/1?itemPath=drop"])(
      "downloads artifacts from trusted on-prem URL %s",
      async (downloadUrl) => {
        const buildApi = { getArtifact: jest.fn().mockResolvedValue({ name: "drop", resource: { downloadUrl } }) };
        mockConnection.getBuildApi = jest.fn().mockResolvedValue(buildApi);
        fetchMock.mockResolvedValue(new Response("zip-bytes", { status: 200, headers: { "content-length": "9" } }));
        configurePipelineTools(server, tokenProvider, connectionProvider, userAgentProvider);

        const result = await getHandler(server, "pipelines_artifact")({ action: "download", project: "Fabrikam", buildId: 5, artifactName: "drop" });

        expect(fetchMock).toHaveBeenCalledWith(downloadUrl, expect.anything());
        expect(result.isError).toBeFalsy();
      }
    );

    it("refuses artifact downloads from untrusted hosts", async () => {
      const buildApi = { getArtifact: jest.fn().mockResolvedValue({ name: "drop", resource: { downloadUrl: "https://attacker.example/drop.zip" } }) };
      mockConnection.getBuildApi = jest.fn().mockResolvedValue(buildApi);
      configurePipelineTools(server, tokenProvider, connectionProvider, userAgentProvider);

      const result = await getHandler(server, "pipelines_artifact")({ action: "download", project: "Fabrikam", buildId: 5, artifactName: "drop" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Untrusted artifact download URL 'https://attacker.example'");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("tool registration", () => {
    it("skips cloud-only Advanced Security tools on Azure DevOps Server", () => {
      const realServer = new McpServer({ name: "onprem-test", version: "1.0.0" });
      const tool = jest.spyOn(realServer, "tool");
      configureAllTools(realServer, tokenProvider, connectionProvider, userAgentProvider, new Set([Domain.ADVANCED_SECURITY, Domain.CORE]));

      const names = tool.mock.calls.map(([name]) => name);
      expect(names).toContain("core_list_projects");
      expect(names.some((name) => String(name).startsWith("advsec_"))).toBe(false);
    });

    it("keeps Advanced Security tools on Azure DevOps Services", () => {
      setServerContext(parseServerTarget("contoso"));
      const realServer = new McpServer({ name: "cloud-test", version: "1.0.0" });
      const tool = jest.spyOn(realServer, "tool");
      configureAllTools(realServer, tokenProvider, connectionProvider, userAgentProvider, new Set([Domain.ADVANCED_SECURITY]));

      expect(tool.mock.calls.map(([name]) => name)).toContain("advsec_get_alerts");
    });
  });
});
