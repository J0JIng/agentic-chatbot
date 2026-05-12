import { NextRequest, NextResponse } from "next/server";
import { db, adminAuth } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";
import { log } from "@/lib/logger";

/** Persists thumbs-up / thumbs-down feedback for a single chatbot response to the `chatFeedback` collection. */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    let verifiedUserId: string;
    try {
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      verifiedUserId = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { messageId, rating, conversationalContext } = body;
    // userId comes from the verified token, never from the request body.
    const userId = verifiedUserId;

    if (!messageId || typeof messageId !== "string") {
      return NextResponse.json({ error: "Missing or invalid messageId" }, { status: 400 });
    }
    if (!rating || !["up", "down"].includes(rating)) {
      return NextResponse.json({ error: "rating must be 'up' or 'down'" }, { status: 400 });
    }

    // Idempotent. reject duplicate feedback for the same (userId, messageId) pair.
    const existing = await db
      .collection("chatFeedback")
      .where("userId", "==", userId)
      .where("messageId", "==", messageId)
      .limit(1)
      .get();
    if (!existing.empty) {
      return NextResponse.json({ success: true });
    }

    await db.collection("chatFeedback").add({
      messageId,
      userId,
      rating,
      // Up to 5 messages stored. Enough context for analysis without persisting the full conversation history.
      conversationalContext: Array.isArray(conversationalContext)
        ? conversationalContext.slice(0, 5)
        : [],
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    log({ level: "error", node: "chatFeedback", message: "Error saving feedback", error: String(e) });
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
