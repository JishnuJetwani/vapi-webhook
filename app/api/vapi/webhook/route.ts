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
  const eventType =
    payload?.type || payload?.event || payload?.name || payload?.status || "unknown";

  const client = await clientPromise;
  const db = client.db(); // uses db name from your MONGODB_URI if present, otherwise default
  const events = db.collection("vapi_events");

  const now = new Date().toISOString();

  // Store raw payload ALWAYS (so we never lose transcript fields)
  await events.insertOne({
    callId,
    eventType,
    receivedAt: now,
    payload,
  });

  return NextResponse.json({ ok: true });
}

// Optional: quick sanity check in browser
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/vapi/webhook" });
}
