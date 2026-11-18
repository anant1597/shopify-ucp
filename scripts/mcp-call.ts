/**
 * Call one tool on our own /mcp endpoint, using the first partner key from .env.
 *   node --env-file=.env scripts/mcp-call.ts search_products '{"query":"shirt","store":"snitch.co.in"}'
 */
const [tool, json = "{}"] = process.argv.slice(2);
if (!tool) throw new Error("usage: mcp-call.ts <tool> '<json args>'");
const key = (process.env.PARTNER_API_KEYS ?? "").split(",")[0]?.split(":")[1];
const base = `http://localhost:${process.env.PORT ?? 3000}`;

const res = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key ?? "" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: JSON.parse(json) } }),
});
const body: any = await res.json();
const block = body.result?.content?.[0]?.text;
if (body.result?.isError) console.error("TOOL ERROR:", block);
else console.log(block ?? JSON.stringify(body, null, 2));
