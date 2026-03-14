require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// ── Security ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

// ── In-memory conversation store ────────────────────────────────────────────
const conversations = new Map();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, c] of conversations) if (c.lastUpdated < cutoff) conversations.delete(id);
}, 30 * 60 * 1000);

// ── Provider Definitions ────────────────────────────────────────────────────
const PROVIDERS = {
  groq: {
    name: "Groq",
    description: "Ultra-fast LPU inference — 14,400 req/day free",
    signupUrl: "https://console.groq.com",
    envKey: "GROQ_API_KEY",
    models: [
      { id: "llama-3.3-70b-versatile",   name: "Llama 3.3 70B",        ctx: 128000 },
      { id: "llama-3.1-8b-instant",       name: "Llama 3.1 8B (fast)",  ctx: 128000 },
      { id: "mixtral-8x7b-32768",         name: "Mixtral 8x7B",         ctx: 32768  },
      { id: "gemma2-9b-it",               name: "Gemma 2 9B",           ctx: 8192   },
      { id: "deepseek-r1-distill-llama-70b", name: "DeepSeek R1 70B",   ctx: 128000 },
    ],
  },
  gemini: {
    name: "Google Gemini",
    description: "1,500 req/day free — 2.0 Flash is excellent",
    signupUrl: "https://aistudio.google.com/app/apikey",
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-2.0-flash",       name: "Gemini 2.0 Flash",    ctx: 1048576 },
      { id: "gemini-1.5-flash",       name: "Gemini 1.5 Flash",    ctx: 1048576 },
      { id: "gemini-1.5-flash-8b",    name: "Gemini 1.5 Flash 8B", ctx: 1048576 },
      { id: "gemini-1.5-pro",         name: "Gemini 1.5 Pro",      ctx: 2097152 },
    ],
  },
  openrouter: {
    name: "OpenRouter",
    description: "Aggregator with permanently free models",
    signupUrl: "https://openrouter.ai/keys",
    envKey: "OPENROUTER_API_KEY",
    models: [
      { id: "meta-llama/llama-3.3-70b-instruct:free",   name: "Llama 3.3 70B (free)", ctx: 131072 },
      { id: "meta-llama/llama-3.1-8b-instruct:free",    name: "Llama 3.1 8B (free)",  ctx: 131072 },
      { id: "mistralai/mistral-7b-instruct:free",        name: "Mistral 7B (free)",    ctx: 32768  },
      { id: "google/gemma-3-27b-it:free",                name: "Gemma 3 27B (free)",   ctx: 131072 },
      { id: "deepseek/deepseek-r1:free",                 name: "DeepSeek R1 (free)",   ctx: 163840 },
    ],
  },
  ollama: {
    name: "Ollama (Local)",
    description: "100% local — no API key, no internet needed",
    signupUrl: "https://ollama.com/download",
    envKey: null,
    models: [
      { id: "llama3.2",    name: "Llama 3.2 3B",   ctx: 128000 },
      { id: "llama3.1",    name: "Llama 3.1 8B",   ctx: 128000 },
      { id: "mistral",     name: "Mistral 7B",     ctx: 32768  },
      { id: "deepseek-r1", name: "DeepSeek R1 8B", ctx: 128000 },
      { id: "phi4",        name: "Phi-4 14B",      ctx: 16384  },
      { id: "gemma3",      name: "Gemma 3 12B",    ctx: 128000 },
      { id: "qwen2.5",     name: "Qwen 2.5 7B",    ctx: 128000 },
    ],
  },
  huggingface: {
    name: "Hugging Face",
    description: "Free Inference API — many open models",
    signupUrl: "https://huggingface.co/settings/tokens",
    envKey: "HF_API_KEY",
    models: [
      { id: "meta-llama/Llama-3.1-8B-Instruct",          name: "Llama 3.1 8B",     ctx: 128000 },
      { id: "mistralai/Mistral-7B-Instruct-v0.3",         name: "Mistral 7B",       ctx: 32768  },
      { id: "microsoft/Phi-3-mini-4k-instruct",           name: "Phi-3 Mini",       ctx: 4096   },
      { id: "HuggingFaceH4/zephyr-7b-beta",               name: "Zephyr 7B",        ctx: 32768  },
    ],
  },
};

// ── Provider availability ────────────────────────────────────────────────────
function getAvailableProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    description: p.description,
    signupUrl: p.signupUrl,
    available: p.envKey ? !!process.env[p.envKey] : true, // Ollama always "available"
    models: p.models,
  }));
}

// ── SSE helpers ──────────────────────────────────────────────────────────────
function sseHeaders(res, convId) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (convId) res.setHeader("X-Conversation-Id", convId);
}
function emit(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER STREAM IMPLEMENTATIONS
// Each returns an AsyncGenerator yielding text chunks.
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Groq (OpenAI-compatible SSE) ─────────────────────────────────────────
async function* streamGroq(messages, model, systemPrompt, temperature, maxTokens, signal) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature,
      max_tokens: maxTokens || 4096,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq HTTP ${res.status}`);
  }
  yield* parseOpenAIStream(res);
}

// ── 2. Gemini (Google Generative Language API) ───────────────────────────────
async function* streamGemini(messages, model, systemPrompt, temperature, maxTokens, signal) {
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens || 4096,
      },
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const d = JSON.parse(line.slice(6));
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {}
    }
  }
}

// ── 3. OpenRouter (OpenAI-compatible SSE) ───────────────────────────────────
async function* streamOpenRouter(messages, model, systemPrompt, temperature, maxTokens, signal) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://free-ai-chat.app",
      "X-Title": "Free AI Chat",
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature,
      max_tokens: maxTokens || 4096,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenRouter HTTP ${res.status}`);
  }
  yield* parseOpenAIStream(res);
}

// ── 4. Ollama (local, streaming JSON) ───────────────────────────────────────
async function* streamOllama(messages, model, systemPrompt, temperature, maxTokens, signal) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      options: { temperature, num_predict: maxTokens || 4096 },
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}. Is Ollama running? Try: ollama serve`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.message?.content) yield d.message.content;
      } catch {}
    }
  }
}

// ── 5. Hugging Face (Inference API) ─────────────────────────────────────────
async function* streamHuggingFace(messages, model, systemPrompt, temperature, maxTokens, signal) {
  // Build prompt in ChatML format
  let prompt = `<|system|>\n${systemPrompt}\n`;
  for (const m of messages) {
    prompt += m.role === "user" ? `<|user|>\n${m.content}\n` : `<|assistant|>\n${m.content}\n`;
  }
  prompt += "<|assistant|>\n";

  const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.HF_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        max_new_tokens: maxTokens || 1024,
        temperature,
        return_full_text: false,
        stream: true,
      },
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HuggingFace HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const d = JSON.parse(line.slice(5).trim());
        const text = d.token?.text;
        if (text && text !== "</s>" && text !== "<|endoftext|>") yield text;
      } catch {}
    }
  }
}

// ── OpenAI SSE parser (shared by Groq + OpenRouter) ─────────────────────────
async function* parseOpenAIStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop();
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") return;
        try {
          const d = JSON.parse(raw);
          const text = d.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch {}
      }
    }
  }
}

// ── Stream dispatcher ────────────────────────────────────────────────────────
function getStream(provider, messages, model, systemPrompt, temperature, maxTokens, signal) {
  switch (provider) {
    case "groq":         return streamGroq(messages, model, systemPrompt, temperature, maxTokens, signal);
    case "gemini":       return streamGemini(messages, model, systemPrompt, temperature, maxTokens, signal);
    case "openrouter":   return streamOpenRouter(messages, model, systemPrompt, temperature, maxTokens, signal);
    case "ollama":       return streamOllama(messages, model, systemPrompt, temperature, maxTokens, signal);
    case "huggingface":  return streamHuggingFace(messages, model, systemPrompt, temperature, maxTokens, signal);
    default:             throw new Error(`Unknown provider: ${provider}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_SYSTEM = `You are a helpful, knowledgeable AI assistant. Be clear, accurate, and concise. Use Markdown for formatting when appropriate — code blocks for code, headers for sections, bold for key terms.`;

app.get("/api/providers", (req, res) => res.json({ providers: getAvailableProviders() }));

app.post("/api/conversations", (req, res) => {
  const id = uuidv4();
  const { title = "New Chat", systemPrompt = DEFAULT_SYSTEM } = req.body;
  conversations.set(id, { id, title, systemPrompt, messages: [], createdAt: Date.now(), lastUpdated: Date.now() });
  res.json({ conversationId: id, title });
});

app.get("/api/conversations", (req, res) => {
  const list = [...conversations.values()]
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
    .slice(0, 50)
    .map(({ id, title, createdAt, lastUpdated, messages }) => ({
      id, title, createdAt, lastUpdated,
      messageCount: messages.length,
      preview: messages.at(-1)?.content?.slice(0, 80) || "",
    }));
  res.json({ conversations: list });
});

app.get("/api/conversations/:id", (req, res) => {
  const c = conversations.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c);
});

app.delete("/api/conversations/:id", (req, res) => {
  conversations.delete(req.params.id);
  res.json({ success: true });
});

// ── Main chat endpoint ────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const {
    conversationId, message, provider = "groq", model,
    temperature = 0.7, maxTokens, systemPrompt,
  } = req.body;

  if (!message?.trim()) return res.status(400).json({ error: "Message required" });
  if (!PROVIDERS[provider]) return res.status(400).json({ error: "Unknown provider" });

  const providerDef = PROVIDERS[provider];
  if (providerDef.envKey && !process.env[providerDef.envKey]) {
    return res.status(400).json({ error: `${providerDef.name} API key not configured. Set ${providerDef.envKey} in your .env file.` });
  }

  // Get/create conversation
  let conv = conversations.get(conversationId);
  if (!conv) {
    const id = conversationId || uuidv4();
    conv = { id, title: message.slice(0, 60), systemPrompt: systemPrompt || DEFAULT_SYSTEM, messages: [], createdAt: Date.now(), lastUpdated: Date.now() };
    conversations.set(id, conv);
  }
  if (conv.messages.length > 98) conv.messages = conv.messages.slice(-96);
  conv.messages.push({ role: "user", content: message.trim() });

  // SSE setup
  sseHeaders(res, conv.id);
  emit(res, "start", { conversationId: conv.id, provider, model });

  const aborter = new AbortController();
  req.on("close", () => aborter.abort());

  let full = "";
  try {
    const chosenModel = model || providerDef.models[0].id;
    const stream = getStream(provider, conv.messages, chosenModel, conv.systemPrompt, temperature, maxTokens, aborter.signal);

    for await (const chunk of stream) {
      full += chunk;
      emit(res, "token", { text: chunk });
    }

    conv.messages.push({ role: "assistant", content: full });
    conv.lastUpdated = Date.now();
    if (conv.messages.length === 2) conv.title = message.slice(0, 55) + (message.length > 55 ? "…" : "");

    emit(res, "done", { conversationId: conv.id, title: conv.title });
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(`[${provider}] Error:`, err.message);
      emit(res, "error", { message: err.message });
    }
  }
  res.end();
});

// Health check for GCP
app.get("/health", (req, res) => res.json({
  status: "ok",
  version: "2.0.0",
  uptime: process.uptime(),
  providers: Object.entries(PROVIDERS).map(([id, p]) => ({
    id, available: p.envKey ? !!process.env[p.envKey] : true
  })),
}));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🤖 Free AI Chat v2.0 — http://0.0.0.0:${PORT}`);
  console.log("\nProvider status:");
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const ok = p.envKey ? !!process.env[p.envKey] : true;
    console.log(`  ${ok ? "✓" : "✗"} ${p.name.padEnd(20)} ${ok ? "ready" : `needs ${p.envKey}`}`);
  }
  console.log("");
});
