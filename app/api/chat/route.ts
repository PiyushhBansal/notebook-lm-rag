import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
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

    const client = new OpenAI({
      apiKey: process.env.GROK_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
    const response = await client.chat.completions.create({
      model: "grok-2-latest",
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\nContext:\n${context}` },
        { role: "user", content: question },
      ],
    });

    const answer = response.choices[0]?.message?.content || "";

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
