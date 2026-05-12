/**
 * SERVER-ONLY Firebase Admin bootstrap.
 *
 * Purpose:
 * - Initializes the Firebase Admin SDK exactly once per server runtime (handles warm starts).
 * - Exposes `db` (Firestore Admin) and `adminAuth` (Admin Auth) for use in server contexts:
 *   - Next.js Route Handlers (app/api/../route.ts)
 *   - Server Components / Server Actions
 *
 * Notes:
 * - DO NOT import this file from any `"use client"` component — it will break the client bundle.
 * - In production (Vercel), credentials should come from env vars:
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
 * - The JSON service account require() is a local/dev fallback only.
 * - Caching (Vercel Data Cache via `unstable_cache`) should be applied where reads happen,
 *   e.g. in server fetch functions or route handlers, not in this bootstrap file.
 */

import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function getPrivateKey() {
  // Vercel env vars often store \n as \\n
  return process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
}

function initAdminApp() {
  if (admin.apps.length) return admin.apps[0]!;

  // Env cars for Vercel
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = getPrivateKey();

  if (projectId && clientEmail && privateKey) {
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }
}

const app = initAdminApp();
export const db = getFirestore(app);
export const adminAuth = getAuth(app);
