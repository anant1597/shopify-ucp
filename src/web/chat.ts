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
import { buildConnectorServer, rememberDeliveryAddress } from "../connector/tools.ts";

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
- At the start of a shopping task, call get_my_profile once to know their name and phone.
- The website shows search results as product cards with image, price and store, so in your text give a short \
take (one or two picks and why) and don't list the other results: the cards show them.

Go through every check with the customer before they get a pay link, in this order:
1. Where to deliver, before any search: call get_delivery_addresses as soon as they say what they want to buy \
(together with get_my_profile). The website shows a picker card with their saved addresses, a pincode box and \
"Enter a new address", so just ask where it should go in one short line; don't list the addresses in your text \
and don't search yet. A picked address arrives as [Selected address_id: …]; if they give only a pincode ("Deliver \
to pincode 560008"), call set_delivery_pincode. If the profile already has a default address and they say "same \
as usual", use it. Knowing the pincode first means search shows only items in stock that ship there.
2. Product: search with search_products (the pincode is applied for you). Search results show only one example \
variant, and their options cover every store selling the item. If a product has customer_must_choose (for example \
Size and Color), never pick for the customer: ask them to choose each option and the quantity in one short \
question, listing the choices (sizes as a range like 5–14 if long). The product cards also let them pick options \
and quantity. Then call get_product_details with product_id, store and their choices in selected, and use the \
variant_id it returns. If that store has it sold out, it returns other_stores_in_stock: offer those stores (price \
and store) instead of saying it's unavailable, and if they pick one use its variant_id with that store. If it \
reports problems or still_to_choose, ask about just that. Ask the quantity if they haven't said it.
3. Full address: if they gave only a pincode, call get_delivery_addresses again now. It reads the address from \
their Shop account through that store and adds it to the picker card, so ask them to pick it or enter a new one. \
Only ask for details the profile doesn't have; if it has a phone, never ask for one.
4. Review: once product, options, quantity and address are settled, call prepare_checkout with the address_id. It \
builds the order on the store and checks delivery, but gives no pay link. The website shows it as a review card. \
If delivery.deliverable is false, tell them the store doesn't deliver there (quote delivery.reason) and offer \
another store or address. Otherwise sum it up in one or two lines (item with options and quantity, delivery \
address and option, total) and ask them to confirm. Their name, phone and email (shown on the card) are filled in \
on the store's page when they confirm. Mention anything the store flagged.
5. Pay link: only after the customer says yes in a new message, call confirm_checkout. The website then shows a \
payment card with a Pay button, so just say they can pay by card or UPI on the store's page with the Pay button. \
Don't paste the pay link. If they want changes, use update_checkout and show the summary again.

Also:
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
  | { type: "review"; review: any }
  | { type: "addresses"; addresses: any }
  | { type: "error"; message: string }
  | { type: "done"; conversation_id: string };

type DisplayItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "products"; products: any[] }
  | { role: "checkout"; checkout: any }
  | { role: "review"; review: any }
  | { role: "addresses"; addresses: any };

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
      product_id: p.product_id, title: p.title, store: p.store ?? v?.store, image: p.image, url: p.url,
      price_inr: p.price_range?.min?.inr ?? v?.price?.inr,
      price_varies: p.price_range?.max?.inr != null && p.price_range.max.inr !== p.price_range?.min?.inr,
      options: (p.options ?? []).filter((o: any) => o.values?.length > 1).slice(0, 4),
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

/** Order review (before the pay link): what the customer checks. */
function cardReview(data: any) {
  if (!data?.checkout_id || data.pay_url) return null;
  const d = data.delivery ?? {};
  return {
    checkout_id: data.checkout_id, store: data.store, items: data.items, total: data.total, breakdown: data.breakdown,
    delivery: { deliverable: d.deliverable ?? null, address: d.address ?? data.delivery_address ?? null, pincode: d.pincode ?? null, shipping: d.shipping, reason: d.reason },
    contact: data.contact ?? null,
    ready: data.ready_to_confirm ?? d.deliverable === true,
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
  context: { address_id?: string } = {},
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
  // A pick from the address card: tell the assistant which saved address (shown to the customer as plain text).
  const picked = context.address_id
    ? (db.prepare("SELECT id FROM addresses WHERE id = ? AND customer_id = ?").get(context.address_id, customerId) as any)?.id
    : null;
  if (picked) rememberDeliveryAddress(customerId, picked);
  messages.push({ role: "user", content: picked ? `${userText}\n\n[Selected address_id: ${picked}]` : userText });
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
  const reviewedNow = new Set<string>(); // reviews shown during this customer message
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
        if (t.name === "confirm_checkout" && reviewedNow.has((t.input as any)?.checkout_id)) {
          // The customer must see the review and answer before the pay link goes live.
          results.push({
            type: "tool_result", tool_use_id: t.id, is_error: true,
            content: "The customer hasn't seen this review yet. Show them the summary, ask them to confirm, and wait for their reply.",
          });
          emit({ type: "tool", name: t.name, status: "error" });
          continue;
        }
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
            if (t.name === "get_delivery_addresses" && data) {
              const addresses = {
                list: data.addresses ?? [],
                note: data.note ?? null,
                pincode: data.delivery_pincode ?? null,
                // Shopping can start with just a pincode; the full address is picked later.
                ask_pincode: true,
              };
              display.push({ role: "addresses", addresses });
              emit({ type: "addresses", addresses });
            }
            if (t.name === "prepare_checkout" || t.name === "update_checkout" || t.name === "confirm_checkout") {
              const merged = { store: (t.input as any)?.store, ...data };
              const checkout = merged.pay_url ? cardCheckout(merged) : null;
              const review = merged.pay_url ? null : cardReview(merged);
              if (checkout) {
                display.push({ role: "checkout", checkout });
                emit({ type: "checkout", checkout });
              } else if (review) {
                reviewedNow.add(review.checkout_id);
                display.push({ role: "review", review });
                emit({ type: "review", review });
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
