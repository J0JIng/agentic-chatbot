# Getting Started

This guide covers what you need to know on day one: what the platform is, how to run it locally, what the environment variables do and where the chatbot fits within the broader codebase.

---

## 1. What is Journey

Journey is a lifelong learning platform where learners can browse and enrol in courses, track their progress and communicate with instructors. The platform supports two user roles:

| Role | Description |
|------|-------------|
| **Learner** | Browses and enrols in courses, tracks progress, saves learning paths |
| **Instructor** | Creates and manages courses, communicates with enrolled learners |

The AI chatbot is one feature within this platform. It lives in the bottom-right corner of every page and gives learners personalised course recommendations, learning path generation, platform FAQ answers and course comparisons.

---

## 2. Scope of these notes

The files in `docs/notes/` cover the chatbot subsystem only:

- `architecture.md` — system design, API, requirements, use cases, traceability
- `backend.md` — backend features F-20 to F-44 (the agent pipeline, retrieval, caching, resilience)
- `frontend.md` — frontend features F-01 to F-19 (the chat UI, SSE ingestion, accessibility)

The broader platform (course CRUD, enrolment, payments, messaging, admin panel, internationalisation) is not covered here. For those areas, read the route handlers in `app/api/` directly — they follow the same Next.js App Router pattern and use Firebase Admin SDK without an ORM.

---

## 3. Prerequisites

- Node.js 18 or later
- A `.env.local` file in `fyp_codebase/Lifelong-Learning-App/` (see Section 5)

There are no automated tests in this project. Verification is done by running the dev server and exercising the chatbot manually.

---

## 4. Local setup

All commands run from `fyp_codebase/Lifelong-Learning-App/`.

```bash
# 1. Install dependencies
npm install

# 2. If npm reports high-severity vulnerabilities after install, fix them:
npm audit fix
# If that fails with an ERESOLVE error:
npm audit fix --legacy-peer-deps

# 3. Start the development server
npm run dev
```

Open `http://localhost:3000` in a browser. Sign in with a learner account to access the chatbot.

### What `npm run dev` does

The `predev` npm hook runs `scripts/write-firebase-key.cjs` before Next.js starts. This script reads the Firebase credentials from your environment variables and writes them to `lib/config/firebase-service-account.json`, which `lib/firebaseAdmin.ts` loads at runtime. You do not need to create this file manually.

The script accepts credentials in two forms:

- A single `FIREBASE_SERVICE_ACCOUNT` variable containing the full service account JSON as a one-line string, **or**
- Three separate variables: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`

If neither form is present, the script skips key generation and logs a warning. The server will start but server-side Firestore and Auth calls will fail.

---

## 5. Environment variables

Create a file named `.env.local` in `fyp_codebase/Lifelong-Learning-App/` with the variables below. Variables marked **Required** will cause runtime errors if absent. Variables marked **Optional** degrade gracefully.

### Firebase (client-side)

These are public values used by the browser to initialise Firebase Auth and Firestore. Find them in the Firebase console under Project Settings.

| Variable | Required | Notes |
|----------|----------|-------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Required | |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Required | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Required | |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Required | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Required | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Required | |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Optional | Only needed for Google Analytics |

### Firebase (server-side Admin SDK)

Used by the `predev` hook to write `lib/config/firebase-service-account.json`. Download the service account JSON from Firebase console under Project Settings → Service accounts → Generate new private key.

| Variable | Required | Notes |
|----------|----------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | Required (if not using the three separate vars below) | Full service account JSON as a single-line string |
| `FIREBASE_PROJECT_ID` | Required (alternative to `FIREBASE_SERVICE_ACCOUNT`) | |
| `FIREBASE_CLIENT_EMAIL` | Required (alternative to `FIREBASE_SERVICE_ACCOUNT`) | |
| `FIREBASE_PRIVATE_KEY` | Required (alternative to `FIREBASE_SERVICE_ACCOUNT`) | Paste the PEM key including the `-----BEGIN PRIVATE KEY-----` header |

### OpenAI

Used by the agent pipeline for inference, embeddings and moderation. Create a key at platform.openai.com.

| Variable | Required | Notes |
|----------|----------|-------|
| `OPENAI_API_KEY` | Required | All LLM calls, embeddings and moderation fail without this |

### Upstash Redis

Used for shared recommendation cache, platform docs cache, rate-limit counters and circuit breaker state. Create a Redis database at console.upstash.com and copy the REST URL and token.

| Variable | Required | Notes |
|----------|----------|-------|
| `UPSTASH_REDIS_REST_URL` | Optional | Without this, platform docs and recommendation results fall back to direct Firestore reads on every cold start. Rate limiting and the circuit breaker also fall back gracefully. |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Required alongside `UPSTASH_REDIS_REST_URL` |

### LangSmith (observability)

Used for distributed LLM tracing. Create a project at smith.langchain.com. All four variables must be set together; omitting any one disables tracing silently.

| Variable | Required | Notes |
|----------|----------|-------|
| `LANGSMITH_TRACING` | Optional | Set to `true` to enable |
| `LANGSMITH_ENDPOINT` | Optional | `https://api.smith.langchain.com` |
| `LANGSMITH_API_KEY` | Optional | |
| `LANGSMITH_PROJECT` | Optional | Name of your LangSmith project |

### Stripe

Used for course payment and subscription flows. These are not required to use the chatbot. Obtain test keys from the Stripe dashboard.

| Variable | Required | Notes |
|----------|----------|-------|
| `STRIPE_TEST_SECRET` | Optional (for chatbot work) | Required for payment routes |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Optional (for chatbot work) | Required for payment UI |

### Email

Used by the admin notification system. Not required for chatbot development.

| Variable | Required | Notes |
|----------|----------|-------|
| `EMAIL_USER` | Optional (for chatbot work) | Gmail address used as the sender |
| `EMAIL_PASSWORD` | Optional (for chatbot work) | Gmail app password (not your account password) |
| `ADMIN_EMAIL` | Optional (for chatbot work) | Recipient for admin notifications |

### Application URL

| Variable | Required | Notes |
|----------|----------|-------|
| `NEXT_PUBLIC_APP_URL` | Required | Set to `http://localhost:3000` for local development |

---

## 6. Data pipeline scripts

These are one-time setup scripts, not part of regular development. Run them with `tsx` via npm scripts from `fyp_codebase/Lifelong-Learning-App/`.

| Script | Command | When to run |
|--------|---------|-------------|
| Generate course embeddings | `npm run generate-embeddings` | Run once when the course corpus changes. Computes 1,536-dimensional embeddings for every course and uploads them to Firestore. The in-process embedding cache used by the retrieval pipeline is built from these stored vectors. |
| Migrate platform docs | `npm run migrate-faq` | Run once when FAQ or platform documentation content changes. Writes documents to the `platformDocs` Firestore collection used by the Platform Knowledge RAG tool. |
| Precompute co-enrolment scores | `npm run precompute-coenrollment` | Run when collaborative filtering data needs refreshing. Computes co-enrolment similarity scores between courses and stores them for use in recommendation reranking. |

You do not need to run these scripts to develop against the chatbot if the Firestore database already contains course and platform doc data.

---

## 7. Auth and roles

Firebase Auth handles authentication on both the client and server.

**Client side:** `context/authContext.tsx` provides a `useAuth()` hook that exposes `{ user, loading, userRole, logout }`. The `userRole` field is fetched from Firestore (`users/{uid}.role`) and is either `"learner"` or `"instructor"`. Route protection is handled by wrapper components in `components/guards/`.

**Server side:** API route handlers call `lib/firebaseAdmin.ts` to verify the Firebase ID token from the `Authorization: Bearer <token>` header. The chatbot API (`POST /api/chat`) permits anonymous requests but applies a stricter rate limit (5 req/min vs 20 req/min for authenticated users). The chat trigger button is hidden in the UI when the user is not authenticated.

---

## 8. Serverless cold start behaviour

The app runs as serverless functions on Vercel. Understanding the serverless lifecycle explains why the caching layer exists:

- Each request may land on a **warm instance** (a previously used function container) or a **cold start** (a freshly initialised container).
- The 46 MB course embedding corpus and BM25 index are loaded into in-process memory on first use and cached for 24 hours. A cold start pays the full load cost; subsequent requests on the same instance reuse the cached corpus.
- The Upstash Redis shared cache (platform docs and recommendation results) survives across instances, so a cache hit on Redis avoids both the Firestore read and the embedding computation regardless of whether the instance is warm.
- If Redis is unavailable, all Redis-dependent features (rate limiting, circuit breaker, recommendation cache, platform docs cache) fail open: requests proceed using direct Firestore reads.

This tiered strategy is documented in detail in [backend.md F-35](./backend.md#f-35-three-tier-caching-layer).

---

## Referenced files

All paths are relative to `fyp_codebase/Lifelong-Learning-App/`.

| File | Description |
|------|-------------|
| `lib/firebaseAdmin.ts` | Server-side Firebase Admin SDK; loaded by the `predev` hook to verify tokens and access Firestore |
| `context/authContext.tsx` | `useAuth()` hook exposing `user`, `loading`, `userRole` and `logout` |
