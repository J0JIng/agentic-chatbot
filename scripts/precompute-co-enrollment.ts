/**
 * scripts/precompute-co-enrollment.ts
 *
 * Precomputes per-course enrollment counts from the Firestore `enrollments`
 * collection and writes normalised `coEnrollmentScore` values back to each course
 * document in `coursesV2` and `paidCourses`.
 *
 * Run after significant enrollment growth (e.g., monthly or when adding >100 new users):
 *   npm run precompute-coenrollment
 *
 * Why this matters:
 *   The `enrolled` field stored on course documents is often stale (set at import time
 *   from external sources) and does not reflect actual enrollments within this platform.
 *   This script counts real platform enrollments per course from the `enrollments`
 *   collection and normalises the result to [0, 1] using log normalization:
 *
 *     coEnrollmentScore = log(1 + count) / log(1 + max_count)
 *
 *   Log normalisation prevents the most-popular course from dominating.
 *   This is used in contentRerank() as a 0.05-weight collaborative filtering signal.
 *
 * Future work: True item-item collaborative filtering (course co-occurrence matrix)
 *   can replace this popularity proxy when the user base grows to >500 learners.
 *   Co-occurrence: for each pair (A, B) where a user enrolled in both, increment
 *   coCount[A][B]. Normalised co-count can then replace raw enrollment count here.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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

// Firestore batch write limit
const BATCH_SIZE = 400;

async function main() {
  console.log("[precompute-coenrollment] Starting...");

  // ---------------------------------------------------------------------------
  // Step 1 — Aggregate enrollment counts from the `enrollments` collection
  // ---------------------------------------------------------------------------

  console.log("[precompute-coenrollment] Reading enrollments collection...");
  const enrollmentsSnap = await db
    .collection("enrollments")
    .where("status", "==", "active")
    .get();

  const enrollmentCounts = new Map<string, number>();

  for (const doc of enrollmentsSnap.docs) {
    const data = doc.data();
    const courseId = data?.courseId as string | undefined;
    if (!courseId) continue;
    enrollmentCounts.set(courseId, (enrollmentCounts.get(courseId) ?? 0) + 1);
  }

  console.log(
    `[precompute-coenrollment] Found ${enrollmentCounts.size} distinct courses with active enrollments (total docs: ${enrollmentsSnap.size}).`
  );

  if (enrollmentCounts.size === 0) {
    console.log(
      "[precompute-coenrollment] No active enrollments found. Nothing to write. Done."
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2 — Log-normalise counts to [0, 1]
  //
  // log(1 + count) / log(1 + max_count)
  // Prevents the most-enrolled course from score=1 dominating; compresses
  // the long tail of low-enrollment courses above 0.
  // ---------------------------------------------------------------------------

  const maxCount = Math.max(...enrollmentCounts.values());
  console.log(
    `[precompute-coenrollment] Max enrollment count: ${maxCount} — normalising...`
  );

  const normalised = new Map<string, number>();
  for (const [courseId, count] of enrollmentCounts) {
    const score =
      maxCount > 0
        ? Math.log1p(count) / Math.log1p(maxCount)
        : 0;
    normalised.set(courseId, parseFloat(score.toFixed(6)));
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Write coEnrollmentScore to coursesV2 and paidCourses
  //
  // Only updates courses that have an enrollment record — courses with zero
  // platform enrollments remain at coEnrollmentScore=0 (field absent → treated
  // as 0 in contentRerank() fallback logic).
  // ---------------------------------------------------------------------------

  const COLLECTIONS = ["coursesV2", "paidCourses"] as const;
  let totalUpdated = 0;

  for (const collectionName of COLLECTIONS) {
    console.log(`[precompute-coenrollment] Writing to collection: ${collectionName}`);

    // Build batches
    const entries = Array.from(normalised.entries());
    let batchCount = 0;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = entries.slice(i, i + BATCH_SIZE);

      for (const [courseId, score] of chunk) {
        const ref = db.collection(collectionName).doc(courseId);
        batch.update(ref, {
          coEnrollmentScore: score,
          coEnrollmentUpdatedAt: FieldValue.serverTimestamp(),
        });
      }

      try {
        await batch.commit();
        batchCount++;
        totalUpdated += chunk.length;
      } catch (err: any) {
        // A batch.update() on a non-existent doc throws — this is expected
        // for courseIds that exist in enrollments but not in this collection.
        // Log and continue; the score for that courseId simply isn't written here.
        console.warn(
          `[precompute-coenrollment] Batch ${batchCount} partial failure (likely doc not in ${collectionName}):`,
          err?.message ?? err
        );
      }
    }

    console.log(
      `[precompute-coenrollment] ${collectionName}: wrote ${entries.length} scores in ${Math.ceil(entries.length / BATCH_SIZE)} batch(es).`
    );
  }

  console.log(
    `[precompute-coenrollment] Done. ${totalUpdated} course×collection writes attempted. ` +
    `Run 'npm run generate-embeddings' to keep the embedding cache consistent.`
  );
}

main().catch((err) => {
  console.error("[precompute-coenrollment] Fatal error:", err);
  process.exit(1);
});
