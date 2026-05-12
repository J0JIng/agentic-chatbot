/**
 * SERVER-ONLY course data helpers.
 * 
 * Single source of truth for server-side course fetching + caching.
 *
 * This module contains server-side Firestore queries that can be wrapped in Vercel Data Cache
 * via `unstable_cache` to reduce Firestore reads across users/sessions.
 *
 * Firebase has a daily read/write limit which quickly gets exhausted when retrieving large number of courses
 * Do not import this file from "use client" components.
 */

import { unstable_cache } from "next/cache";
import { db } from "@/lib/firebaseAdmin";

const FREE_COURSES_TOTAL = 500;     // <-- how many free courses to fetch from Firebase (cloud) to cache in application server
const CACHE_REVALIDATE_SECONDS = 86400; // <-- Set how often to refresh the cache and fetch from database again (seconds)

// Cached: all free courses from external vendors for homepage (shared cache across users)
export const getVendorFreeCoursesCached = unstable_cache(
  async () => {
    console.log("[vendorFree] CACHE MISS -> querying Firestore"); //log to check how many times we make fetch from firebase

    // Split the limit between top vendors to ensure variety (e.g. if Coursera has many more courses than edX, we don't want the feed to be 80% Coursera)
    const perVendor = Math.ceil(FREE_COURSES_TOTAL / 2);

    const [courseraSnap, edxSnap] = await Promise.all([
      db.collection("coursesV2")
        .where("source", "==", "coursera")
        .orderBy("enrolled", "desc")
        .limit(perVendor)
        .get(),
      db.collection("coursesV2")
        .where("source", "==", "edx")
        .orderBy("enrolled", "desc")
        .limit(perVendor)
        .get(),
    ]);

    const docs = [...courseraSnap.docs, ...edxSnap.docs];

    // Trim in case perVendor * 2 > FREE_COURSES_TOTAL
    return docs.slice(0, FREE_COURSES_TOTAL).map((d) => ({ id: d.id, ...d.data() }));
  },
  ["courses", "feed:vendorFree", `total:${FREE_COURSES_TOTAL}`, "v1"],
  { revalidate: CACHE_REVALIDATE_SECONDS }
);