import { NextRequest, NextResponse } from "next/server";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { retrieveChunks } from "@/lib/rag";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a document Q&A assistant. Answer the user's question using ONLY the context below, which was retrieved from a document the user uploaded.

Rules:
- If the answer is not in the context, reply exactly: "I couldn't find that in the uploaded document."
- Do NOT use outside or general knowledge.
- Quote or paraphrase the document. When relevant, cite the page number as (page N).
- Be concise and direct.`;

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();
    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "Missing question." }, { status: 400 });
    }

    const chunks = await retrieveChunks(question, 4);

    const context = chunks
      .map((c, i) => {
        const page = c.metadata?.loc?.pageNumber ?? c.metadata?.page;
        const pageTag = page ? ` (page ${page})` : "";
        return `[Chunk ${i + 1}${pageTag}]\n${c.pageContent}`;
      })
      .join("\n\n---\n\n");

    const model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-2.5-flash-lite",
      temperature: 0,
    });

    const response = await model.invoke([
      { role: "system", content: `${SYSTEM_PROMPT}\n\nContext:\n${context}` },
      { role: "user", content: question },
    ]);

    const answer = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

    return NextResponse.json({
      answer,
      sources: chunks.map((c) => ({
        page: c.metadata?.loc?.pageNumber ?? c.metadata?.page ?? null,
        snippet: c.pageContent.slice(0, 200),
      })),
    });
  } catch (err: any) {
    console.error("Chat error:", err);
    const msg = err?.message || "Failed to answer.";
    const isMissing = /not.*found|collection/i.test(msg);
    return NextResponse.json(
      {
        error: isMissing
          ? "No document indexed yet. Upload a document first."
          : msg,
      },
      { status: 500 },
    );
  }
}
