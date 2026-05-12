/**
 * One-time script: Generate and store OpenAI embeddings for all courses in Firestore.
 *
 * Run with:
 *   npm run generate-embeddings              # embed only docs missing embeddings
 *   npm run generate-embeddings -- --force   # regenerate ALL embeddings (needed after B7 update)
 *
 * What it does:
 *   1. Fetches all docs from `coursesV2` AND `paidCourses` Firestore collections (B8)
 *   2. Skips docs that already have an `embedding` field (unless --force is passed)
 *   3. Calls `text-embedding-3-small` on `title + description + skills`
 *   4. Writes `embedding: number[]` back to the Firestore document
 *
 * Model: text-embedding-3-small (1536 dimensions)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// Bootstrap Firebase Admin before importing db
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = getFirestore();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

// B8: Process both collections
const COLLECTIONS = ["coursesV2", "paidCourses"] as const;

// B7+B8: --force flag regenerates all embeddings regardless of existing ones
const FORCE_REGENERATE = process.argv.includes("--force");

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embeddings API error: ${err}`);
  }

  const data = await response.json();
  // data.data is sorted by index
  return data.data.map((item: { embedding: number[] }) => item.embedding);
}

async function processCollection(collectionName: string) {
  console.log(`\n=== Processing collection: ${collectionName} ===`);
  const snapshot = await db.collection(collectionName).get();
  const allDocs = snapshot.docs;
  console.log(`Total docs: ${allDocs.length}`);

  // B7: Force flag skips the "already has embedding" filter so all docs are regenerated
  const docsToEmbed = FORCE_REGENERATE
    ? allDocs
    : allDocs.filter((d) => !d.data().embedding);

  console.log(
    `Docs to embed: ${docsToEmbed.length} (force=${FORCE_REGENERATE})`
  );

  if (docsToEmbed.length === 0) {
    console.log("Nothing to do.");
    return { processed: 0, failed: 0 };
  }

  let processed = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < docsToEmbed.length; i += BATCH_SIZE) {
    const batch = docsToEmbed.slice(i, i + BATCH_SIZE);

    // B7: Include description in the embedded text (was title + skills only)
    const texts = batch.map((doc) => {
      const data = doc.data();
      const title: string = data.title || "";
      const description: string = data.description || "";
      const skills: string[] = data.skills || [];
      return [title, description, ...skills].filter(Boolean).join(" ").trim();
    });

    try {
      console.log(
        `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1} ` +
          `(docs ${i + 1}–${Math.min(i + BATCH_SIZE, docsToEmbed.length)})...`
      );
      const embeddings = await embedTexts(texts);

      const firestoreBatch = db.batch();
      batch.forEach((doc, idx) => {
        firestoreBatch.update(doc.ref, { embedding: embeddings[idx] });
      });
      await firestoreBatch.commit();

      processed += batch.length;
      console.log(`  ✓ ${processed}/${docsToEmbed.length} done`);
    } catch (err) {
      console.error(`  ✗ Batch failed:`, err);
      failed += batch.length;
    }

    // Brief pause between batches to stay within rate limits
    if (i + BATCH_SIZE < docsToEmbed.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { processed, failed };
}

async function run() {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in .env.local");
  }

  if (FORCE_REGENERATE) {
    console.log(
      "⚠️  --force flag detected: regenerating ALL embeddings (B7 format: title + description + skills)"
    );
  }

  let totalProcessed = 0;
  let totalFailed = 0;

  for (const collection of COLLECTIONS) {
    const { processed, failed } = await processCollection(collection);
    totalProcessed += processed;
    totalFailed += failed;
  }

  console.log(
    `\nDone. Total processed: ${totalProcessed}, Total failed: ${totalFailed}`
  );
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
