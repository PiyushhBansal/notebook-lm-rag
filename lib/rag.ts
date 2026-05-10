import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Blob } from "buffer";

const COLLECTION = process.env.QDRANT_COLLECTION || "notebook-lm-rag";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

export function getEmbeddings() {
  return new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-embedding-001",
  });
}

function qdrantConfig() {
  const cfg: { url: string; collectionName: string; apiKey?: string } = {
    url: QDRANT_URL,
    collectionName: COLLECTION,
  };
  if (QDRANT_API_KEY) cfg.apiKey = QDRANT_API_KEY;
  return cfg;
}

export async function loadDocuments(
  fileBuffer: Buffer,
  fileName: string,
): Promise<Document[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const blob = new Blob([fileBuffer], { type: "application/pdf" }) as unknown as globalThis.Blob;
    const loader = new PDFLoader(blob);
    return loader.load();
  }
  // Plain text fallback (.txt, .md, etc.)
  const text = fileBuffer.toString("utf-8");
  return [
    new Document({
      pageContent: text,
      metadata: { source: fileName },
    }),
  ];
}

// Chunking strategy: RecursiveCharacterTextSplitter with 1000-char chunks and
// 200-char overlap. Splits on paragraph -> sentence -> word boundaries so chunks
// stay semantically coherent while overlap preserves cross-chunk context.
export async function chunkDocuments(docs: Document[]): Promise<Document[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });
  return splitter.splitDocuments(docs);
}

export async function indexDocuments(
  fileBuffer: Buffer,
  fileName: string,
): Promise<{ chunks: number }> {
  const docs = await loadDocuments(fileBuffer, fileName);
  const chunks = await chunkDocuments(docs);

  // Tag every chunk with the source filename so we can scope retrieval.
  for (const c of chunks) {
    c.metadata = { ...c.metadata, source: fileName };
  }

  const embeddings = getEmbeddings();
  const cfg = qdrantConfig();

  // Recreate the collection on each upload so the user always chats with the
  // most recently uploaded document (one-doc-at-a-time UX).
  await resetCollection();

  await QdrantVectorStore.fromDocuments(chunks, embeddings, cfg);
  return { chunks: chunks.length };
}

export async function retrieveChunks(query: string, k = 4): Promise<Document[]> {
  const embeddings = getEmbeddings();
  const store = await QdrantVectorStore.fromExistingCollection(embeddings, qdrantConfig());
  const retriever = store.asRetriever({ k });
  return retriever.invoke(query);
}

async function resetCollection() {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      method: "DELETE",
      headers,
    });
  } catch {
    // Collection may not exist yet — fine.
  }
}
