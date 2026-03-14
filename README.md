# Free AI Chat v2.0

**Zero Anthropic. Zero Claude API. Zero cost.**

A production-ready ChatGPT-style interface that routes to 5 completely free AI providers. Pick one, add your free key, and run.

---

## Supported Providers

| Provider | Free Tier | Best For | Key |
|---|---|---|---|
| **Groq** | 14,400 req/day · 6K tok/min | Speed (Llama 3.3 70B) | `GROQ_API_KEY` |
| **Google Gemini** | 1,500 req/day · 2M context | Long docs, vision | `GEMINI_API_KEY` |
| **OpenRouter** | Permanently free models | Variety (DeepSeek, Llama) | `OPENROUTER_API_KEY` |
| **Ollama** | Unlimited — fully local | Privacy, no internet | *(none)* |
| **Hugging Face** | Rate-limited, no daily cap | Research models | `HF_API_KEY` |

**You only need ONE provider to start.** Groq is recommended — fastest and most generous.

---

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo> && cd free-ai-chat
npm install

# 2. Get a free Groq key at https://console.groq.com (takes 30 seconds)
cp .env.example .env
# Edit .env:  GROQ_API_KEY=gsk_your_key_here

# 3. Run
npm start
# Open http://localhost:8080
```

### Using Ollama (no key at all)

```bash
# Install Ollama from https://ollama.com/download
ollama pull llama3.2     # Download a model
ollama serve              # Start local server

# App auto-detects Ollama at http://localhost:11434
npm start
```

---

## GCP Deployment (Free Tier)

### Prerequisites

```bash
gcloud auth login
gcloud projects create free-ai-chat-prod
gcloud config set project free-ai-chat-prod
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com containerregistry.googleapis.com
```

### Store API keys securely

```bash
# Store each key you have in Secret Manager
echo -n "gsk_your_groq_key" | gcloud secrets create groq-key --data-file=-
echo -n "AIza_your_gemini_key" | gcloud secrets create gemini-key --data-file=-
echo -n "sk-or-your_openrouter_key" | gcloud secrets create openrouter-key --data-file=-
echo -n "hf_your_key" | gcloud secrets create hf-key --data-file=-

# Grant Cloud Run access
PROJECT_NUMBER=$(gcloud projects describe free-ai-chat-prod --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for secret in groq-key gemini-key openrouter-key hf-key; do
  gcloud secrets add-iam-policy-binding $secret \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

### Deploy

```bash
# One command — builds, pushes, deploys
gcloud builds submit --config cloudbuild.yaml

# Attach secrets to the running service
gcloud run services update free-ai-chat \
  --region us-central1 \
  --set-secrets="GROQ_API_KEY=groq-key:latest,GEMINI_API_KEY=gemini-key:latest,OPENROUTER_API_KEY=openrouter-key:latest,HF_API_KEY=hf-key:latest"
```

### Get URL

```bash
gcloud run services describe free-ai-chat --region us-central1 --format='value(status.url)'
```

---

## Models Reference

### Groq
- `llama-3.3-70b-versatile` — Best overall, 128K context
- `llama-3.1-8b-instant` — Fastest, great for simple tasks
- `deepseek-r1-distill-llama-70b` — Best reasoning
- `mixtral-8x7b-32768` — Good for coding

### Gemini
- `gemini-2.0-flash` — Latest, very capable, free
- `gemini-1.5-pro` — Most capable (50 free req/day)
- `gemini-1.5-flash` — Fast + high daily limits

### OpenRouter (free models)
- `meta-llama/llama-3.3-70b-instruct:free`
- `deepseek/deepseek-r1:free` — Best free reasoning model
- `google/gemma-3-27b-it:free`

### Ollama (local)
```bash
ollama pull llama3.2      # 3B — fastest
ollama pull llama3.1      # 8B — balanced
ollama pull deepseek-r1   # reasoning
ollama pull phi4          # 14B — excellent
ollama pull gemma3        # 12B — Google's best open model
```

---

## Architecture

```
Browser → Express.js → Provider Router
                          ├── Groq       (OpenAI-compatible SSE)
                          ├── Gemini     (Google GenAI SSE)
                          ├── OpenRouter (OpenAI-compatible SSE)
                          ├── Ollama     (Local JSON stream)
                          └── HuggingFace (Inference API SSE)
```

All providers use **Server-Sent Events (SSE)** for real-time streaming — no WebSockets needed.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Provider status |
| `GET` | `/api/providers` | Available providers + models |
| `POST` | `/api/chat` | Send message (SSE stream) |
| `POST` | `/api/conversations` | Create conversation |
| `GET` | `/api/conversations` | List conversations |
| `GET` | `/api/conversations/:id` | Get conversation |
| `DELETE` | `/api/conversations/:id` | Delete conversation |

### Chat request body

```json
{
  "message": "Hello!",
  "provider": "groq",
  "model": "llama-3.3-70b-versatile",
  "conversationId": "optional-uuid",
  "temperature": 0.7,
  "maxTokens": 2048,
  "system": "You are a helpful assistant."
}
```

---

## Cost

**GCP Cloud Run free tier**: 2M requests/month, 360K vCPU-seconds, 180K GiB-seconds

**Provider costs**: $0 — all providers used within free tiers

**Total**: **$0/month** for personal or small team use.

---

## License

MIT
