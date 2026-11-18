/**
 * Website chat: Claude (Messages API, streaming manual tool loop) driving the same customer-bound tools
 * as the Claude connector, called in-process over an in-memory MCP link.
 *
 * Conversations are stored server-side and appended to, never edited (Claude Opus 5.5 checks that replayed
 * thinking blocks belong to an unedited history).
 */
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import { db, now } from "../db.ts";
import { buildConnectorServer } from "../connector/tools.ts";

// Model and daily budget come from .env. Haiku 5.5 is the cheap default for testing; use claude-opus-5-5 for
// the most capable assistant.
const MODEL = process.env.CHAT_MODEL?.trim() || "claude-haiku-5-5";
const DAILY_BUDGET_USD = Number(process.env.CHAT_DAILY_BUDGET_USD ?? "1");
// USD per million tokens: [input, output]. Cache writes bill 1.25x input, cache reads 0.1x input.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5], // prompts up to 100K tokens; 0.50 / 2.50 beyond
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
// Only these models accept the server-side refusal fallback (Haiku has none).
const HAS_FALLBACK = /^claude-(opus|sonnet|fable)-/.test(MODEL);
const MAX_TOOL_ROUNDS = 12;
const MAX_HISTORY_CHARS = 600_000; // past this, ask the customer to start a new chat

const SYSTEM = `You are a shopping assistant on a website for customers in India. You help them find products on \
Shopify stores that deliver in India and get a payment link. You never buy or pay: the customer pays on the \
store's own checkout page.

How to work:
- At the start of a shopping task, call get_my_profile once to know their name, phone and saved addresses.
- Search with search_products. The website shows the results as product cards with image, price and store, so \
in your text give a short take (one or two picks and why) instead of re-listing every result.
- Before prepare_checkout, confirm in one short message: the product and variant (size/colour/pack), quantity, \
store, and delivery address. If they have no saved address, ask for it (line 1, city, state in full, 6-digit \
pincode) and save it with add_address. Stores need a 10-digit mobile number; ask for it if the profile has none.
- After prepare_checkout the website shows a payment card with the total and a Pay button, so just say the \
total and that they can pay with card or UPI on the store's page. Mention anything the store flagged.
- Avoid cash-on-delivery shipping options: on many Indian stores they remove card and UPI payment.
- For order status use get_order (orders placed here) or list_my_orders / get_my_order (any Shopify store, needs \
order tracking turned on). Shop's order status can lag the store; say so if a customer reports a change you \
don't see.
- Cancelling a paid order isn't possible through these tools: use get_cancellation_options and share the store's \
policy and order page. Never promise a cancellation or refund.
- Prices are in rupees; write them as ₹1,299. Keep replies short and friendly: this is a chat on a phone.`;

// API key from ANTHROPIC_API_KEY. The base URL is pinned so a shell-level ANTHROPIC_BASE_URL (set by some dev
// tools) doesn't silently reroute customer conversations; override with CLAUDE_API_BASE_URL if you need a proxy.
const client = new Anthropic({ baseURL: process.env.CLAUDE_API_BASE_URL || "https://api.anthropic.com" });

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error" }
  | { type: "products"; products: any[] }
  | { type: "checkout"; checkout: any }
  | { type: "error"; message: string }
  | { type: "done"; conversation_id: string };

type DisplayItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "products"; products: any[] }
  | { role: "checkout"; checkout: any };

const busy = new Set<string>();

const today = () => new Date().toISOString().slice(0, 10);

function spentToday(): number {
  const row = db.prepare("SELECT usd FROM chat_usage WHERE day = ?").get(today()) as any;
  return row?.usd ?? 0;
}

/** Cost of one response from its usage block (conservative: Haiku's >100K-token rate when the prompt is that long). */
function recordUsage(model: string, u: any) {
  let [inP, outP] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  if (model.startsWith("claude-haiku-5-5") && promptTokens > 100_000) [inP, outP] = [0.5, 2.5];
  const usd =
    ((u.input_tokens ?? 0) * inP + (u.cache_creation_input_tokens ?? 0) * inP * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inP * 0.1 + (u.output_tokens ?? 0) * outP) / 1e6;
  db.prepare(
    `INSERT INTO chat_usage (day, usd, requests) VALUES (?, ?, 1)
     ON CONFLICT(day) DO UPDATE SET usd = usd + excluded.usd, requests = requests + 1`,
  ).run(today(), usd);
}

export function getConversation(customerId: string, id: string) {
  const row = db.prepare("SELECT id, display_json FROM web_conversations WHERE id = ? AND customer_id = ?").get(id, customerId) as any;
  return row ? { id: row.id as string, display: JSON.parse(row.display_json) as DisplayItem[] } : null;
}

/** Product fields the cards need (keeps the stored display log small). */
function cardProducts(data: any) {
  return (data?.products ?? []).slice(0, 10).map((p: any) => {
    const v = (p.variants ?? []).find((x: any) => x.available !== false) ?? p.variants?.[0];
    return {
      title: p.title, store: p.store ?? v?.store, image: p.image, url: p.url,
      price_inr: v?.price?.inr ?? p.price_range?.min?.inr, variants: (p.variants ?? []).length,
    };
  });
}

function cardCheckout(data: any) {
  if (!data?.pay_url) return null;
  return {
    checkout_id: data.checkout_id, pay_url: data.pay_url, status: data.status, store: data.store,
    total: data.total, breakdown: data.breakdown, items: data.items, expires_at: data.expires_at,
  };
}

async function connectTools(customerId: string) {
  const server = buildConnectorServer(customerId);
  const mcp = new Client({ name: "web-chat", version: "0.1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await mcp.connect(b);
  const { tools } = await mcp.listTools();
  const defs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? t.title ?? t.name,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
  return { mcp, defs, close: async () => { await mcp.close(); await server.close(); } };
}

export async function runChat(
  customerId: string,
  conversationId: string | null,
  userText: string,
  emit: (e: ChatEvent) => void,
) {
  let row = conversationId
    ? (db.prepare("SELECT * FROM web_conversations WHERE id = ? AND customer_id = ?").get(conversationId, customerId) as any)
    : null;
  if (!row) {
    row = { id: randomUUID(), messages_json: "[]", display_json: "[]", created: true };
  }
  const id: string = row.id;
  if (!process.env.ANTHROPIC_API_KEY) {
    return emit({ type: "error", message: "The assistant isn't set up yet: the Claude API key is missing." });
  }
  if (DAILY_BUDGET_USD > 0 && spentToday() >= DAILY_BUDGET_USD) {
    return emit({ type: "error", message: "The assistant has reached today's usage limit. Please try again tomorrow." });
  }
  if (busy.has(id)) return emit({ type: "error", message: "Still working on your last message." });
  if (row.messages_json.length > MAX_HISTORY_CHARS) {
    return emit({ type: "error", message: "This chat is getting long. Start a new chat to continue." });
  }
  busy.add(id);

  const messages: Anthropic.Beta.BetaMessageParam[] = JSON.parse(row.messages_json);
  const display: DisplayItem[] = JSON.parse(row.display_json);
  messages.push({ role: "user", content: userText });
  display.push({ role: "user", text: userText });

  const save = () => {
    db.prepare(
      `INSERT INTO web_conversations (id, customer_id, messages_json, display_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET messages_json = excluded.messages_json, display_json = excluded.display_json,
         updated_at = excluded.updated_at`,
    ).run(id, customerId, JSON.stringify(messages), JSON.stringify(display), now(), now());
  };

  const tools = await connectTools(customerId);
  try {
    let jsonRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (round > 0 && DAILY_BUDGET_USD > 0 && spentToday() >= DAILY_BUDGET_USD) {
        emit({ type: "error", message: "The assistant reached today's usage limit mid-reply. Please try again tomorrow." });
        break;
      }
      let turnText = "";
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        tools: tools.defs,
        messages,
        cache_control: { type: "ephemeral" },
        output_config: { effort: "medium" },
        // On a safety decline, the API re-runs the turn on a suitable fallback model (not available on Haiku).
        ...(HAS_FALLBACK ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      stream.on("text", (delta) => {
        turnText += delta;
        emit({ type: "text", delta });
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
        recordUsage(message.model ?? MODEL, message.usage);
      } catch (err) {
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue; // a tool input that wasn't parseable JSON: re-issue the turn
      }

      if (turnText.trim()) display.push({ role: "assistant", text: turnText });
      if (message.stop_reason === "refusal") {
        messages.push({ role: "assistant", content: message.content });
        if (!turnText.trim()) {
          const sorry = "Sorry, I can't help with that one.";
          display.push({ role: "assistant", text: sorry });
          emit({ type: "text", delta: sorry });
        }
        break;
      }
      messages.push({ role: "assistant", content: message.content });
      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!toolUses.length) break; // end_turn (or a plain-text max_tokens)
      if (message.stop_reason === "max_tokens") {
        // A tool input cut off mid-way must not run; answer every tool_use so the history stays valid.
        messages.push({
          role: "user",
          content: toolUses.map((t) => ({ type: "tool_result" as const, tool_use_id: t.id, is_error: true, content: "Input was cut off; try again with a shorter request." })),
        });
        continue;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of toolUses) {
        emit({ type: "tool", name: t.name, status: "start" });
        try {
          // The MCP server validates the input against the tool's schema before running it.
          const r: any = await tools.mcp.callTool({ name: t.name, arguments: (t.input ?? {}) as Record<string, unknown> });
          const text = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
          results.push({ type: "tool_result", tool_use_id: t.id, content: text || "(no output)", ...(r.isError ? { is_error: true } : {}) });
          emit({ type: "tool", name: t.name, status: r.isError ? "error" : "done" });
          if (!r.isError) {
            let data: any = null;
            try { data = JSON.parse(text); } catch { /* not JSON */ }
            if (t.name === "search_products") {
              const products = cardProducts(data);
              if (products.length) {
                display.push({ role: "products", products });
                emit({ type: "products", products });
              }
            }
            if (t.name === "prepare_checkout" || t.name === "update_checkout") {
              const checkout = cardCheckout({ store: (t.input as any)?.store, ...data });
              if (checkout) {
                display.push({ role: "checkout", checkout });
                emit({ type: "checkout", checkout });
              }
            }
          }
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: `Error: ${(e as Error).message}` });
          emit({ type: "tool", name: t.name, status: "error" });
        }
      }
      messages.push({ role: "user", content: results }); // all results of a turn in one message
    }
    save();
    emit({ type: "done", conversation_id: id });
  } catch (e) {
    // Keep the stored history valid: every tool_use needs a tool_result in the next message.
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const pending = (last.content as any[]).filter((b) => b.type === "tool_use");
      if (pending.length) {
        messages.push({
          role: "user",
          content: pending.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "Interrupted by an error." })),
        });
      }
    }
    save();
    const msg =
      e instanceof Anthropic.AuthenticationError ? "The assistant isn't configured yet (missing Claude API key)."
      : e instanceof Anthropic.RateLimitError ? "Too many requests right now. Try again in a minute."
      : e instanceof Anthropic.APIError ? `The assistant hit an error (${e.status}). Try again.`
      : `Something went wrong: ${(e as Error).message}`;
    console.error("[chat]", e);
    emit({ type: "error", message: msg });
    emit({ type: "done", conversation_id: id });
  } finally {
    busy.delete(id);
    await tools.close();
  }
}
