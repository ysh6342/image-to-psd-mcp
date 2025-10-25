# image-to-psd-mcp

Model Context Protocol (MCP) server that turns Universal Mesh Generator (UMG) layout JSON into layered PSD files. The server exposes the existing UMG-to-PSD pipeline so Codex (or any MCP-aware client) can request placeholder assets to be generated on demand.

## Prerequisites
- Node.js 18+
- npm
- Codex CLI ([Model Context Protocol docs](https://developers.openai.com/codex/mcp/))

Install dependencies once:

```bash
npm install
```

## Local Development
- `npm run dev` launches the server in a watch-friendly development mode.
- `npm run start` launches the MCP server mode directly (same command Codex will run).
- `npm run test` currently prints "no tests defined".

## Register the MCP server with Codex
Run the Codex CLI from the project root:

```bash
codex mcp add image-to-psd-mcp node mcp-server.js --mode mcp
```

The command above mirrors the instructions from the official MCP guide and updates `~/.codex/config.toml` to include:

```toml
[mcp_servers.image-to-psd-mcp]
command = "node"
args = ["mcp-server.js", "--mode", "mcp"]
```

If you prefer to edit the configuration manually, follow the same structure documented in the MCP guide: add the table under the `[mcp_servers]` section, set `command` to the executable, and use `args` to pass the server entry point and `--mode mcp` flag. You can also add optional keys like `env` or `timeout` exactly as described in the [official documentation](https://developers.openai.com/codex/mcp/).

After updating the config, Codex can discover the server automatically. From Codex TUI you can verify the server from `Settings -> MCP Servers` or by running:

```bash
codex mcp list
```

## Troubleshooting
- Ensure `canvas` has its native dependencies installed for your platform.
- If Codex cannot launch the server, double-check the path to `mcp-server.js` inside `config.toml` (absolute paths are also supported).
- Use `npm run dev` to validate the pipeline locally before exposing it through MCP.
