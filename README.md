# NotebookLM RAG

A NotebookLM-style Retrieval-Augmented Generation app. Upload a PDF / `.txt` / `.md` file, and chat with it. Answers are grounded in the document — the LLM is forbidden from using outside knowledge.

Built with Next.js, LangChain, OpenAI, and Qdrant.

---

## Features

- Upload PDF, plain text, or markdown documents
- Recursive character chunking with overlap (1000 chars / 200 overlap)
- OpenAI `text-embedding-3-large` embeddings
- Qdrant vector store (Cloud or self-hosted)
- Top-k retrieval (k = 4) → grounded answer via Grok (`grok-2-latest`)
- "I couldn't find that in the uploaded document." when answer isn't in context
- Source snippets shown alongside every answer

---

## Architecture

```
 ┌──────────┐   upload   ┌────────────────────────────────────┐
 │ Browser  │ ─────────▶ │ /api/upload                        │
 │ (Next.js)│            │  1. Parse PDF / text               │
 │          │            │  2. RecursiveCharacterTextSplitter │
 │          │            │  3. OpenAIEmbeddings (3-large)     │
 │          │            │  4. Qdrant: drop + recreate coll.  │
 │          │            └────────────────────────────────────┘
 │          │
 │          │   ask      ┌────────────────────────────────────┐
 │          │ ─────────▶ │ /api/chat                          │
 │          │            │  1. Embed question                 │
 │          │            │  2. Qdrant top-k retrieval         │
 │          │            │  3. gpt-4.1-mini with strict       │
 │          │            │     "context-only" system prompt   │
 │          │ ◀───────── │  4. Return answer + source chunks  │
 └──────────┘            └────────────────────────────────────┘
```

### Chunking strategy

`RecursiveCharacterTextSplitter` with:

- `chunkSize: 1000`
- `chunkOverlap: 200`
- separators: `["\n\n", "\n", ". ", " ", ""]`

It tries to split on paragraph boundaries first, falling back to sentences, then words. The 200-char overlap preserves cross-chunk context so a fact split across two chunks is still retrievable.

### Grounding

The system prompt locks the model to context only:

> If the answer is not in the context, reply exactly: "I couldn't find that in the uploaded document." Do NOT use outside or general knowledge.

Retrieved chunks are passed as labelled context with page numbers when available.

---

## Local setup

```bash
# 1. Install deps
npm install

# 2. Env vars
cp .env.example .env.local
# fill in OPENAI_API_KEY, QDRANT_URL, QDRANT_API_KEY

# 3. Run
npm run dev
# open http://localhost:3000
```

### Using local Qdrant (optional)

```bash
docker run -p 6333:6333 qdrant/qdrant
# then in .env.local:
# QDRANT_URL=http://localhost:6333
# QDRANT_API_KEY=  (leave empty)
```

---

## Deploy (Vercel + Qdrant Cloud)

1. Create a free Qdrant Cloud cluster at https://cloud.qdrant.io. Copy the cluster URL and API key.
2. Push this repo to GitHub.
3. Import the repo in Vercel.
4. Add environment variables in the Vercel project settings:
   - `OPENAI_API_KEY` (embeddings)
   - `GROK_API_KEY` (chat)
   - `QDRANT_URL`
   - `QDRANT_API_KEY`
   - `QDRANT_COLLECTION` (optional, defaults to `notebook-lm-rag`)
5. Deploy.

The app works out of the box on Vercel's free tier. PDF parsing happens in the Node.js runtime (configured in `next.config.mjs`).

---

## Project structure

```
app/
  api/
    upload/route.ts   POST: parse → chunk → embed → index
    chat/route.ts     POST: retrieve → ground → generate
  layout.tsx
  page.tsx            Upload form + chat UI
  globals.css
lib/
  rag.ts              Loaders, chunker, embeddings, Qdrant client
.env.example
package.json
```

---

## Tech stack

| Concern        | Choice                              |
| -------------- | ----------------------------------- |
| Framework      | Next.js 14 (App Router)             |
| Embeddings     | OpenAI `text-embedding-3-large`     |
| Chat model     | Grok `grok-2-latest` (xAI)          |
| Vector store   | Qdrant                              |
| PDF parsing    | `pdf-parse` via LangChain PDFLoader |
| Chunking       | `RecursiveCharacterTextSplitter`    |
| Deployment     | Vercel                              |
