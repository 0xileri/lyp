#!/usr/bin/env node
/**
 * Print the tools a configured Agent OS endpoint exposes, split into the ones
 * this service may call and the ones it refuses on sight.
 *
 * This is step 2 of wiring the live connection: run it once, then map the
 * names it prints onto the AGENT_OS_TOOL_* environment variables.
 *
 *   AGENT_OS_MCP_URL=... AGENT_OS_TOKEN=... npm run audit:tools
 */
import { AgentOsClient } from "../src/agentos/client.js";

const client = new AgentOsClient({
  url: process.env.AGENT_OS_MCP_URL,
  token: process.env.AGENT_OS_TOKEN,
});

try {
  const { readable, refused, wired } = await client.auditTools();
  console.log(`\n  readable (${readable.length})`);
  for (const n of readable.sort()) console.log(`    ${wired.includes(n) ? "*" : " "} ${n}`);
  console.log(`\n  refused as exchange-mutating (${refused.length})`);
  for (const n of refused.sort()) console.log(`      ${n}`);
  console.log(`\n  * = currently wired. Unwired reads are available but unused.`);
  const missing = wired.filter((n) => !readable.includes(n));
  if (missing.length > 0) {
    console.log(`\n  NOT FOUND on this endpoint: ${missing.join(", ")}`);
    console.log(`  Set the matching AGENT_OS_TOOL_* variables to the real names above.`);
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
