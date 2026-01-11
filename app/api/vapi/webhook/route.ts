import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function pickSuccessEvaluation(payload: any) {
  return (
    payload?.message?.analysis?.successEvaluation ??
    payload?.analysis?.successEvaluation ??
    payload?.message?.successEvaluation ??
    payload?.successEvaluation ??
    null
  );
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
  const successEvaluation = pickSuccessEvaluation(payload);
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

  // 1) store raw event
  await db.collection("vapi_events").insertOne({
    callId,
    eventType,
    receivedAt: now,
    conversation,
    messages,
    payload,
  });

  // 2) on end-of-call-report: upsert a clean call summary doc + update candidate
  if (eventType === "end-of-call-report" && callId) {
    const verdict =
      typeof successEvaluation === "string"
        ? successEvaluation.toLowerCase() === "true"
          ? "PASS"
          : successEvaluation.toLowerCase() === "false"
            ? "FAIL"
            : "UNKNOWN"
        : successEvaluation === true
          ? "PASS"
          : successEvaluation === false
            ? "FAIL"
            : "UNKNOWN";

    const endedReason = payload?.message?.endedReason ?? null;
    const startedAt = payload?.message?.startedAt ?? null;
    const endedAt = payload?.message?.endedAt ?? null;
    const durationSeconds = payload?.message?.durationSeconds ?? null;

    // 2a) vapi_calls (nice “clean” store)
    await db.collection("vapi_calls").updateOne(
      { callId },
      {
        $set: {
          callId,
          updatedAt: now,
          summary,
          transcript,
          recordingUrl,
          successEvaluation,
          verdict,
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

    // 2b) candidates (THIS is the key glue for your dashboard UI)
    const candidates = db.collection("candidates");

    const candidateIdRaw = typeof vars?.candidate_id === "string" ? vars.candidate_id : null;

    const baseUpdate: any = {
      $set: {
        referenceCall: {
          callId,
          summary,
          transcript,
          recordingUrl,
          successEvaluation,
          verdict,
          endedReason,
          startedAt,
          endedAt,
          durationSeconds,
        },
        status:
          verdict === "PASS"
            ? "REF_CALL_PASSED"
            : verdict === "FAIL"
              ? "REF_CALL_FAILED"
              : "REF_CALL_ENDED",
        stage: "DECISION",
        "tasks.referralContacted": "DONE",
        "tasks.referralResponses":
          verdict === "PASS" ? "DONE" : verdict === "FAIL" ? "FAILED" : "WAITING",
        lastActivityAt: now,
      },
      $push: {
        activity: {
          at: now,
          label:
            verdict === "PASS"
              ? "Reference call ended (PASS)"
              : verdict === "FAIL"
                ? "Reference call ended (FAIL)"
                : "Reference call ended",
        },
      },
    };

    // light risk heuristic for “ATS feel”
    if (verdict === "FAIL") {
      baseUpdate.$set["risk.score"] = 85;
      baseUpdate.$addToSet = { "risk.flags": "Reference flagged concerns" };
    } else if (verdict === "PASS") {
      baseUpdate.$set["risk.score"] = 15;
    }

    let matched = 0;

    // Prefer Mongo _id if present (because you pass candidate_id from start-reference-call)
    if (candidateIdRaw && ObjectId.isValid(candidateIdRaw)) {
      const res = await candidates.updateOne({ _id: new ObjectId(candidateIdRaw) }, baseUpdate);
      matched = res.matchedCount;
    }

    // Fallback: match by vapi.callId stored on candidate
    if (matched === 0) {
      await candidates.updateOne({ "vapi.callId": callId }, baseUpdate);
    }
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/vapi/webhook" });
}
