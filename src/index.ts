#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBasicHandler, getBearerHandler, getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";
import yargs from "yargs";

import { AUTHENTICATION_TYPES, createAuthenticator, decodeBasicCredential, installBasicAuthFetchInterceptor, isBasicCredentialAuthType, validateAuthenticationForDeployment } from "./auth.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { getCliArgs } from "./utils.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";
import { parseServerTarget, ServerTarget, setServerContext } from "./server-context.js";
import { configureServerVersion, parseServerVersionChoice, SERVER_VERSION_CHOICES, SERVER_VERSION_PROFILES, ServerVersionChoice } from "./server-version.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

// Parse command line arguments using yargs
const argv = yargs(getCliArgs())
  .scriptName("mcp-server-azuredevops")
  .usage("Usage: $0 <organization | collection-url> [options]")
  .version(packageVersion)
  .command("$0 <organization> [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps Services organization name (e.g. 'contoso'), or the collection URL of an Azure DevOps Server (e.g. 'https://tfs.contoso.com/tfs/DefaultCollection')",
      type: "string",
      demandOption: true,
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: `Type of authentication to use. Defaults to '${defaultAuthenticationType}' for Azure DevOps Services and 'pat' for Azure DevOps Server ('pat' and 'basic' are supported on-premises).`,
    type: "string",
    choices: [...AUTHENTICATION_TYPES],
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
  .option("server-version", {
    describe: "Azure DevOps Server release (on-premises only). 'auto' detects it from the server. Used to pick compatible REST API versions.",
    type: "string",
    choices: SERVER_VERSION_CHOICES,
    default: "auto",
  })
  .option("trusted-host", {
    describe: "Additional host name(s) of an Azure DevOps Server that may receive credentials, e.g. the server's public URL when it differs from the collection URL (on-premises only).",
    type: "string",
    array: true,
  })
  .help()
  .parseSync();

function exitWithConfigurationError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Invalid configuration: ${message}`);
  console.error(`mcp-server-azuredevops: ${message}`);
  process.exit(1);
}

let serverTarget: ServerTarget;
let serverVersionChoice: ServerVersionChoice;
try {
  serverTarget = parseServerTarget(argv.organization as string);
  serverVersionChoice = parseServerVersionChoice(argv["server-version"] as string | undefined);
} catch (error) {
  exitWithConfigurationError(error);
}
const serverContext = setServerContext(serverTarget, argv["trusted-host"] as string[] | undefined);
configureServerVersion(serverVersionChoice);

const authenticationType = (argv.authentication as string | undefined) ?? (serverTarget.kind === "onprem" ? "pat" : defaultAuthenticationType);

export const orgName = serverTarget.orgName;
const orgUrl = serverTarget.orgUrl;

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string): () => Promise<WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    let authHandler;
    if (isBasicCredentialAuthType(authType)) {
      // For pat/basic, accessToken is base64("{user}:{secret}").
      const { username, secret } = decodeBasicCredential(accessToken);
      // getPersonalAccessTokenHandler prepends ":" internally and just needs the raw token.
      authHandler = authType === "pat" ? getPersonalAccessTokenHandler(secret) : getBasicHandler(username, secret);
    } else {
      authHandler = getBearerHandler(accessToken);
    }
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function main() {
  validateAuthenticationForDeployment(authenticationType, serverTarget.kind);

  if (serverTarget.insecureHttp) {
    logger.warn(`The Azure DevOps Server collection URL '${orgUrl}' uses plain http. Credentials will be sent unencrypted; use https whenever possible.`);
  }

  logger.info("Starting Azure DevOps MCP Server", {
    organization: orgName,
    organizationUrl: orgUrl,
    deploymentType: serverTarget.kind === "onprem" ? "Azure DevOps Server" : "Azure DevOps Services",
    serverVersion: serverTarget.kind === "onprem" ? (serverVersionChoice === "auto" ? "auto" : SERVER_VERSION_PROFILES[serverVersionChoice].displayName) : undefined,
    trustedHosts: serverContext.trustedHosts.length > 0 ? serverContext.trustedHosts : undefined,
    authentication: authenticationType,
    tenant: argv.tenant,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    version: packageVersion,
    isCodespace: isGitHubCodespaceEnv(),
  });

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [
      {
        src: "https://cdn.vsassets.io/content/icons/favicon.ico",
      },
    ],
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };
  let tenantId: string | undefined;
  if (serverTarget.kind === "cloud") {
    tenantId = argv.tenant ?? (await getOrgTenant(orgName));
  } else if (argv.tenant) {
    logger.debug("Ignoring --tenant: tenants do not apply to Azure DevOps Server");
  }
  const authenticator = createAuthenticator(authenticationType, tenantId);

  if (isBasicCredentialAuthType(authenticationType)) {
    const basicValue = await authenticator();
    installBasicAuthFetchInterceptor(basicValue);
    logger.debug(`${authenticationType} mode: global fetch interceptor installed to rewrite Bearer -> Basic auth headers`);
  }

  // removing prompts until further notice
  // configurePrompts(server);

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer, authenticationType), () => userAgentComposer.userAgent, enabledDomains);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
