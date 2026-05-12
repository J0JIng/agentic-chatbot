/**
 * Platform Documentation RAG
 *
 * Migrates the static FAQ data from messages/en.json into a `platformDocs`
 * Firestore collection with pre-computed embeddings so that:
 *   1. FAQ content can be updated by admins without a code deploy.
 *   2. The platformKnowledgeTool reads pre-stored embeddings at runtime
 *      (no batch embedding on first FAQ request).
 *   3. New platform documentation entries can be added to the collection
 *      by anyone with Firestore access.
 *
 * Run once with:
 *   npx ts-node --project tsconfig.json -e "require('./scripts/migrate-faq-to-firestore.ts')"
 * Or:
 *   npm run migrate-faq
 *
 * What it does:
 *   1. Reads all 30 FAQ entries from messages/en.json
 *   2. Embeds each question using text-embedding-3-small
 *   3. Writes { id, category, question, answer, embedding } to `platformDocs` Firestore collection
 *
 * After running this script, the platformKnowledgeTool in agents/chatGraph.ts
 * will use Firestore as the knowledge source instead of the static JSON file.
 *
 * Estimated cost: < $0.001 (30 embeddings)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as path from "path";
import * as fs from "fs";

// Bootstrap Firebase Admin
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
const PLATFORM_DOCS_COLLECTION = "platformDocs";

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embeddings API error: ${await response.text()}`);
  }

  const data = await response.json();
  return data.data.map((item: { embedding: number[] }) => item.embedding);
}

async function run() {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in .env.local");
  }

  // Read FAQ data from en.json
  const enJsonPath = path.join(process.cwd(), "messages", "en.json");
  const enJson = JSON.parse(fs.readFileSync(enJsonPath, "utf-8"));
  const faqs: Record<string, { id: number; category: string; question: string; answer: string }> =
    enJson.FAQ.faqs;

  const faqList = Object.values(faqs);
  console.log(`Found ${faqList.length} FAQ entries in messages/en.json`);

  // Embed all questions
  console.log("Generating embeddings...");
  const texts = faqList.map((f) => `Question: ${f.question}`);
  const embeddings = await embedTexts(texts);
  console.log(`Generated ${embeddings.length} embeddings.`);

  // Write to Firestore in a single batch
  console.log(`Writing to Firestore collection: ${PLATFORM_DOCS_COLLECTION}...`);
  const batch = db.batch();

  faqList.forEach((faq, i) => {
    const docRef = db.collection(PLATFORM_DOCS_COLLECTION).doc(String(faq.id));
    batch.set(docRef, {
      id: faq.id,
      category: faq.category,
      question: faq.question,
      answer: faq.answer,
      embedding: embeddings[i],
      source: "en.json",
      updatedAt: new Date(),
    });
  });

  await batch.commit();
  console.log(`✓ ${faqList.length} documents written to '${PLATFORM_DOCS_COLLECTION}'.`);
  console.log("\nThe platformKnowledgeTool in agents/chatGraph.ts will now use Firestore.");
  console.log("You can add new docs to the 'platformDocs' collection at any time without redeploying.");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
