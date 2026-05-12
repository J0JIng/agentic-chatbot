# Architecture Overview

This document covers the high-level design of the Journey Chatbot system: its execution model, API surface, technology stack, data stores, and full requirements traceability. For implementation detail on individual features, refer to [frontend.md](./frontend.md) and [backend.md](./backend.md).

If you are new to the project, start with [getting-started.md](./getting-started.md) for local setup, environment variables and a platform overview.

---

## 0. Term Dictionary

This section defines terms that have a specific meaning within this system. Use these definitions consistently across all files in `docs/notes/`. Do not substitute synonyms for defined terms.

### Structural terms

| Term | Definition |
|------|-----------|
| **Layer** | One of six architectural tiers of the system: UI, API, Agent Pipeline, Retrieval, Profiling, Data. Used exclusively in the Architectural Layers table (Section 1). |
| **Component** | A technology entry in the Technology Stack table (Section 3). |
| **Category** | A functional grouping of files in the Codebase File Reference table (Section 5). |
| **Stage** | A discrete validation step within a guard (e.g. the three stages of the Input Guard Agent). Not the same as a layer. |
| **Node** | A unit within the LangGraph `StateGraph` graph (e.g. `InputGuardNode`, `ControllerNode`). |
| **Agent** | The TypeScript module that implements a node's logic (e.g. `inputGuardAgent.ts`). An agent and a node are related but distinct: the node is the graph vertex; the agent is the code that runs inside it. |
| **Pipeline** | The full end-to-end LangGraph `StateGraph` execution flow, from `InputGuardNode` to `OutputGuardNode`. Do not use "pipeline" to refer to sub-processes such as the retrieval pipeline; use "process" or describe it specifically instead. |

### Requirement and feature identifiers

| Term | Definition |
|------|-----------|
| **FR-XX** | A functional requirement. Defines what the system must do. Full list in Section 6. |
| **NFR-XX** | A non-functional requirement. Defines constraints on how the system behaves. Full list in Section 7. |
| **UC-XX** | A use case. Defines an interaction between an actor and the system. Full list in Section 8. |
| **F-XX** | A feature. A distinct implementation unit tracked in the Feature Traceability Matrix (Section 9). F-01 to F-19 are frontend features; F-20 to F-44 are backend features. |

### Actor terms

| Term | Definition |
|------|-----------|
| **Authenticated Learner** | A registered user who is signed in via Firebase Auth. |
| **Anonymous Guest** | An unauthenticated visitor. Permitted at the API layer but the chat trigger is hidden in the UI. |
| **System** | Vercel's `waitUntil` serverless runtime primitive, acting as a background task scheduler. |

### System-specific terms

| Term | Definition |
|------|-----------|
| **SSE** | Server-Sent Events. The streaming transport used to deliver agent responses to the client in real time. |
| **BM25** | A lexical (sparse) retrieval algorithm used alongside dense embedding search in the hybrid retrieval process. Parameters: k₁ = 1.5, b = 0.75. |
| **RRF** | Reciprocal Rank Fusion. Merges ranked lists from dense and BM25 retrieval into a single unified ranking. Parameter: k = 60. |
| **MMR** | Maximal Marginal Relevance. Selects a diverse final set of courses by balancing relevance against similarity to already-selected results. Parameters: λ = 0.8, k = 8. |
| **RAG** | Retrieval-Augmented Generation. The pattern used in the Platform Knowledge tool: a relevant document is retrieved from Firestore and prepended to the LLM prompt as grounding context. |
| **`aiProfile`** | The Firestore sub-document under `users/{uid}` that stores inferred user interests, interest weights and cognitive level. Written exclusively by the Profiling layer. |
| **`EffectiveUserProfile`** | The merged profile object built at request time by `lib/userProfileService.ts`, combining `aiProfile.inferredInterests` and `userData.skills`. |
| **`waitUntil`** | Vercel's serverless runtime primitive that schedules a background task after the HTTP response has been sent. Used to run profiling off the critical path. |
| **Circuit Breaker** | A resilience pattern that stops forwarding requests to a failing service (OpenAI API) once a failure threshold is reached, and automatically retries after a recovery window. States: `CLOSED` (normal), `OPEN` (failing fast). |

---

## 1. System Architecture

The chatbot is implemented as a multi-agent pipeline in TypeScript. It runs as a single process within the Next.js 14 serverless environment and is exposed through the `POST /api/chat` endpoint.

Each incoming request is handled in an isolated, stateless serverless invocation. No mutable state is shared across requests, which eliminates cross-user state contention and simplifies the concurrency model.

A request follows five steps from ingress to completion:

| Step | Name | Description |
|------|------|-------------|
| 1 | Ingress | The client sends an `HTTP POST` request with an `Authorization` header. The request body contains the conversation history as a JSON array of message objects. |
| 2 | Authentication and Rate Limiting | The server verifies the Firebase ID token and checks the request against the rate limiter. Anonymous requests are permitted but subject to a stricter limit. See [backend.md F-36](./backend.md#f-36-rate-limiter) and [backend.md F-42](./backend.md#f-42-security-and-identity). |
| 3 | Multi-Agent Pipeline Execution | A LangGraph `StateGraph` orchestrates the multi-agent logic to produce a response. See [backend.md F-20](./backend.md#f-20-6-node-langgraph-stategraph). |
| 4 | Egress via SSE | The agent's response is streamed to the client using Server-Sent Events (SSE), which reduces perceived latency. See [frontend.md F-40](./frontend.md#f-40-communication-protocols-sse-and-json-leak-filter). |
| 5 | Async Post-Processing | The user's interest profile is updated asynchronously via Vercel's `waitUntil`. This runs off the critical path and does not affect egress latency. See [backend.md F-43](./backend.md#f-43-post-processing-and-persistence). |

### Architectural Layers

The system is organised into six layers. Each layer has a distinct responsibility and communicates with adjacent layers only.

| Layer | Responsibility | Key Files |
|-------|---------------|-----------|
| **UI** | Renders the chat panel, ingests SSE events, manages session state and handles user interactions | `components/chatbot_components/Chatbot.tsx`, `ChatbotShell.tsx`, `TextSelectionHandler.tsx` |
| **API** | Receives HTTP requests, verifies authentication, enforces rate limits, checks the circuit breaker and emits the SSE stream | `app/api/chat/route.ts`, `app/api/chat/feedback/route.ts` |
| **Agent Pipeline** | Validates input, classifies intent, routes to the correct specialist node, generates a response and validates output | `agents/chatGraph.ts`, `agents/controllerAgent.ts`, `agents/inputGuardAgent.ts`, `agents/outputGuardAgent.ts` |
| **Retrieval** | Performs hybrid course search (dense cosine, BM25, RRF), reranking and MMR diversity filtering; also handles platform FAQ retrieval via RAG | `lib/courseEmbeddingSearch.ts`, `agents/chatGraph.ts` |
| **Profiling** | Extracts learning interest signals from the conversation and writes an updated `aiProfile` to Firestore; runs asynchronously off the critical path | `agents/profileObserverAgent.ts`, `agents/profileAuditorAgent.ts`, `lib/userProfileService.ts`, `lib/enrollmentProfilingService.ts` |
| **Data** | Provides persistent storage (Firestore) and ephemeral cache and operational state (Redis) | `lib/firebaseAdmin.ts`, `lib/redis.ts`, `lib/rateLimiter.ts`, `lib/circuitBreaker.ts` |

---

## 2. API Design

The chatbot backend is exposed through two endpoints.

| No. | Endpoint | Method | Description |
|-----|----------|--------|-------------|
| 1 | `/api/chat` | POST | Submits a message to the multi-agent pipeline. Auth: Firebase ID token (anonymous allowed). Body: `{ messages: [{ role, content }], data?: { ... } }`. Response: `text/event-stream`. Errors: 400, 401, 429, 500. |
| 2 | `/api/chat/feedback` | POST | Persists a thumbs-up or thumbs-down rating for a response. Auth: Firebase ID token (required). Body: `{ messageId, rating: "up" \| "down", ... }`. Response: `{ success: true }`. Errors: 400, 401, 500. |

The feedback endpoint is idempotent per `(userId, messageId)` pair.

---

## 3. Technology Stack

| Component | Technology | Role |
|-----------|------------|------|
| Runtime | Next.js 14 | App Router serverless API routes and React-based client-side hosting |
| Orchestration | LangGraph | 6-node directed `StateGraph` pipeline for multi-agent orchestration and routing |
| Inference | OpenAI `gpt-4o-mini` | Intent classification and response generation |
| Inference | OpenAI `text-embedding-3-small` | 1,536-dimensional query embedding for dense cosine retrieval |
| Inference | OpenAI Moderation API | 11-category harm classification applied to both input and output |
| Datastore | Firestore | User profiles and course corpus; accessed via Firebase Admin SDK on the server |
| Caching | Upstash Redis | Shared recommendation results and platform docs; rate-limit counters and circuit breaker state |
| Caching | Vercel Data Cache | Top-500 free courses by enrolment (`unstable_cache`, 24-hour TTL) |
| Caching | In-process memory | 46 MB course embedding corpus and BM25 index (24-hour TTL per instance) |
| Auth | Firebase Auth | Client-side JWT token issuance; server-side Admin SDK verification |
| Observability | LangSmith | Per-LLM node distributed tracing (active when `LANGCHAIN_TRACING_V2=true`) |
| Observability | Vercel Logs | Structured JSON logs emitted via `lib/logger.ts` |
| UI | React 18 | Tailwind CSS and Radix UI for styling; Framer Motion for panel transitions and message animations |

---

## 4. Data Modelling

### Firestore

The chatbot reads from and writes to the following Firestore collections. All writes use merge operations to avoid overwriting unrelated fields.

| Collection | Read | Write | Notes |
|------------|------|-------|-------|
| `users/{uid}` | Yes | Yes | Merge-only write to the `aiProfile` sub-document. All other user fields are read-only from the pipeline's perspective. |
| `coursesV2/{courseId}` | Yes | No | Free-tier course catalogue. Primary source for embedding retrieval and recommendation ranking. |
| `paidCourses/{courseId}` | Yes | No | Paid-tier catalogue. Merged with `coursesV2` results during retrieval. |
| `platformDocs/{docId}` | Yes | No | Platform FAQ and documentation. Redis-cached on miss with a 3,600-second TTL. |
| `chatFeedback/{autoId}` | Yes | Yes | An idempotency read on `(userId, messageId)` is performed before appending a new feedback document. |

### Redis

All keys use the `chatbot:` prefix to isolate pipeline keys from other application data in the same Redis instance.

| Key Pattern | Stored Value | TTL |
|-------------|-------------|-----|
| `chatbot:platform_docs` | Serialised `PlatformDoc[]` fetched from the `platformDocs` Firestore collection; shared across all instances | 3,600 s |
| `chatbot:rec:{userId}:{query}` | Serialised `ScoredCourse[]` output of the full embed-retrieve-rerank pipeline for a specific user and query pair | 300 s |
| `chatbot:rl:{userId\|anon}` | Integer request counter incremented atomically via `INCR`; `EXPIRE` set only on first increment to fix the window boundary | 60 s |
| `chatbot:cb:failures` | Integer failure counter for OpenAI API errors within the current counting window | 30 s |
| `chatbot:cb:open_until` | Unix timestamp (ms) marking when the `OPEN` state expires and the circuit auto-resets to `CLOSED` | 60 s |

---

## 5. Codebase File Reference

All paths are relative to `fyp_codebase/Lifelong-Learning-App/`.

| Category | File | Description |
|----------|------|-------------|
| API | `app/api/chat/route.ts` | SSE stream handler, authentication, rate limiting, circuit breaker, pipeline orchestration and post-processing |
| API | `app/api/chat/feedback/route.ts` | Persists thumbs-up/down ratings to the Firestore `chatFeedback` collection |
| Agent Pipeline | `agents/chatGraph.ts` | LangGraph `StateGraph` definition (6 nodes), course embedding search, BM25, RRF, MMR and platform RAG tool |
| Agent Pipeline | `agents/controllerAgent.ts` | `handleMessage()` orchestrator, SSE event emission, speculative pre-execution and streaming |
| Agent Pipeline | `agents/inputGuardAgent.ts` | 4-stage input validation: input length limit, Rule Engine, OpenAI Moderation API and LLM classifier |
| Agent Pipeline | `agents/outputGuardAgent.ts` | 4-stage output validation: Rule Engine, Moderation API, grounding heuristic and LLM classifier |
| Agent Pipeline | `agents/userProfilingAgent.ts` | Profiling orchestrator: called via `waitUntil` off the critical path; invokes `observeSignals()` and `auditSignals()` in sequence, then writes the updated `aiProfile` to Firestore |
| Agent Pipeline | `agents/profileObserverAgent.ts` | Extracts raw learning interest signals from the conversation; called by `userProfilingAgent.ts` |
| Agent Pipeline | `agents/profileAuditorAgent.ts` | Deduplicates and validates raw signals before the profile write; called by `userProfilingAgent.ts` |
| Agent Pipeline | `agents/agentSetup.ts` | Singleton initialisation of the LangGraph `StateGraph` |
| Config | `agents/agentConfig.json` | Per-agent model ID, temperature, max tokens and system prompts |
| Config | `agents/pipelineConfig.json` | Guard thresholds, cache TTLs, rate-limit windows and circuit breaker settings |
| Config | `agents/rankingConfig.json` | Reranking signal weights, MMR lambda and candidate pool size |
| Retrieval | `lib/courseEmbeddingSearch.ts` | Hybrid retrieval pipeline: dense cosine similarity, BM25, RRF, 5-signal reranking and MMR diversity filtering |
| Profiling | `lib/userProfileService.ts` | Builds `EffectiveUserProfile` by merging `aiProfile.inferredInterests` and `userData.skills`; applies 30-day half-life decay |
| Profiling | `lib/enrollmentProfilingService.ts` | Updates the user profile on enrolment and completion events via `waitUntil` |
| Resilience | `lib/redis.ts` | Upstash Redis singleton; manages platform docs cache, recommendation cache, rate-limit counters and circuit breaker state |
| Resilience | `lib/rateLimiter.ts` | Fixed-window rate limiter (20 req/min for authenticated users, 5 req/min for anonymous users) |
| Resilience | `lib/circuitBreaker.ts` | Circuit breaker that trips after 5 failures in 30 seconds and auto-closes after 60 seconds |
| Observability | `lib/logger.ts` | Structured JSON logger captured by Vercel logs |
| Observability | `lib/moderationClient.ts` | OpenAI Moderation API wrapper covering 11 harm categories |
| Data | `lib/firebaseAdmin.ts` | Server-side Firebase Admin SDK for Firestore and Auth |
| Data | `lib/firebaseConfig.ts` | Client-side Firebase initialisation |
| UI | `components/chatbot_components/Chatbot.tsx` | Main chat UI: SSE ingestion, message rendering, session persistence, feedback buttons and accessibility handling |
| UI | `components/chatbot_components/ChatbotShell.tsx` | Chat widget container and open/close state management |
| UI | `components/chatbot_components/TextSelectionHandler.tsx` | Captures selected page text and injects it as chat context |
| UI | `context/authContext.tsx` | `useAuth()` hook exposing `user`, `loading`, `userRole` and `logout` |

---

## 6. Functional Requirements

| ID | Requirement | Limitation | Obj. |
|----|-------------|-----------|------|
| FR-1 | **Chat Panel Visibility.** The system shall provide a chat interface that can be displayed without obscuring primary page content. | L9 | O6 |
| FR-2 | **Contextual Suggestions.** The system shall surface context-relevant quick-action chips derived from the most recent assistant response. | L3, L5 | O4 |
| FR-3 | **Adaptive Input Field.** The system shall dynamically resize the text input area based on content length within usability limits. | L9 | O6 |
| FR-4 | **Query Routing.** The system shall route user queries to the appropriate specialist processing node based on classified intent. | L4 | O2 |
| FR-5 | **Intent Classification.** The system shall classify user input into one of five predefined categories: `recommendation`, `faq`, `general`, `comparison`, `learning_path`. | L4 | O2 |
| FR-6 | **Context-Enriched Responses.** The system shall incorporate user profile data and active page context into generated responses. | L3, L5, L6 | O4 |
| FR-7 | **Knowledge Retrieval.** The system shall retrieve relevant platform documentation to answer FAQ queries. | L2 | O1 |
| FR-8 | **Learning Path Generation.** The system shall generate structured three-tier learning roadmaps (Beginner / Intermediate / Advanced). | L4, L5 | O5 |
| FR-9 | **Learning Path Persistence.** The system shall allow authenticated users to save generated learning roadmaps to their Firestore profile. | L3, L5 | O4 |
| FR-10 | **Progress Tracking.** The system shall allow users to mark individual steps within a saved learning path as complete. | L3, L5 | O4 |
| FR-11 | **Response Recovery.** The system shall allow users to retry a failed streaming response while preserving any partially delivered content. | L9, L10 | O6 |
| FR-12 | **Feedback Collection.** The system shall allow users to submit positive or negative feedback on assistant messages and persist it in Firestore. | L8 | O6 |
| FR-13 | **Uncertainty Notification.** The system shall emit a visible hallucination warning banner when the output guard detects a high-risk response. | L2 | O3 |
| FR-14 | **Reasoning Transparency.** The system shall expose the multi-agent reasoning trace to the user as an opt-in disclosure, enabling inspection of intent classification, retrieval, curation and safety decisions for each response. | L2 | O3 |

---

## 7. Non-Functional Requirements

| ID | Requirement | Limitation | Obj. |
|----|-------------|-----------|------|
| NFR-1 | **Input Validation.** All user inputs shall pass a three-stage guard (Rule Engine, OpenAI Moderation API, LLM classifier) before reaching the agent pipeline. Any stage failure shall result in a denied request with no response generated. | L1 | O3 |
| NFR-2 | **PII Protection.** The output guard shall detect and block responses containing personally identifiable information patterns (NRIC, email, credit card, phone number, SSN). | L1 | O3 |
| NFR-3 | **Input Size Limitation.** The system shall reject inputs exceeding 2,000 characters before invoking any API. | L1 | O3 |
| NFR-4 | **Retrieval Performance.** The recommendation pipeline shall complete within a time budget suitable for conversational interaction. Speculative parallel pre-execution runs profile fetch, input validation and intent classification concurrently to minimise time-to-first-token. | L9 | O6 |
| NFR-5 | **Session Persistence.** Conversation history shall be persisted in `localStorage` under a per-session key so that messages survive page navigation and browser refresh within the same session. | L3 | O4 |
| NFR-6 | **Fault Isolation.** LLM and OpenAI API failures shall not terminate the stream abruptly. The circuit breaker shall serve a pre-built fallback response and close the stream cleanly. | L6, L8 | O6 |
| NFR-7 | **Keyboard Accessibility.** All interactive elements shall be reachable and operable via keyboard. Focus shall be trapped within the chat panel when it is open and the submit action shall trigger on Enter (without Shift). | — | — |
| NFR-8 | **Visual Accessibility.** Focus indicators shall use a brand-blue ring (`#10527c` on white, contrast ratio 8.23:1) meeting WCAG 2.4.7 and 2.4.11. | — | — |
| NFR-9 | **Touch Accessibility.** All interactive targets shall meet a minimum touch target size suitable for mobile use. | — | — |
| NFR-10 | **Concurrent Processing.** The system shall handle each request in an independent stateless serverless invocation with no shared mutable state. | L6 | O6 |

---

## 8. Use Cases

Actors:
- **Authenticated Learner:** A registered, signed-in user.
- **Anonymous Guest:** An unauthenticated visitor. Permitted at the API layer but the chat trigger is hidden in the UI when `isAuthenticated === false`.
- **System:** Vercel's `waitUntil` serverless runtime primitive, used for background tasks.

| ID | Use Case | Primary Actor | Secondary Actors | Linked Requirement | Detail |
|----|----------|--------------|-----------------|-------------------|--------|
| UC-0 | Submit Chat Message | Authenticated Learner, Anonymous Guest | Firebase Auth, OpenAI API, Firestore, Redis | FR-4, FR-5, FR-6, NFR-3, NFR-4, NFR-6, NFR-10 | [backend.md F-20](./backend.md#f-20-6-node-langgraph-stategraph) |
| UC-1 | Get Course Recommendations | Authenticated Learner, Anonymous Guest | OpenAI API, Firestore, Upstash Redis | FR-4, FR-5, FR-6, NFR-4 | [backend.md F-27](./backend.md#f-27-recommender-node) |
| UC-2 | Get Platform FAQ Answer | Authenticated Learner, Anonymous Guest | OpenAI API, Redis, Firestore | FR-5, FR-7, NFR-4 | [backend.md F-25](./backend.md#f-25-controller-node-faq-and-general-responses) |
| UC-3 | Generate Learning Path | Authenticated Learner, Anonymous Guest | OpenAI API, Redis | FR-5, FR-8, NFR-4 | [backend.md F-31](./backend.md#f-31-learning-path-node) |
| UC-4 | Compare Courses | Authenticated Learner, Anonymous Guest | OpenAI API, Redis | FR-4, FR-5, NFR-4 | [backend.md F-30](./backend.md#f-30-comparer-node) |
| UC-5 | Save Learning Path | Authenticated Learner | Firebase | FR-9 | [frontend.md F-07](./frontend.md#f-07-learning-path-save-and-progress-tracking) |
| UC-6 | Track Learning Progress | Authenticated Learner | Firestore | FR-10 | [frontend.md F-07](./frontend.md#f-07-learning-path-save-and-progress-tracking) |
| UC-7 | Submit Message Feedback | Authenticated Learner | Firestore | FR-12 | [frontend.md F-18](./frontend.md#f-18-action-buttons) |
| UC-8 | Stop Generation | Authenticated Learner, Anonymous Guest | — | FR-11 | [frontend.md F-11](./frontend.md#f-11-stop-generation) |
| UC-9 | Retry Failed Response | Authenticated Learner, Anonymous Guest | OpenAI API, Firestore, Redis | FR-11 | [frontend.md F-10](./frontend.md#f-10-streaming-error-recovery-and-retry) |
| UC-10 | Update Interest Profile | System | OpenAI API, Firestore | FR-6 | [backend.md F-32](./backend.md#f-32-user-profiling-pipeline-observer-and-auditor) |
| UC-11 | View Reasoning Trace | Authenticated Learner, Anonymous Guest | — | FR-14 | [frontend.md F-19](./frontend.md#f-19-reasoning-trace-popover) |

---

## 9. Feature Traceability Matrix

| ID | Feature | Linked FR / NFR / UC | Detail |
|----|---------|----------------------|--------|
| F-01 | Chat Panel Layout and Panel Management | FR-1, NFR-7, UC-0 | [frontend.md F-01](./frontend.md#f-01-chat-panel-layout-and-panel-management) |
| F-02 | Follow-up Question Pills | FR-2, UC-0 | [frontend.md F-02](./frontend.md#f-02-follow-up-question-pills) |
| F-03 | Text Selection and Context Injection | FR-6, UC-0 | [frontend.md F-03](./frontend.md#f-03-text-selection-and-context-injection) |
| F-04 | Starter Cards and Greeting | FR-2, FR-6 | [frontend.md F-04](./frontend.md#f-04-starter-cards-and-greeting) |
| F-05 | Course Card UI | UC-1, UC-4 | [frontend.md F-05](./frontend.md#f-05-course-card-ui) |
| F-06 | Personalised Learning Roadmap UI | FR-8, UC-3 | [frontend.md F-06](./frontend.md#f-06-personalised-learning-roadmap-ui) |
| F-07 | Learning Path Save and Progress Tracking | FR-9, FR-10, UC-5, UC-6 | [frontend.md F-07](./frontend.md#f-07-learning-path-save-and-progress-tracking) |
| F-08 | Comparer UI | FR-4, UC-4 | [frontend.md F-08](./frontend.md#f-08-comparer-ui) |
| F-09 | Session Persistence | NFR-5 | [frontend.md F-09](./frontend.md#f-09-session-persistence) |
| F-10 | Streaming Error Recovery and Retry | FR-11, UC-9 | [frontend.md F-10](./frontend.md#f-10-streaming-error-recovery-and-retry) |
| F-11 | Stop Generation | FR-11, UC-8 | [frontend.md F-11](./frontend.md#f-11-stop-generation) |
| F-12 | Keyboard and Visual Accessibility | NFR-7, NFR-8, NFR-9 | [frontend.md F-12](./frontend.md#f-12-keyboard-and-visual-accessibility) |
| F-13 | Error Boundary | NFR-6 | [frontend.md F-13](./frontend.md#f-13-error-boundary) |
| F-14 | Hallucination Warning Banner | FR-13 | [frontend.md F-14](./frontend.md#f-14-hallucination-warning-banner) |
| F-15 | Markdown Rendering with Syntax Highlighting | FR-6 | [frontend.md F-15](./frontend.md#f-15-markdown-rendering-with-syntax-highlighting) |
| F-16 | Auto-resizing Textarea | FR-3 | [frontend.md F-16](./frontend.md#f-16-auto-resizing-textarea) |
| F-17 | Scroll-to-Bottom and Auto-scroll | FR-1 | [frontend.md F-17](./frontend.md#f-17-scroll-to-bottom-and-auto-scroll) |
| F-18 | Action Buttons | FR-9, FR-11, FR-12, UC-5, UC-7, UC-9 | [frontend.md F-18](./frontend.md#f-18-action-buttons) |
| F-19 | Reasoning Trace Popover | FR-14, UC-11 | [frontend.md F-19](./frontend.md#f-19-reasoning-trace-popover) |
| F-20 | 6-Node LangGraph StateGraph | FR-4, FR-5, NFR-10, UC-0 | [backend.md F-20](./backend.md#f-20-6-node-langgraph-stategraph) |
| F-21 | Speculative Parallel Pre-Execution | NFR-4, UC-0 | [backend.md F-21](./backend.md#f-21-speculative-parallel-pre-execution) |
| F-22 | Input Guard Agent | NFR-1, NFR-3, UC-0 | [backend.md F-22](./backend.md#f-22-input-guard-agent) |
| F-23 | Output Guard Agent | NFR-1, NFR-2, FR-13, UC-0 | [backend.md F-23](./backend.md#f-23-output-guard-agent) |
| F-24 | Intent Classification and Routing | FR-4, FR-5, UC-0 | [backend.md F-24](./backend.md#f-24-intent-classification-and-routing) |
| F-25 | Controller Node: FAQ and General Responses | FR-6, FR-7, UC-2 | [backend.md F-25](./backend.md#f-25-controller-node-faq-and-general-responses) |
| F-26 | Platform Knowledge RAG Tool | FR-7, UC-2 | [backend.md F-26](./backend.md#f-26-platform-knowledge-rag-tool) |
| F-27 | Recommender Node | FR-4, FR-6, UC-1 | [backend.md F-27](./backend.md#f-27-recommender-node) |
| F-28 | Hybrid Retrieval Engine: Dense, BM25, RRF | FR-7, NFR-4, UC-1 | [backend.md F-28](./backend.md#f-28-hybrid-retrieval-engine-dense-bm25-rrf) |
| F-29 | Content Reranking and MMR | FR-6, UC-1 | [backend.md F-29](./backend.md#f-29-content-reranking-and-mmr) |
| F-30 | Comparer Node | FR-4, UC-4 | [backend.md F-30](./backend.md#f-30-comparer-node) |
| F-31 | Learning Path Node | FR-8, UC-3 | [backend.md F-31](./backend.md#f-31-learning-path-node) |
| F-32 | User Profiling Pipeline: Observer and Auditor | FR-6, UC-10 | [backend.md F-32](./backend.md#f-32-user-profiling-pipeline-observer-and-auditor) |
| F-33 | Context Window Management | FR-6, UC-0 | [backend.md F-33](./backend.md#f-33-context-window-management) |
| F-34 | Firestore Schema and Data Modelling | FR-6, FR-9 | [backend.md F-34](./backend.md#f-34-firestore-schema-and-data-modelling) |
| F-35 | Three-Tier Caching Layer | NFR-4 | [backend.md F-35](./backend.md#f-35-three-tier-caching-layer) |
| F-36 | Rate Limiter | NFR-10, UC-0 | [backend.md F-36](./backend.md#f-36-rate-limiter) |
| F-37 | Circuit Breaker | NFR-6, UC-0 | [backend.md F-37](./backend.md#f-37-circuit-breaker) |
| F-38 | Graceful Degradation | NFR-4, NFR-6 | [backend.md F-38](./backend.md#f-38-graceful-degradation) |
| F-39 | Traceability and Observability | FR-6, UC-1 | [backend.md F-39](./backend.md#f-39-traceability-and-observability) |
| F-40 | Communication Protocols: SSE and JSON Leak Filter | NFR-4, NFR-6, UC-0 | [backend.md F-40](./backend.md#f-40-communication-protocols-sse-and-json-leak-filter) |
| F-41 | State and Session Management | NFR-5, NFR-10 | [backend.md F-41](./backend.md#f-41-state-and-session-management) |
| F-42 | Security and Identity | NFR-1, NFR-2, UC-0 | [backend.md F-42](./backend.md#f-42-security-and-identity) |
| F-43 | Post-Processing and Persistence | FR-6, FR-9, UC-5, UC-10 | [backend.md F-43](./backend.md#f-43-post-processing-and-persistence) |
| F-44 | Deployment Infrastructure | NFR-10 | [backend.md F-44](./backend.md#f-44-deployment-infrastructure) |
