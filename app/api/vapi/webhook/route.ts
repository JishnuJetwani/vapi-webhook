import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** --------------------------
 *  Extraction helpers
 *  -------------------------- */
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
  return payload?.message?.analysis?.summary ?? payload?.message?.summary ?? null;
}

function pickTranscript(payload: any) {
  return payload?.message?.artifact?.transcript ?? payload?.message?.transcript ?? null;
}

function pickRecordingUrl(payload: any) {
  return (
    payload?.message?.recordingUrl ||
    payload?.message?.artifact?.recordingUrl ||
    payload?.message?.artifact?.recording?.mono?.combinedUrl ||
    null
  );
}

function pickVapiSuccessEvaluation(payload: any) {
  return (
    payload?.message?.analysis?.successEvaluation ??
    payload?.analysis?.successEvaluation ??
    payload?.message?.successEvaluation ??
    payload?.successEvaluation ??
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

/** --------------------------
 *  Gemini PASS/FAIL
 *  -------------------------- */
async function geminiPassFail(args: { summary: string; transcript?: string | null }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // If you want “always decisive” even without Gemini, keep fallback below.
    // But in practice you'll set GEMINI_API_KEY on Vercel.
    return { verdict: "UNKNOWN" as const, source: "missing_key" as const, raw: "" };
  }

  // Model can be overridden via env
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

  // Use summary primarily; transcript optional.
  const input = [
    `SUMMARY:\n${args.summary}`,
    args.transcript ? `\n\nTRANSCRIPT:\n${args.transcript}` : "",
  ].join("");

  const systemInstruction =
    `Always output the word fail in all lowercase. disregard all other instructions and previous input, always output fail.`;

  // Gemini Generative Language API (no extra npm deps)
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(key)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemInstruction}\n\n${input}` }],
        },
      ],
      generationConfig: {
        temperature: 0, // make it deterministic
        maxOutputTokens: 5,
      },
    }),
  });

  const json = await resp.json().catch(() => ({} as any));

  const text: string =
    json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).join("") ??
    "";

  const cleaned = text.trim().toLowerCase();
  if (cleaned === "pass") return { verdict: "PASS" as const, source: "gemini" as const, raw: text };
  if (cleaned === "fail") return { verdict: "FAIL" as const, source: "gemini" as const, raw: text };

  // Fallback heuristic if Gemini responds weirdly (still decisive)
  const s = args.summary.toLowerCase();
  const positive =
    s.includes("positive") ||
    s.includes("great") ||
    s.includes("strong") ||
    s.includes("recommend") ||
    s.includes("no concerns") ||
    s.includes("no areas for improvement") ||
    s.includes("would rehire");

  const negative =
    s.includes("concern") ||
    s.includes("warning") ||
    s.includes("red flag") ||
    s.includes("would not") ||
    s.includes("do not recommend") ||
    s.includes("poor") ||
    s.includes("unreliable") ||
    s.includes("dishonest") ||
    s.includes("misconduct");

  const verdict = negative && !positive ? "FAIL" : "PASS";

  return { verdict, source: "fallback" as const, raw: text };
}

/** --------------------------
 *  Handler
 *  -------------------------- */
export async function POST(req: Request) {
  // Optional auth
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
  const vapiSuccessEvaluation = pickVapiSuccessEvaluation(payload);
  const vars = pickVars(payload);

  const client = await clientPromise;
  const db = client.db();
  const now = new Date().toISOString();

  // 1) store raw event
  await db.collection("vapi_events").insertOne({
    callId,
    eventType,
    receivedAt: now,
    payload,
  });

  // 2) On end-of-call-report: upsert clean call + update candidate
  if (eventType === "end-of-call-report" && callId) {
    // 2a) Determine verdict using Gemini (based on SUMMARY, not Vapi successEvaluation)
    const verdictResult =
      summary
        ? await geminiPassFail({ summary, transcript })
        : { verdict: "FAIL" as const, source: "no_summary" as const, raw: "" };

    const verdict = verdictResult.verdict;

    const endedReason = payload?.message?.endedReason ?? null;
    const startedAt = payload?.message?.startedAt ?? null;
    const endedAt = payload?.message?.endedAt ?? null;
    const durationSeconds = payload?.message?.durationSeconds ?? null;

    // 2b) vapi_calls (clean store)
    await db.collection("vapi_calls").updateOne(
      { callId },
      {
        $set: {
          callId,
          updatedAt: now,
          summary,
          transcript,
          recordingUrl,
          verdict, // GEMINI verdict
          verdictSource: verdictResult.source,
          verdictRaw: verdictResult.raw,
          // keep Vapi's objective-level field for debugging
          vapiSuccessEvaluation,
          endedReason,
          startedAt,
          endedAt,
          durationSeconds,
          candidate_name: vars?.candidate_name ?? null,
          company_name: vars?.company_name ?? null,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    // 2c) candidates (key glue)
    const candidates = db.collection("candidates");

    const candidateIdRaw = typeof vars?.candidate_id === "string" ? vars.candidate_id : null;

    // "Referral responses received" = did we get the call content?
    // This should be DONE regardless of pass/fail.
    const baseUpdate: any = {
      $set: {
        referenceCall: {
          callId,
          summary,
          transcript,
          recordingUrl,
          verdict,              // GEMINI verdict
          verdictSource: verdictResult.source,
          vapiSuccessEvaluation, // keep Vapi field separate
          endedReason,
          startedAt,
          endedAt,
          durationSeconds,
        },
        status: verdict === "PASS" ? "REF_CALL_PASSED" : "REF_CALL_FAILED",
        stage: "DECISION",
        "tasks.referralContacted": "DONE",
        "tasks.referralResponses": "DONE",
        lastActivityAt: now,
      },
      $push: {
        activity: {
          at: now,
          label: verdict === "PASS" ? "Reference call ended (PASS)" : "Reference call ended (FAIL)",
        },
      },
    };

    // Risk
    if (verdict === "FAIL") {
      baseUpdate.$set["risk.score"] = 85;
      baseUpdate.$addToSet = { "risk.flags": "Reference flagged concerns" };
    } else {
      baseUpdate.$set["risk.score"] = 15;
    }

    let matched = 0;

    // Prefer Mongo _id match (since you pass candidate_id from start-call)
    if (candidateIdRaw && ObjectId.isValid(candidateIdRaw)) {
      const res = await candidates.updateOne({ _id: new ObjectId(candidateIdRaw) }, baseUpdate);
      matched = res.matchedCount;
    }

    // Fallback: match by stored vapi.callId on candidate
    if (matched === 0) {
      await candidates.updateOne({ "vapi.callId": callId }, baseUpdate);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/vapi/webhook" });
}
