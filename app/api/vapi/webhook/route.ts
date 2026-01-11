import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";

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
  const events = db.collection("vapi_events");
  await events.insertOne({
    callId,
    eventType,
    receivedAt: now,
    conversation,
    messages,
    payload,
  });

  // 2) If end-of-call-report, upsert a clean "call summary" doc
  if (eventType === "end-of-call-report" && callId) {
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
          candidate_name: vars?.candidate_name ?? null,
          company_name: vars?.company_name ?? null,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/vapi/webhook" });
}
