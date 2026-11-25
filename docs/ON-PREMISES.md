# Azure DevOps Server (On-Premises)

The local MCP server can connect to **Azure DevOps Server** collections in addition to Azure DevOps Services. Pass the collection URL instead of an organization name and authenticate with a Personal Access Token (PAT) or Basic credentials.

- [Supported Releases](#supported-releases)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
- [Command-Line Options](#command-line-options)
- [REST API Version Negotiation](#rest-api-version-negotiation)
- [Feature Availability](#feature-availability)
- [Networking and Certificates](#networking-and-certificates)
- [Troubleshooting](#troubleshooting)

## Supported Releases

| Release                             | `--server-version` | Highest REST API version |
| ----------------------------------- | ------------------ | ------------------------ |
| Azure DevOps Server 2020 (Update 1) | `2020`             | 6.0                      |
| Azure DevOps Server 2022            | `2022`             | 7.0                      |
| Azure DevOps Server 2022.1          | `2022.1`           | 7.1                      |
| Azure DevOps Server 2022.2          | `2022.2`           | 7.1                      |
| Azure DevOps Server 26H2 (RC)       | `26h2`             | 7.2                      |

The default, `--server-version auto`, detects the release from the server, so you normally do not need to set it.

## Quick Start

1. Create a PAT in Azure DevOps Server: **User settings > Personal access tokens > New Token**. Grant the scopes that match the domains you want to use (for example _Work Items (Read & Write)_, _Code (Read)_, _Build (Read & Execute)_, _Wiki (Read & Write)_, _Test Management (Read & Write)_, _Project and Team (Read)_ and _Identity (Read)_).
2. Export the token as the base64 encoding of `<anything>:<pat>`:

   ```bash
   export PERSONAL_ACCESS_TOKEN="$(printf '%s' ':<pat>' | base64)"
   ```

   On Windows PowerShell:

   ```powershell
   $env:PERSONAL_ACCESS_TOKEN = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(":<pat>"))
   ```

3. Configure your MCP client with the collection URL. Example `.vscode/mcp.json` when running this repository from source (see [Run from Source](./GETTINGSTARTED.md#run-from-source)):

   ```json
   {
     "servers": {
       "ado-server": {
         "type": "stdio",
         "command": "node",
         "args": ["/path/to/azure-devops-mcp/dist/index.js", "https://tfs.contoso.com/tfs/DefaultCollection", "--authentication", "pat"]
       }
     }
   }
   ```

   The collection URL is the address you use in the browser up to and including the collection name, for example:
   - `https://tfs.contoso.com/tfs/DefaultCollection` (classic `/tfs` virtual directory)
   - `https://ado.contoso.com/DefaultCollection` (no virtual directory)
   - `http://tfs01:8080/tfs/DefaultCollection` (plain http, see [Networking](#networking-and-certificates))

4. Start the server and try a prompt such as `List ADO projects`.

When the first argument is a URL whose host is not `dev.azure.com` or `*.visualstudio.com`, the server runs in on-premises mode. Plain organization names and Azure DevOps Services URLs keep working exactly as before.

## Authentication

Azure DevOps Server does not accept Microsoft Entra ID tokens, so `interactive`, `azcli`, `env` and `envvar` are rejected in on-premises mode. Two methods are supported:

| Method                | Value   | Required setup                            |
| --------------------- | ------- | ----------------------------------------- |
| Personal Access Token | `pat`   | `PERSONAL_ACCESS_TOKEN` (default on-prem) |
| Basic (user/password) | `basic` | `ADO_MCP_USERNAME`, `ADO_MCP_PASSWORD`    |

### Personal Access Token (recommended)

`pat` is the default on-premises authentication type. `PERSONAL_ACCESS_TOKEN` must contain the base64 encoding of `<user>:<pat>`; the user part may be empty.

### Basic

Use `basic` when PATs are not available and IIS Basic authentication is enabled on the Azure DevOps Server application tier:

```bash
export ADO_MCP_USERNAME='CONTOSO\jdoe'
export ADO_MCP_PASSWORD='<password>'
```

```json
"args": ["/path/to/azure-devops-mcp/dist/index.js", "https://tfs.contoso.com/tfs/DefaultCollection", "--authentication", "basic"]
```

> [!IMPORTANT]
> Basic authentication sends the account password with every request. Only use it over https, and prefer PATs whenever possible. Never commit credentials to an MCP configuration file.

Windows Integrated Authentication (NTLM/Kerberos) is not supported.

### Credential safety

Credentials are only sent to the configured collection origin (scheme, host and port must match) and to hosts you explicitly trust with `--trusted-host`. Requests that would send the credential anywhere else are refused.

## Command-Line Options

| Option                  | Description                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<collection-url>`      | Collection URL, e.g. `https://tfs.contoso.com/tfs/DefaultCollection`.                                                                                                                           |
| `-a, --authentication`  | `pat` (default) or `basic`.                                                                                                                                                                     |
| `--server-version`      | `auto` (default), `2020`, `2022`, `2022.1`, `2022.2` or `26h2`. Set it explicitly if auto-detection is blocked (for example by a proxy that rejects `OPTIONS` requests).                        |
| `--trusted-host <host>` | Additional host names that may receive credentials. Use it when the server's _Public URL_ (used in artifact download links and REST responses) differs from the URL you configured. Repeatable. |
| `-d, --domains`         | Same as for Azure DevOps Services. `advanced-security` is skipped automatically on-premises.                                                                                                    |
| `-t, --tenant`          | Ignored on-premises.                                                                                                                                                                            |

## REST API Version Negotiation

Older servers reject requests whose `api-version` is newer than they support (`The requested REST API version of 7.1 is out of range for this server`). The server handles this automatically:

- Calls made through the `azure-devops-node-api` clients negotiate their version with the server's resource locations.
- Direct REST calls (search, identities, wiki pages, work item comments, test plans, build stages, organization-level pull requests) use the same negotiation: the server reads the resource location (`OPTIONS {collection}/_apis/{area}`) and picks the highest version both sides support.
- If a location cannot be read, the requested version is lowered to the release ceiling from `--server-version` (or the detected release). If detection also fails, Azure DevOps Server 2020 (REST 6.0) is assumed and a warning is logged.

Azure DevOps Services is unaffected: no extra requests are made and the same versions as before are used.

## Feature Availability

| Area                         | 2020.1 | 2022.x | 26H2 | Notes                                                                                                    |
| ---------------------------- | :----: | :----: | :--: | -------------------------------------------------------------------------------------------------------- |
| Core, Work, Work Items       |   ✅   |   ✅   |  ✅  |                                                                                                          |
| Repositories, Pull Requests  |   ✅   |   ✅   |  ✅  |                                                                                                          |
| Pipelines (builds/artifacts) |   ✅   |   ✅   |  ✅  | Use `--trusted-host` if artifact links use a different host name.                                        |
| Wiki                         |   ✅   |   ✅   |  ✅  | Wiki page URLs must belong to the configured collection.                                                 |
| Test Plans                   |   ✅   |   ✅   |  ✅  |                                                                                                          |
| Search (code/wiki/work item) |   ⚠️   |   ⚠️   |  ⚠️  | Requires the Search extension to be installed and configured for the collection.                         |
| Commit search                |   ⚠️   |   ⚠️   |  ⚠️  | Depends on the Search extension version; may not be available.                                           |
| Markdown work item comments  |   ❌   |   ⚠️   |  ✅  | When unsupported, Markdown comments are stored as HTML (line breaks preserved) and the response says so. |
| Advanced Security            |   ❌   |   ❌   |  ❌  | Azure DevOps Services only; the domain is not registered on-premises.                                    |

## Networking and Certificates

- **Plain http**: collection URLs with `http://` are accepted. A warning is logged because credentials are sent unencrypted. Credentials are never sent over http to any other host.
- **Internal certificate authorities**: if the server uses a certificate issued by an internal CA, point Node.js to the CA bundle instead of disabling TLS validation:

  ```bash
  export NODE_EXTRA_CA_CERTS=/path/to/contoso-root-ca.pem
  ```

- **Proxies**: make sure `OPTIONS` requests to `{collection}/_apis/*` are allowed (used for version negotiation), or set `--server-version` explicitly.

## Troubleshooting

| Symptom                                                                       | Fix                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Authentication type 'interactive' is not supported with Azure DevOps Server` | Use `--authentication pat` or `--authentication basic`.                                                                      |
| `401 Unauthorized`                                                            | Check that `PERSONAL_ACCESS_TOKEN` is base64 of `<user>:<pat>`, the PAT is not expired and has the required scopes.          |
| `The Azure DevOps Server URL ... must include the collection`                 | Add the collection to the URL, e.g. `/tfs/DefaultCollection`.                                                                |
| `Refusing to send a Personal Access Token to untrusted destination`           | The server returned a link to another host (often its Public URL). Add that host with `--trusted-host` if it is your server. |
| `REST API version ... is out of range`                                        | Set `--server-version` to your release and report the tool name as an issue.                                                 |
| `unable to verify the first certificate` / `self-signed certificate`          | Set `NODE_EXTRA_CA_CERTS` to your CA bundle.                                                                                 |
| Search tools return 404                                                       | Install and configure the Search extension for the collection.                                                               |
