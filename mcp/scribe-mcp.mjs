#!/usr/bin/env node
/**
 * Clarity Scribe MCP server (stdio) — makes the app a tool provider for AI
 * agents. Any MCP host (Claude Desktop, Claude Code, the Claude Agent SDK,
 * Windows agent connectors, …) can spawn this script and call Scribe's
 * dictation capabilities as tools.
 *
 * It is a thin bridge over the app's loopback Local API: enable "Local API"
 * in Scribe's Settings (and restart the app) first. The bridge auto-discovers
 * the port + bearer token from Scribe's config file; SCRIBE_API_TOKEN /
 * SCRIBE_API_PORT env vars override.
 *
 * Claude Desktop config example (claude_desktop_config.json):
 *   "mcpServers": {
 *     "clarity-scribe": {
 *       "command": "node",
 *       "args": ["<path-to>/clarity-scribe/mcp/scribe-mcp.mjs"]
 *     }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ScribeApi, discoverConfig } from './scribeApi.mjs';

const cfg = discoverConfig();
if (!cfg.token) {
    console.error('[scribe-mcp] No Local API token found. Enable "Local API" in Clarity Scribe settings, restart the app, then retry (or set SCRIBE_API_TOKEN / SCRIBE_API_PORT).');
    process.exit(1);
}
const api = new ScribeApi(cfg);

const server = new McpServer({ name: 'clarity-scribe', version: '3.3.0' });

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errText = (e) => ({ content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true });

server.registerTool('dictate', {
    title: 'Dictate (speak → text)',
    description: 'Start voice dictation on the user\'s microphone and wait until they finish speaking (they stop via hotkey, or silence auto-stop). Returns the final transcript. Use this when you want the user to SPEAK their input instead of typing.',
    inputSchema: { timeout_seconds: z.number().min(5).max(600).default(120).describe('Max seconds to wait for the user to finish') },
}, async ({ timeout_seconds }) => {
    try {
        const transcript = await api.dictate((timeout_seconds ?? 120) * 1000);
        return text(transcript || '(empty transcription)');
    } catch (e) { return errText(e); }
});

server.registerTool('start_dictation', {
    title: 'Start dictation',
    description: 'Start recording the user\'s voice. Use stop_dictation to end it; the transcript is delivered to whatever app the user is in (and to get_recent_transcripts).',
    inputSchema: {},
}, async () => {
    try { await api.startRecording(); return text('Recording started.'); }
    catch (e) { return e.status === 409 ? text('Already recording.') : errText(e); }
});

server.registerTool('stop_dictation', {
    title: 'Stop dictation',
    description: 'Stop the current recording; transcription of what was said begins immediately.',
    inputSchema: {},
}, async () => {
    try { await api.stopRecording(); return text('Recording stopped; transcribing.'); }
    catch (e) { return e.status === 409 ? text('Was not recording.') : errText(e); }
});

server.registerTool('get_status', {
    title: 'Get Scribe status',
    description: 'Whether Clarity Scribe is currently recording, which engine is active, and the app version.',
    inputSchema: {},
}, async () => {
    try { return text(JSON.stringify(await api.status())); }
    catch (e) { return errText(e); }
});

server.registerTool('get_recent_transcripts', {
    title: 'Get recent transcripts',
    description: 'The user\'s most recent dictation transcripts, newest first.',
    inputSchema: { limit: z.number().min(1).max(50).default(5).describe('How many entries') },
}, async ({ limit }) => {
    try {
        const { entries } = await api.history(limit ?? 5);
        const lines = (entries || []).map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.text}`);
        return text(lines.join('\n') || '(no history)');
    } catch (e) { return errText(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[scribe-mcp] connected — bridging to 127.0.0.1:${cfg.port}`);
