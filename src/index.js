#!/usr/bin/env node
// MCP server for Business Central XLIFF translation files.
//
// Talks MCP (newline-delimited JSON) on stdio. All logging goes to stderr --
// stdout is the MCP channel and must not be polluted.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS } from './tools.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

const VERBOSE = process.env.XLF_MCP_VERBOSE === '1';

function log(message) {
  if (VERBOSE) process.stderr.write(`[xlf-mcp] ${message}\n`);
}

const byName = new Map(TOOLS.map((t) => [t.name, t]));

const server = new Server(
  { name: 'xlf', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name, description, inputSchema, ...(annotations ? { annotations } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const tool = byName.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const started = Date.now();
  try {
    const result = await tool.handler(args);
    log(`${name} ok in ${Date.now() - started}ms`);
    return { content: [{ type: 'text', text: result.text }] };
  } catch (err) {
    log(`${name} failed in ${Date.now() - started}ms: ${err.message}`);
    return { content: [{ type: 'text', text: `${name} failed: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
log('ready');
