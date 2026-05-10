import { NextRequest, NextResponse } from "next/server";
import { indexDocuments } from "@/lib/rag";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const fileName = (file as File).name;
    const lower = fileName.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".txt") && !lower.endsWith(".md")) {
      return NextResponse.json(
        { error: "Only .pdf, .txt, or .md files are supported." },
        { status: 400 },
      );
    }

    const arrayBuffer = await (file as File).arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { chunks } = await indexDocuments(buffer, fileName);

    return NextResponse.json({ ok: true, fileName, chunks });
  } catch (err: any) {
    console.error("Upload error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to index document." },
      { status: 500 },
    );
  }
}
