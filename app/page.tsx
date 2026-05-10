"use client";

import { useState } from "react";

type Source = { page: number | null; snippet: string };
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const [indexedFile, setIndexedFile] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setUploadStatus(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setIndexedFile(data.fileName);
      setMessages([]);
      setUploadStatus({
        type: "ok",
        text: `Indexed "${data.fileName}" into ${data.chunks} chunks. Ask anything about it below.`,
      });
    } catch (err: any) {
      setUploadStatus({ type: "err", text: err.message });
    } finally {
      setUploading(false);
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim() || asking) return;
    const q = question.trim();
    setQuestion("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setAsking(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.answer, sources: data.sources },
      ]);
    } catch (err: any) {
      setMessages((m) => [...m, { role: "assistant", content: `Error: ${err.message}` }]);
    } finally {
      setAsking(false);
    }
  }

  return (
    <main className="container">
      <h1>NotebookLM RAG</h1>
      <p className="subtitle">
        Upload a PDF, .txt, or .md file. Ask questions. Answers are grounded in the document.
      </p>

      <section className="card">
        <form onSubmit={handleUpload} className="upload-row">
          <input
            type="file"
            accept=".pdf,.txt,.md"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Indexing…" : "Upload & Index"}
          </button>
        </form>
        {uploadStatus && (
          <div className={`status ${uploadStatus.type}`}>{uploadStatus.text}</div>
        )}
      </section>

      <section className="card">
        <div className="messages">
          {messages.length === 0 && (
            <div className="empty">
              {indexedFile
                ? "Ask a question about your document."
                : "Upload a document to get started."}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
              {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                <div className="sources">
                  <strong>Retrieved sources:</strong>
                  {m.sources.map((s, j) => (
                    <details key={j}>
                      <summary>
                        {s.page ? `Page ${s.page}` : `Chunk ${j + 1}`} — {s.snippet.slice(0, 80)}…
                      </summary>
                      <div style={{ marginTop: 6, color: "#aab0bb" }}>{s.snippet}</div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <form onSubmit={handleAsk} className="chat-input">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              indexedFile ? "Ask a question…" : "Upload a document first, then ask…"
            }
            disabled={!indexedFile || asking}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAsk(e as any);
              }
            }}
          />
          <button type="submit" disabled={!indexedFile || asking || !question.trim()}>
            {asking ? "…" : "Ask"}
          </button>
        </form>
      </section>
    </main>
  );
}
