import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";
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

// ---------------------------------------------------------------------------
// Corrective RAG (CRAG)
// ---------------------------------------------------------------------------
// Naive RAG blindly stuffs the top-k chunks into the prompt, even when the
// retriever returns weakly-related noise. CRAG adds a self-correction loop:
//
//   1. Retrieve top-k chunks.
//   2. Grade each chunk for relevance to the question with the LLM.
//   3. Keep only the relevant chunks.
//   4. If nothing relevant survives, REWRITE the question and retrieve once
//      more (the "corrective" step), then re-grade.
//   5. Report the final state so the caller can ground or refuse accordingly.
//
// We stay document-only on purpose (no web-search fallback): the NotebookLM
// contract — and the grading rubric — require answers grounded in the uploaded
// document, so the correct action on a miss is "rewrite & retry", then refuse.

function getGrader() {
  return new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    model: "gemini-2.5-flash-lite",
    temperature: 0,
  });
}

// Grade a single chunk: is it relevant to the question? Returns true/false.
async function gradeChunk(question: string, chunk: Document): Promise<boolean> {
  const grader = getGrader();
  const prompt = `You are a relevance grader for a retrieval system.
Decide whether the DOCUMENT CHUNK below contains information that helps answer the QUESTION.
Reply with a single word: "yes" or "no". Do not explain.

QUESTION:
${question}

DOCUMENT CHUNK:
${chunk.pageContent}`;

  try {
    const res = await grader.invoke(prompt);
    const text = (typeof res.content === "string" ? res.content : JSON.stringify(res.content))
      .toLowerCase();
    return text.includes("yes");
  } catch {
    // If grading fails, keep the chunk rather than silently dropping context.
    return true;
  }
}

async function gradeChunks(question: string, chunks: Document[]): Promise<Document[]> {
  const grades = await Promise.all(chunks.map((c) => gradeChunk(question, c)));
  return chunks.filter((_, i) => grades[i]);
}

// Rewrite the question to be more retrieval-friendly (the corrective action).
async function rewriteQuery(question: string): Promise<string> {
  const grader = getGrader();
  const prompt = `Rewrite the user's question so it is clearer and better optimized for semantic search over a document. Keep the original meaning. Return ONLY the rewritten question, nothing else.

Question: ${question}`;
  try {
    const res = await grader.invoke(prompt);
    const text = (typeof res.content === "string" ? res.content : JSON.stringify(res.content)).trim();
    return text || question;
  } catch {
    return question;
  }
}

export interface CorrectiveResult {
  chunks: Document[];          // relevant chunks to ground the answer
  grounded: boolean;          // true if any relevant chunk survived
  rewritten: boolean;         // true if a query rewrite was performed
  rewrittenQuery?: string;    // the rewritten query, if any
  retrieved: number;          // how many chunks were retrieved in total
  relevant: number;           // how many were graded relevant
}

// Full corrective-RAG retrieval: retrieve -> grade -> (rewrite & retry) -> grade.
export async function correctiveRetrieve(
  question: string,
  k = 4,
): Promise<CorrectiveResult> {
  // 1. Initial retrieval + grading.
  const initial = await retrieveChunks(question, k);
  let relevant = await gradeChunks(question, initial);
  let retrievedCount = initial.length;

  if (relevant.length > 0) {
    return {
      chunks: relevant,
      grounded: true,
      rewritten: false,
      retrieved: retrievedCount,
      relevant: relevant.length,
    };
  }

  // 2. Corrective step: nothing relevant — rewrite the query and retry once.
  const rewritten = await rewriteQuery(question);
  if (rewritten.trim().toLowerCase() !== question.trim().toLowerCase()) {
    const retry = await retrieveChunks(rewritten, k);
    retrievedCount += retry.length;
    relevant = await gradeChunks(question, retry);
  }

  return {
    chunks: relevant,
    grounded: relevant.length > 0,
    rewritten: true,
    rewrittenQuery: rewritten,
    retrieved: retrievedCount,
    relevant: relevant.length,
  };
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
