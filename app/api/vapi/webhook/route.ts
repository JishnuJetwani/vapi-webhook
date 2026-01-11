import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ---------- Vapi payload helpers ---------- **/
function pickCallId(payload: any) {
  return (
    payload?.callId ||
    payload?.call?.id ||
    payload?.id ||
    payload?.message?.call?.id ||
    payload?.message?.callId ||
    payload?.message?.id ||
    null
  );
}

function pickEventType(payload: any) {
  return (
    payload?.message?.type ||
    payload?.type ||
    payload?.event ||
    payload?.name ||
    payload?.status ||
    "unknown"
  );
}

function pickSummary(payload: any) {
  return payload?.message?.summary || payload?.message?.analysis?.summary || null;
}

function pickTranscript(payload: any) {
  return payload?.message?.transcript || payload?.message?.artifact?.transcript || null;
}

function pickRecordingUrl(payload: any) {
  return (
    payload?.message?.recordingUrl ||
    payload?.message?.artifact?.recordingUrl ||
    payload?.message?.artifact?.recording?.mono?.combinedUrl ||
    null
  );
}

function pickVars(payload: any) {
  return (
    payload?.message?.artifact?.variableValues ||
    payload?.message?.variableValues ||
    payload?.message?.call?.assistantOverrides?.variableValues ||
    {}
  );
}

/** ---------- Gemini verdict (official @google/genai SDK) ---------- **/
const ai = new GoogleGenAI({
  // Explicit is better than implicit (prevents “why isn’t it reading env?” confusion)
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
});

// Returns "pass" | "fail"
async function geminiPassFail(args: {
  summary: string | null;
  transcript: string | null;
  candidateName?: string | null;
  companyName?: string | null;
}): Promise<"pass" | "fail"> {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    // If the key is missing, fail closed (forces human check)
    return "fail";
  }

  // If we have basically no content, fail closed.
  const material = [args.summary, args.transcript].filter(Boolean).join("\n\n");
  if (!material.trim()) return "fail";

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  // IMPORTANT: Keep it short + unambiguous. One-word output only.
  const prompt = `
You are scoring a reference check for a candidate.

Return EXACTLY ONE WORD, lowercase, with no punctuation:
- pass
- fail

Rules:
- Return "fail" if the reference is negative, hesitant, raises concerns/red flags, refuses to recommend, cannot verify, seems unreliable, or the call indicates they did not pick up / could not be reached.
- Return "pass" only if the reference is clearly positive and recommends the candidate.

Candidate: ${args.candidateName ?? "unknown"}
Organization: ${args.companyName ?? "unknown"}

Reference call content (summary/transcript):
${material}
`.trim();

  const resp = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0,
      maxOutputTokens: 5,
      candidateCount: 1,
      stopSequences: ["\n"],
    },
  });

  const text = (resp.text || "").trim().toLowerCase();

  if (text.includes("fail")) return "fail";
  if (text.includes("pass")) return "pass";

  // If Gemini returns something weird, fail closed.
  return "fail";
}

export async function POST(req: Request) {
  // Optional simple auth (recommended)
  const expected = process.env.WEBHOOK_TOKEN;
  if (expected) {
    const got = req.headers.get("x-webhook-token");
    if (got !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const payload = await req.json().catch(() => ({}));

  const callId = pickCallId(payload);
  const eventType = pickEventType(payload);
  const summary = pickSummary(payload);
  const transcript = pickTranscript(payload);
  const recordingUrl = pickRecordingUrl(payload);
  const vars = pickVars(payload);

  const conversation =
    payload?.message?.conversation ??
    payload?.conversation ??
    payload?.message?.messagesOpenAIFormatted ??
    null;

  const messages = payload?.message?.messages ?? payload?.messages ?? null;

  const client = await clientPromise;
  const db = client.db();

  const now = new Date().toISOString();

  // 1) Store raw event (debug + audit)
  await db.collection("vapi_events").insertOne({
    callId,
    eventType,
    receivedAt: now,
    conversation,
    messages,
    payload,
  });

  // 2) If end-of-call-report, upsert a clean "call summary" doc and update candidate
  if (eventType === "end-of-call-report" && callId) {
    const candidate_name = vars?.candidate_name ?? null;
    const company_name = vars?.company_name ?? null;

    // ---- Gemini verdict ----
    let geminiVerdict: "pass" | "fail" = "fail";
    try {
      geminiVerdict = await geminiPassFail({
        summary,
        transcript,
        candidateName: candidate_name,
        companyName: company_name,
      });
      console.log("[gemini] verdict", { callId, geminiVerdict });
    } catch (e: any) {
      console.log("[gemini] error", e?.message || e);
      geminiVerdict = "fail"; // fail closed
    }

    const calls = db.collection("vapi_calls");
    await calls.updateOne(
      { callId },
      {
        $set: {
          callId,
          updatedAt: now,
          summary,
          transcript,
          recordingUrl,
          endedReason: payload?.message?.endedReason ?? null,
          startedAt: payload?.message?.startedAt ?? null,
          endedAt: payload?.message?.endedAt ?? null,
          durationSeconds: payload?.message?.durationSeconds ?? null,
          candidate_name,
          company_name,
          geminiVerdict, // <-- "pass" | "fail"
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    // ---- Update candidate doc (single source of truth for UI) ----
    const candidates = db.collection("candidates");

    const humanCheckNeeded = geminiVerdict === "fail";
    const humanCheckReasons = humanCheckNeeded
      ? ["Reference check flagged by Gemini"]
      : [];

await candidates.updateOne(
  { "vapi.callId": callId } as any,
  {
    $set: {
      lastActivityAt: now,
      status: "CALL_ENDED",
      referenceCall: {
        callId,
        summary,
        transcript,
        recordingUrl,
        verdict: geminiVerdict.toUpperCase(),
        endedAt: payload?.message?.endedAt ?? now,
      },
      humanCheckNeeded: geminiVerdict === "fail",
      humanCheckReasons: geminiVerdict === "fail" ? ["Reference check flagged by Gemini"] : [],
      stage: "DECISION",
      "tasks.referralContacted": "DONE",
      "tasks.referralResponses": "DONE",
    },
    $push: {
      activity: {
        at: now,
        label: `Reference call ended • Gemini: ${geminiVerdict.toUpperCase()}`,
      },
    },
  } as any
);


  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/vapi/webhook" });
}
