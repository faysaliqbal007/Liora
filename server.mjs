import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();

// Reads AssemblyAI API key from .env or environment variable
async function getApiKey() {
  const envText = await readFile(join(root, ".env"), "utf8").catch(() => "");
  const line = envText.split(/\r?\n/).find(value => value.startsWith("ASSEMBLYAI_API_KEY="));
  return line?.slice("ASSEMBLYAI_API_KEY=".length).trim().replace(/^['"]|['"]$/g, "") || process.env.ASSEMBLYAI_API_KEY;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

const allowedStaticExts = new Set(Object.keys(mimeTypes));

// Modern security headers added to all HTTP responses
function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-xss-protection": "1; mode=block"
  });
  res.end(body);
}

// In-memory sliding window rate limiter to protect AI endpoints from abuse
const rateLimitMap = new Map();
function checkRateLimit(ip, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);
  if (!record || now - record.resetTime > windowMs) {
    record = { count: 1, resetTime: now };
    rateLimitMap.set(ip, record);
    return true;
  }
  if (record.count >= limit) {
    return false;
  }
  record.count++;
  if (rateLimitMap.size > 5_000) {
    for (const [key, val] of rateLimitMap) {
      if (now - val.resetTime > windowMs) rateLimitMap.delete(key);
    }
  }
  return true;
}

async function readJson(req, maxBytes = 200_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return JSON.parse(raw || "{}");
}

const chatSchema = {
  type: "json_schema",
  json_schema: {
    name: "liora_response",
    strict: true,
    schema: {
      type: "object",
      properties: {
        assistant_reply: { type: "string" },
        action: { type: "string", enum: ["none", "stored", "packed", "lent", "borrowed", "received", "returned", "deleted"] },
        item: { type: "string" },
        detail: { type: "string" },
        due_date: { type: "string" }
      },
      required: ["assistant_reply", "action", "item", "detail", "due_date"],
      additionalProperties: false
    }
  }
};

const chatSystemPrompt = `You are Liora, a polished conversational assistant for remembering physical belongings. Reply naturally, concisely, and warmly. You can answer greetings and conversational questions, but maintain focus on keeping track of belongings.

Important Identity & Creator Knowledge:
- Creator & Developer: You were created and developed by Faysal Iqbal.
- If someone asks who made or created you (e.g. "Who made you?", "Who is your creator?", "Who developed you?"), you MUST ALWAYS answer: "Faysal Iqbal".
- NEVER say you were made or developed by Google, OpenAI, or anyone else. Your only creator and developer is Faysal Iqbal.
- About Faysal Iqbal / Creator ("tell me about him"): If anyone asks "who is Faysal Iqbal", "tell me about him", "tellme about him", "about him", or "who is he", reply: "Faysal Iqbal is a Computer Science and Engineering student at Ahsanullah University of Science and Technology, passionate about cybersecurity, AI/ML, programming, and robotics. He enjoys building projects, exploring technology, and continuously learning. Outside tech, he loves music, gaming, fitness, gardening, and meaningful conversations."
- About the User ("tell me about me"): If the user asks "tell me about me" or "who am I", answer about the user: "You are the user of Liora! I'm here to track all your physical belongings, packed items, and loans. You can ask me where any of your items are or what's currently tracked."

Single-Item Deletion Rules:
- The chatbot CANNOT delete all items at once. You can ONLY delete items one by one.
- If the user asks to delete all items, remove all items, delete everything, or clear all records (e.g. "delete all", "delete all items", "remove everything"), you MUST refuse and reply: "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?" Set action to "none".
- Only set action to "deleted" when the user specifies a single, individual item to remove.

The user's current saved records are provided below. Treat them as the single source of truth. Never make up a location, person, or due date.

When answering a question, reference existing records and set action to "none". When the user asks to save, move, pack, lend, borrow, return, or delete a single item, return the appropriate action:
- stored: item is placed at a specific location
- packed: item is packed inside a bag, box, or container
- lent: item is lent to someone
- borrowed: item is borrowed from someone
- received: a lent item was returned to the user (ask where they stored it)
- returned: a borrowed item was given back to its owner
- deleted: user wants to remove a single item (only one at a time)

Actions require on-screen confirmation from the user before being saved, so state that you prepared it for review. Return only the required structured JSON response.`;

function fallbackParse(text, items) {
  const norm = str => String(str || "").trim().toLowerCase().replace(/[?.!]$/g, "");
  const lower = norm(text);

  // 1a. Bulk delete prevention (Chatbot cannot delete all items at once)
  if (
    /^(?:delete|remove|clear|forget|wipe|erase) (?:all|everything|all items|all my items|all the items|every item)$/i.test(lower) ||
    /^(?:can you |please )?(?:delete|remove|clear|wipe) (?:all|everything|all items|all my items|all the items)/i.test(lower) ||
    /(?:delete|remove|clear) all items at once/i.test(lower) ||
    /delete (?:all|everything)/i.test(lower)
  ) {
    return {
      assistant_reply: "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 1b. Single item delete / remove commands
  let match = lower.match(/^(?:delete|remove|forget) (?:my )?(.+)$/);
  if (match) {
    const target = match[1].trim();
    if (/^(?:all|everything|all items|all my items|all the items|every item)$/i.test(target)) {
      return {
        assistant_reply: "I can only delete items one by one to keep your records safe. Which specific item would you like to remove?",
        action: "none",
        item: "",
        detail: "",
        due_date: ""
      };
    }
    return {
      assistant_reply: `I've prepared a confirmation to remove ${target}. Please confirm on screen.`,
      action: "deleted",
      item: target,
      detail: "",
      due_date: ""
    };
  }

  // 2. Where is my item / find query
  match = lower.match(/^(?:where (?:is|are)|where did i (?:put|keep)) (?:my )?(.+)$/);
  if (match) {
    const query = norm(match[1]);
    const found = items.find(i => norm(i.name) === query || norm(i.name).includes(query));
    if (found) {
      const prefix = found.status === "stored" ? "in" : found.status === "packed" ? "packed in" : found.status === "lent" ? "with" : "borrowed from";
      return {
        assistant_reply: `Your ${found.name} is ${prefix} ${found.detail}.`,
        action: "none",
        item: found.name,
        detail: found.detail,
        due_date: found.due_date || ""
      };
    }
    return {
      assistant_reply: `I don't have a record for ${match[1]}. Would you like me to remember where you put it?`,
      action: "none",
      item: match[1].trim(),
      detail: "",
      due_date: ""
    };
  }

  // 3. Who has my item
  match = lower.match(/^who has (?:my )?(.+)$/);
  if (match) {
    const query = norm(match[1]);
    const found = items.find(i => norm(i.name) === query || norm(i.name).includes(query));
    if (found?.status === "lent") {
      return {
        assistant_reply: `${found.detail} has your ${found.name}.`,
        action: "none",
        item: found.name,
        detail: found.detail,
        due_date: found.due_date || ""
      };
    }
    return {
      assistant_reply: found ? `Your ${found.name} is not marked as lent.` : `I don't have a record for ${match[1]}.`,
      action: "none",
      item: match[1].trim(),
      detail: "",
      due_date: ""
    };
  }

  // 4. Lent queries
  if (/what (?:did i|have i) lend|what is lent|what's lent/.test(lower)) {
    const lentItems = items.filter(i => i.status === "lent");
    return {
      assistant_reply: lentItems.length ? `You lent ${lentItems.map(i => `${i.name} to ${i.detail}`).join(", ")}.` : "You don't have any items currently marked as lent.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 5. Borrowed queries
  if (/what (?:did i|have i) borrow|what is borrowed|what's borrowed/.test(lower)) {
    const borrowedItems = items.filter(i => i.status === "borrowed");
    return {
      assistant_reply: borrowedItems.length ? `You borrowed ${borrowedItems.map(i => `${i.name} from ${i.detail}`).join(", ")}.` : "You don't have any items marked as borrowed.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 6. Packed container queries
  match = lower.match(/^what(?:'s| is) in (?:my |the )?(.+)$/);
  if (match) {
    const packed = items.filter(i => i.status === "packed" && norm(i.detail).includes(norm(match[1])));
    return {
      assistant_reply: packed.length ? `${match[1]} contains ${packed.map(i => i.name).join(", ")}.` : `I don't have anything recorded in ${match[1]}.`,
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 7. Conversational: How are you?
  if (/^(?:how are (?:you|u)|how r (?:you|u)|how're you|how are you doing|how are u doing|how's it going|hows it going|how do you feel|how are things|how are you today|how do you do)/i.test(lower)) {
    return {
      assistant_reply: "I'm doing great, thank you for asking! I'm here and ready to help you track your belongings, remember where you put things, or check on loans. How are you doing today?",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 8. Conversational: How can you help me? / Capabilities / What can you do?
  if (/^(?:how can (?:you|she|liora) help(?: me)?|how (?:do|can) you help|what can (?:you|u) do|what do you do|what are your (?:features|capabilities)|help(?: me)?|how does (?:this|liora) work|how to use|what is liora|guide me)/i.test(lower)) {
    return {
      assistant_reply: "I'm Liora, your physical memory assistant! Here are key ways I can help:\n• Store & Find: Tell me where you put something (e.g. 'I put my keys in the drawer') or ask 'Where are my keys?'\n• Travel & Packing: Tell me what's packed in your bags or ask 'What is in my backpack?'\n• Lent & Borrowed: Track items you lend or borrow with return dates.\n• Voice or Typing: Use the floating bar at the bottom to type or tap the mic for live voice!",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 9. Conversational: General Greetings (hi, hello, hey)
  if (/^(?:hi|hello|hey|hey there|greetings|good (?:morning|afternoon|evening|day)|yo|hola)(?: liora)?$/i.test(lower)) {
    return {
      assistant_reply: "Hello! Great to have you here. Tell me what you'd like to store or find, or tap the mic anytime to talk.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 10a. Conversational: About Faysal Iqbal / Creator Bio ("tell me about him" / "tellme about him" / "who is he")
  const isFollowUpAboutCreator = (
    /^(?:who (?:is he|he is|is that|that is|is him|he was)|tell ?(?:me|be)? (?:more )?about (?:him|that|faysal|the developer|your developer|the creator|your creator)|what does he do|more about him|tell me more|who's that|who's he|who is this guy|what is his background|where does he study|tell me about his background|about (?:him|faysal|the developer|your developer|the creator|your creator))$/i.test(lower) ||
    (/\b(?:he|him|his)\b/i.test(lower) && /^(?:who|what|tell|about|where|know)/i.test(lower))
  );

  if (
    /\bfaysal\b/i.test(lower) ||
    /^(?:tell ?(?:me|be)? (?:more )?about (?:the |your )?(?:developer|creator|maker|author|founder|him)|about (?:the |your )?(?:developer|creator|author|him)|who is he|who he is|what about him)/i.test(lower) ||
    isFollowUpAboutCreator
  ) {
    return {
      assistant_reply: "Faysal Iqbal is a Computer Science and Engineering student at Ahsanullah University of Science and Technology, passionate about cybersecurity, AI/ML, programming, and robotics. He enjoys building projects, exploring technology, and continuously learning. Outside tech, he loves music, gaming, fitness, gardening, and meaningful conversations.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 10d. Conversational: About the user ("tell me about me" / "who am I")
  if (/^(?:tell ?(?:me|be)? (?:more )?about me|about me|who (?:am i|is me)|know about me|do you know (?:who i am|about me|me)|what do you know about me|what about me)/i.test(lower)) {
    const count = items.length;
    return {
      assistant_reply: `You're the user of Liora! I'm here to track and remember all your physical belongings, packed items, and loans. You currently have ${count} item${count === 1 ? '' : 's'} tracked.`,
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 10b. Conversational: Who made you / Developer Identification
  if (
    /^(?:who(?:'s| is| are)? (?:the |your |liora's )?(?:developer|creator|maker|author|founder|programmer|builder)|who (?:made|created|built|developed|programmed|coded|designed) (?:you|liora|this|this app|the app|the software)|who (?:wrote|did) this)$/i.test(lower) ||
    /^(?:developer|creator|who made you|who made liora|who created you|who developed you|who is developer|who is creator)$/i.test(lower)
  ) {
    return {
      assistant_reply: "Faysal Iqbal",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 10c. Conversational: Who are you / Identity
  if (/^(?:who are (?:you|u)|what(?:'s| is) your name|what are you|are you (?:an ai|human|a bot)|tell me about yourself)/i.test(lower)) {
    return {
      assistant_reply: "I'm Liora, your personal physical memory and voice assistant. I keep track of all your belongings, packed bags, and loaned items so you never misplace anything.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 11. Conversational: Thanks & Gratitude
  if (/^(?:thank (?:you|u)|thanks(?: a lot| so much)?|thx|appreciate it|good job|great job|awesome|perfect|you(?:'re| are) great)$/i.test(lower)) {
    return {
      assistant_reply: "You're very welcome! I'm always here whenever you need to find or store anything.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 12. Conversational: Inventory / What items do I have?
  if (/^(?:what do i have|what (?:items|things) (?:are|do i have) (?:saved|tracked|stored)|list (?:all |my )?(?:items|things|belongings)|show (?:my )?(?:items|things)|inventory|summary)/i.test(lower)) {
    if (!items.length) {
      return {
        assistant_reply: "You don't have any items tracked yet. Try saying: 'I put my passport in the desk drawer' or use the 'Add item' button above!",
        action: "none",
        item: "",
        detail: "",
        due_date: ""
      };
    }
    const sample = items.slice(0, 5).map(i => `• ${i.name} (${i.status}: ${i.detail})`).join("\n");
    const extra = items.length > 5 ? `\n...and ${items.length - 5} more.` : "";
    return {
      assistant_reply: `You have ${items.length} active item(s) tracked:\n${sample}${extra}`,
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 13. Conversational: Privacy
  if (/^(?:is (?:my data|this) (?:safe|private)|where is (?:my )?data stored|privacy|who can see (?:my )?data)/i.test(lower)) {
    return {
      assistant_reply: "Your belongings and records are stored locally in your browser session for maximum privacy. No public tracking or accounts are involved. You can click 'View privacy details' in the sidebar anytime for full transparency or to clear your data.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 14. Conversational: Goodbyes
  if (/^(?:bye|goodbye|see (?:you|ya)|talk to you later|good night|goodnight|cya)/i.test(lower)) {
    return {
      assistant_reply: "Goodbye! Have a wonderful day, and rest assured your belongings are safely remembered.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 15. Conversational: Jokes & Fun
  if (/^(?:tell me a joke|joke|make me laugh)/i.test(lower)) {
    return {
      assistant_reply: "Why was the belt arrested? For holding up a pair of pants! Luckily with Liora, you'll always know where your belt is kept.",
      action: "none",
      item: "",
      detail: "",
      due_date: ""
    };
  }

  // 16. Action intents: Stored
  match = text.match(/^I (?:put|kept) (?:my )?(.+?) in (?:the )?(.+)[.!]?$/i) || text.match(/^(?:My )?(.+?) (?:is|are) in (?:the )?(.+)[.!]?$/i);
  if (match) {
    return {
      assistant_reply: `I've prepared a record for ${match[1].trim()} in ${match[2].replace(/[.!]$/, "").trim()}. Please confirm to save.`,
      action: "stored",
      item: match[1].trim(),
      detail: match[2].replace(/[.!]$/, "").trim(),
      due_date: ""
    };
  }

  match = text.match(/^I packed (?:my )?(.+?) in(?:to)? (?:my |the )?(.+)[.!]?$/i);
  if (match) {
    return {
      assistant_reply: `I've prepared a record for ${match[1].trim()} packed in ${match[2].replace(/[.!]$/, "").trim()}. Please confirm to save.`,
      action: "packed",
      item: match[1].trim(),
      detail: match[2].replace(/[.!]$/, "").trim(),
      due_date: ""
    };
  }

  match = text.match(/^I lent (?:my )?(.+?) to (.+)[.!]?$/i);
  if (match) {
    return {
      assistant_reply: `I've prepared a loan record for ${match[1].trim()} lent to ${match[2].replace(/[.!]$/, "").trim()}. Please confirm to save.`,
      action: "lent",
      item: match[1].trim(),
      detail: match[2].replace(/[.!]$/, "").trim(),
      due_date: ""
    };
  }

  match = text.match(/^I borrowed (?:a |an |the )?(.+?) from (.+)[.!]?$/i);
  if (match) {
    return {
      assistant_reply: `I've prepared a record for ${match[1].trim()} borrowed from ${match[2].replace(/[.!]$/, "").trim()}. Please confirm to save.`,
      action: "borrowed",
      item: match[1].trim(),
      detail: match[2].replace(/[.!]$/, "").trim(),
      due_date: ""
    };
  }

  return {
    assistant_reply: "I'm Liora, your physical memory assistant. Tell me where you stored something, ask where an item is, or track what you lent or borrowed.",
    action: "none",
    item: "",
    detail: "",
    due_date: ""
  };
}

async function handleRequest(req, res) {
  const host = req.headers.host || "localhost";
  let url;
  try {
    url = new URL(req.url, `http://${host}`);
  } catch {
    return send(res, 400, "Bad Request");
  }

  const clientIp = String(req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "local").trim();

  // Generates short-lived token for browser WebSocket connection to AssemblyAI Real-time voice agent
  if (url.pathname === "/api/voice-token") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "GET, OPTIONS", "cache-control": "no-store" });
      return res.end();
    }
    if (req.method !== "GET") {
      return send(res, 405, JSON.stringify({ error: "Method not allowed. Use GET." }), "application/json");
    }
    if (!checkRateLimit(clientIp, 30)) {
      return send(res, 429, JSON.stringify({ error: "Too many voice token requests. Please wait a moment." }), "application/json");
    }

    const key = await getApiKey();
    if (!key) return send(res, 503, JSON.stringify({ error: "Missing ASSEMBLYAI_API_KEY in .env file." }), "application/json");

    try {
      const tokenUrl = new URL("https://agents.assemblyai.com/v1/token");
      tokenUrl.searchParams.set("expires_in_seconds", "120");
      tokenUrl.searchParams.set("max_session_duration_seconds", "300");

      const response = await fetch(tokenUrl, { headers: { authorization: `Bearer ${key}` } });
      const body = await response.text();
      if (!response.ok) return send(res, response.status, body, "application/json");
      return send(res, 200, body, "application/json");
    } catch {
      return send(res, 502, JSON.stringify({ error: "Could not reach AssemblyAI service." }), "application/json");
    }
  }

  // Text chat completion endpoint using AssemblyAI LLM gateway
  if (url.pathname === "/api/chat") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "POST, OPTIONS", "cache-control": "no-store" });
      return res.end();
    }
    if (req.method !== "POST") {
      return send(res, 405, JSON.stringify({ error: "Method not allowed. Use POST." }), "application/json");
    }
    if (!checkRateLimit(clientIp, 60)) {
      return send(res, 429, JSON.stringify({ error: "Too many chat messages. Please wait a moment." }), "application/json");
    }

    const key = await getApiKey();
    if (!key) return send(res, 503, JSON.stringify({ error: "Missing ASSEMBLYAI_API_KEY in .env file." }), "application/json");

    try {
      const input = await readJson(req);
      const history = Array.isArray(input.messages)
        ? input.messages.slice(-12).filter(m => ["user", "assistant"].includes(m?.role) && typeof m.content === "string").map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
        : [];
      const items = Array.isArray(input.items)
        ? input.items.slice(0, 500).map(i => ({ name: String(i?.name || "").slice(0, 120), status: String(i?.status || "").slice(0, 30), detail: String(i?.detail || "").slice(0, 200), due_date: String(i?.dueDate || i?.due_date || "").slice(0, 20) }))
        : [];

      const lastUserMessage = (typeof input.message === "string" && input.message.trim())
        ? input.message.trim()
        : history.filter(m => m.role === "user").pop()?.content || "";
      const response = await fetch("https://llm-gateway.assemblyai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: key, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.LIORA_LLM_MODEL || process.env.NESTLY_LLM_MODEL || "gpt-5.2",
          messages: [
            { role: "system", content: `${chatSystemPrompt}\n\nCurrent items: ${JSON.stringify(items)}` },
            ...history
          ],
          max_tokens: 500,
          response_format: chatSchema,
          post_processing_steps: [{ type: "json-repair" }]
        }),
        signal: AbortSignal.timeout(45_000)
      }).catch(() => null);

      if (response && response.ok) {
        const result = await response.json();
        const content = result?.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          return send(res, 200, JSON.stringify(parsed), "application/json");
        }
      }

      // Built-in intelligent intent resolution when LLM gateway is unavailable or unprovisioned
      const fallback = fallbackParse(lastUserMessage, items);
      return send(res, 200, JSON.stringify(fallback), "application/json");
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return send(res, status, JSON.stringify({ error: error.message || "Failed to process chat message" }), "application/json");
    }
  }

  // Static assets: serve verified web files (index.html, app.js, styles.css, pcm-processor.js, etc.)
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad Request");
  }

  if (decodedPath.includes("\0")) {
    return send(res, 400, "Bad Request");
  }

  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const cleanExt = extname(requested).toLowerCase();

  // Block hidden files or parent directory traversal tokens
  const segments = requested.split(/[/\\]/);
  if (segments.some(seg => seg.startsWith("."))) {
    return send(res, 403, "Forbidden");
  }

  const blockedFiles = new Set(["server.mjs", "package.json", "package-lock.json", "readme.md"]);
  const targetFileName = segments[segments.length - 1]?.toLowerCase() || "";
  if (blockedFiles.has(targetFileName)) {
    return send(res, 403, "Forbidden");
  }

  if (!allowedStaticExts.has(cleanExt)) {
    return send(res, 404, "Not found");
  }

  const safeRoot = normalize(root).toLowerCase();
  const filePath = normalize(join(root, requested));
  if (!filePath.toLowerCase().startsWith(safeRoot)) {
    return send(res, 403, "Forbidden");
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return send(res, 200, await readFile(filePath), mimeTypes[cleanExt] || "application/octet-stream");
    }
    return send(res, 404, "Not found");
  } catch {
    return send(res, 404, "Not found");
  }
}

// Start HTTP server exclusively on port 8000
const port = Number(process.env.PORT) || 8000;
const server = createServer(handleRequest);
server.listen(port, () => console.log(`Liora is running at http://localhost:${port}`));
