// MCP server: lets Claude Code / Claude Desktop query the captured phone traffic.
// Register with:  claude mcp add phone-proxy -- node /absolute/path/to/phone-proxy/src/mcp.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openStore } from "./store.js";
import { trafficTools } from "./ai.js";

const store = openStore();
const tools = trafficTools(store);

// zod shapes mirroring the JSON schemas in ai.js
const shapes = {
  list_requests: {
    app: z.string().optional(), host: z.string().optional(), tag: z.string().optional(), method: z.string().optional(),
    statusMin: z.number().optional(), q: z.string().optional(), limit: z.number().optional(),
  },
  get_request: { id: z.string(), max_body: z.number().optional() },
  traffic_overview: { app: z.string().optional(), host: z.string().optional(), hideSystem: z.boolean().optional() },
  replay_request: {
    id: z.string(), method: z.string().optional(), url: z.string().optional(),
    headers: z.record(z.string()).optional(), body: z.string().optional(),
  },
  export_curl: { id: z.string() },
};

const mcp = new McpServer({ name: "phone-proxy", version: "0.1.0" });

for (const [name, tool] of Object.entries(tools)) {
  mcp.registerTool(name, { description: tool.description, inputSchema: shapes[name] }, async (args) => {
    try {
      const out = await tool.run(args);
      return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
    }
  });
}

mcp.registerTool("relabel_host", {
  description: "Assign a host to an app (fixes app attribution for all past and future requests to that host).",
  inputSchema: { host: z.string(), app: z.string() },
}, async ({ host, app }) => ({ content: [{ type: "text", text: `updated ${store.relabelHost(host, app)} requests` }] }));

await mcp.connect(new StdioServerTransport());
