import { EffectiveUserProfile } from "@/lib/userProfileService";
import { db } from "@/lib/firebaseAdmin";
import { log } from "@/lib/logger";
import rankingConfig from "@/agents/rankingConfig.json";

/** A course document with its pre-computed embedding vector. */
export interface CourseWithEmbedding {
  id: string;
  title: string;
  source: string;
  image_url?: string;
  url?: string;
  difficulty?: string;
  duration_hours?: number;
  skills?: string[];
  description?: string;
  enrolled?: number;
  isPaid?: boolean;           // true for paidCourses collection
  price?: number;             // price in SGD for paid courses
  coEnrollmentScore?: number; // precomputed collaborative filtering score (run precompute-coenrollment)
  embedding: number[];
}

/** A course with semantic and final reranking scores attached. */
export interface ScoredCourse extends CourseWithEmbedding {
  semanticScore: number;
  finalScore: number;
}

// In-process cache used instead of unstable_cache / Redis:
//   - unstable_cache has a 2 MB serialisation limit; the full corpus (~46 MB) exceeds it.
//   - Redis free-tier value limit (1 MB) also exceeded.
//   - Per-instance cache is an accepted trade-off for a single-instance deployment.

let _embeddingCache: CourseWithEmbedding[] | null = null;
let _embeddingCacheAt = 0;
const EMBEDDING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches all `coursesV2` (free) and `paidCourses` documents with an `embedding` field
 * from Firestore, using a 24h in-process cache.
 *
 * `getVendorFreeCoursesCached` is not reused: it predates embedding generation (no
 * `embedding` field) and caps at top-500 by enrollment, limiting the search space.
 */
export async function fetchCourseEmbeddingsFromFirestore(): Promise<CourseWithEmbedding[]> {
  const now = Date.now();
  if (_embeddingCache && now - _embeddingCacheAt < EMBEDDING_CACHE_TTL_MS) {
    return _embeddingCache;
  }

  log({ level: "info", node: "embeddingSearch", message: "Cache miss -> querying Firestore for embedded courses (coursesV2 + paidCourses)" });

  const [freeSnap, paidSnap] = await Promise.all([
    db.collection("coursesV2").get(),
    db.collection("paidCourses").get(),
  ]);

  const freeCourses = freeSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as object), isPaid: false } as any))
    .filter((c: any) => Array.isArray(c.embedding) && c.embedding.length > 0) as CourseWithEmbedding[];

  const paidCourses = paidSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as object), isPaid: true } as any))
    .filter((c: any) => Array.isArray(c.embedding) && c.embedding.length > 0) as CourseWithEmbedding[];

  _embeddingCache = [...freeCourses, ...paidCourses];
  _embeddingCacheAt = now;

  log({ level: "info", node: "embeddingSearch", message: `Loaded ${freeCourses.length} free + ${paidCourses.length} paid courses with embeddings` });
  return _embeddingCache;
}

/**
 * Builds the query string for embedding — topic + session signals only.
 *
 * Profile interests are intentionally excluded from the embedding query.
 * Including them caused topic drift (e.g. a Python/ML profile pulling "cooking courses"
 * results toward Python). Profile interests influence retrieval through contentRerank()
 * via the interestOverlap term; adding them to the embedding was double-counting.
 *
 * Session signals (last 3 user turns) are included for anonymous users too — they
 * reflect current conversational context without requiring a persisted profile.
 */
export function buildCompositeQuery(
  message: string,
  profile: EffectiveUserProfile | null,
  recentMessages?: { role: string; content: string }[]
): string {
  let query = message;

  void profile; // profile param retained for API compatibility; not used in embedding

  if (recentMessages && recentMessages.length > 0) {
    const sessionSignals = recentMessages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content.trim())
      .filter((c) => c.length > 0 && c !== message);
    if (sessionSignals.length > 0) {
      query += ` Session context: ${sessionSignals.join("; ")}.`;
    }
  }

  return query;
}

/** Calls `text-embedding-3-small` to produce a 1536-dim vector. 8s timeout guards against OpenAI degradation. */
export async function embedQuery(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI embeddings error: ${await response.text()}`);
    }

    const data = await response.json();
    return data.data[0].embedding as number[];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Dot-product cosine similarity (optimised single-pass loop). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Returns top-`topK` courses sorted by cosine similarity to `queryEmbedding`.
 * Pure math — no API calls.
 */
export function semanticSearch(
  queryEmbedding: number[],
  courses: CourseWithEmbedding[],
  topK = rankingConfig.retrieval.candidatePool
): (CourseWithEmbedding & { semanticScore: number })[] {
  return courses
    .map((c) => ({ ...c, semanticScore: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, topK);
}

// Dense-only search fails on exact-title queries because embedding models capture
// semantic meaning rather than exact tokens. BM25 handles exact matches; RRF merges
// both rankings robustly (absent list → rank = list_length + 1, soft penalty).
//
// Field weights: title ×3, skills ×2, description ×1
// BM25 params:   k1=1.5 (term frequency saturation), b=0.75 (length normalisation)
// RRF constant:  k=60 (standard default)

const BM25_K1 = 1.5;   // term frequency saturation parameter
const BM25_B  = 0.75;  // length normalization parameter

// Minimal English stopword set — reduces index noise without over-filtering
const BM25_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "not", "no", "nor", "it",
  "its", "this", "that", "you", "your", "i", "my", "we", "our",
]);

interface BM25Index {
  /** Maps term → number of documents containing that term */
  df: Map<string, number>;
  /** Maps courseId → { term → frequency in this doc } */
  docTermFreqs: Map<string, Map<string, number>>;
  /** Maps courseId → document token length */
  docLengths: Map<string, number>;
  /** Total number of indexed documents */
  N: number;
  /** Average document length in tokens */
  avgdl: number;
}

let _bm25Index: BM25Index | null = null;
let _bm25CacheAt = 0;

function bm25Tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !BM25_STOPWORDS.has(t));
}

function buildBM25Index(courses: CourseWithEmbedding[]): BM25Index {
  const df = new Map<string, number>();
  const docTermFreqs = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();

  for (const course of courses) {
    const titleTokens  = bm25Tokenize(course.title ?? "");
    const skillTokens  = bm25Tokenize((course.skills ?? []).join(" "));
    const descTokens   = bm25Tokenize(course.description ?? "");

    const tokens = [
      ...titleTokens, ...titleTokens, ...titleTokens,    // title ×3
      ...skillTokens, ...skillTokens,                    // skills ×2
      ...descTokens,                                     // description ×1
    ];

    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }
    docTermFreqs.set(course.id, termFreqs);
    docLengths.set(course.id, tokens.length);

    for (const term of termFreqs.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const totalLen = Array.from(docLengths.values()).reduce((s, l) => s + l, 0);
  const avgdl = courses.length > 0 ? totalLen / courses.length : 1;

  return { df, docTermFreqs, docLengths, N: courses.length, avgdl };
}

// Rebuilds the BM25 index when the embedding cache has been refreshed (_embeddingCacheAt guard).
function getBM25Index(courses: CourseWithEmbedding[]): BM25Index {
  if (!_bm25Index || _embeddingCacheAt > _bm25CacheAt) {
    _bm25Index = buildBM25Index(courses);
    _bm25CacheAt = _embeddingCacheAt;
    log({ level: "info", node: "bm25", message: `Index built — ${courses.length} docs, avg length ${_bm25Index.avgdl.toFixed(0)} tokens` });
  }
  return _bm25Index;
}

/**
 * Scores all documents against `query` using BM25 and returns the top-`topK` by score.
 *
 * Per term: IDF(t) × tf(t,d)×(k1+1) / (tf(t,d) + k1×(1−b + b×|d|/avgdl))
 * IDF(t) = ln((N−df(t)+0.5) / (df(t)+0.5) + 1)  [smoothed]
 */
export function bm25Search(
  query: string,
  index: BM25Index,
  courses: CourseWithEmbedding[],
  topK = 50
): { id: string; bm25Score: number }[] {
  const queryTerms = bm25Tokenize(query);
  if (queryTerms.length === 0) return [];

  const { df, docTermFreqs, docLengths, N, avgdl } = index;
  const scores = new Map<string, number>();

  for (const term of queryTerms) {
    const docFreq = df.get(term) ?? 0;
    if (docFreq === 0) continue;

    // Smoothed IDF
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    for (const course of courses) {
      const termFreqs = docTermFreqs.get(course.id);
      if (!termFreqs) continue;
      const tf = termFreqs.get(term) ?? 0;
      if (tf === 0) continue;

      const dl = docLengths.get(course.id) ?? avgdl;
      const tfNorm =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));

      scores.set(course.id, (scores.get(course.id) ?? 0) + idf * tfNorm);
    }
  }

  return Array.from(scores.entries())
    .map(([id, bm25Score]) => ({ id, bm25Score }))
    .sort((a, b) => b.bm25Score - a.bm25Score)
    .slice(0, topK);
}

/**
 * Merges dense and BM25 ranked lists via Reciprocal Rank Fusion.
 * S(d) = Σ 1/(k + rank_i(d)). BM25-only courses get semanticScore computed on-the-fly.
 * Returns top-`topK` from the union with `semanticScore` on every element.
 */
export function reciprocalRankFusion(
  denseRanked: (CourseWithEmbedding & { semanticScore: number })[],
  bm25Ranked: { id: string; bm25Score: number }[],
  allCourses: CourseWithEmbedding[],
  queryEmbedding: number[],
  topK: number,
  rrfK = 60
): (CourseWithEmbedding & { semanticScore: number })[] {
  const denseRankMap = new Map(denseRanked.map((c, i) => [c.id, i + 1]));
  const bm25RankMap  = new Map(bm25Ranked.map((c, i) => [c.id, i + 1]));

  const denseDefault = denseRanked.length + 1;
  const bm25Default  = bm25Ranked.length + 1;

  const allIds = new Set([
    ...denseRanked.map((c) => c.id),
    ...bm25Ranked.map((c) => c.id),
  ]);

  const denseMap     = new Map(denseRanked.map((c) => [c.id, c]));
  const allCourseMap = new Map(allCourses.map((c) => [c.id, c]));

  const rrfScored = Array.from(allIds)
    .map((id) => {
      const rankDense = denseRankMap.get(id) ?? denseDefault;
      const rankBm25  = bm25RankMap.get(id)  ?? bm25Default;
      const rrfScore  = 1 / (rrfK + rankDense) + 1 / (rrfK + rankBm25);

      // Prefer pre-computed semanticScore from dense search; compute on-the-fly for BM25-only
      const denseCourse = denseMap.get(id);
      if (denseCourse) return { ...denseCourse, rrfScore };

      const fullCourse = allCourseMap.get(id);
      if (!fullCourse) return null;

      const semanticScore = cosineSimilarity(queryEmbedding, fullCourse.embedding);
      return { ...fullCourse, semanticScore, rrfScore };
    })
    .filter(
      (r): r is CourseWithEmbedding & { semanticScore: number; rrfScore: number } =>
        r !== null
    )
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);

  // Strip internal rrfScore before returning (not used downstream)
  return rrfScored.map(({ rrfScore: _rrf, ...rest }) => rest);
}

const DIFFICULTY_ORDER: Record<string, number> = {
  beginner:     0,
  intermediate: 1,
  advanced:     2,
};

/**
 * Re-ranks `candidates` using a five-signal weighted formula (weights in agents/rankingConfig.json):
 *
 *   final_score =
 *       semantic    × semantic_similarity
 *     + wInterest   × interest_overlap      (Jaccard: course.skills ∩ profile.interests)
 *     + wDifficulty × difficulty_match      (1.0 exact, 0.5 ±1 level, 0.0 ±2 levels)
 *     + wCollab     × collab_score          (log-normalised co-enrollment popularity signal)
 *     - wEnrolled   × already_enrolled      (1.0 if in enrolledCourseIds, else 0.0)
 *
 * `coEnrollmentScore` is preferred for the collaborative signal (run precompute-coenrollment);
 * falls back to `enrolled` count if not yet populated. Log-normalised to prevent popular
 * courses dominating: score = log(1+x) / log(1+max).
 *
 * Pure math — no API calls.
 */
export function contentRerank(
  candidates: (CourseWithEmbedding & { semanticScore: number })[],
  profile: EffectiveUserProfile | null
): ScoredCourse[] {
  const profileInterests = new Set(
    (profile?.interests ?? []).map((i) => i.toLowerCase())
  );
  const profileLevel = DIFFICULTY_ORDER[profile?.skillLevel ?? "beginner"] ?? 0;
  const enrolledSet  = new Set(profile?.enrolledCourseIds ?? []);

  const maxCollab = Math.max(
    1,
    ...candidates.map((c) => c.coEnrollmentScore ?? c.enrolled ?? 0)
  );

  return candidates
    .map((c) => {
      const courseSkills = (c.skills ?? []).map((s) => s.toLowerCase());

      const intersect = courseSkills.filter((s) => profileInterests.has(s)).length;
      const union     = new Set([...courseSkills, ...Array.from(profileInterests)]).size;
      const interestOverlap = union > 0 ? intersect / union : 0;

      const courseLevel   = DIFFICULTY_ORDER[c.difficulty?.toLowerCase() ?? "beginner"] ?? 0;
      const levelDiff     = Math.abs(courseLevel - profileLevel);
      const difficultyMatch = levelDiff === 0 ? 1.0 : levelDiff === 1 ? 0.5 : 0.0;

      // Collaborative filtering: coEnrollmentScore preferred; falls back to enrolled count
      const rawCollab = c.coEnrollmentScore ?? c.enrolled ?? 0;
      const collabScore =
        rawCollab > 0 ? Math.log1p(rawCollab) / Math.log1p(maxCollab) : 0;

      const enrolledPenalty = enrolledSet.has(c.id) ? 1.0 : 0.0;

      const { semantic, interestOverlap: wInterest, difficultyMatch: wDifficulty,
              collaborativeFiltering: wCollab, enrolledPenalty: wEnrolled } =
        rankingConfig.reranking.weights;

      const finalScore =
        semantic    * c.semanticScore +
        wInterest   * interestOverlap +
        wDifficulty * difficultyMatch +
        wCollab     * collabScore     -
        wEnrolled   * enrolledPenalty;

      return { ...c, finalScore };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Selects `k` courses from `candidates` maximising the MMR objective:
 *   MMR(C_i) = λ × finalScore(C_i) − (1−λ) × max_{j<i} cosineSim(C_i, C_j)
 *
 * λ=0.7 (relevance 70%, diversity 30%) keeps the result set on-topic while
 * avoiding near-identical courses. Lower λ caused off-topic courses with
 * dissimilar embeddings to displace relevant ones after the first selection.
 */
export function mmrFilter(
  candidates: ScoredCourse[],
  k = 4,
  lambda = 0.7
): ScoredCourse[] {
  const selected: ScoredCourse[] = [];
  const remaining = [...candidates];

  while (selected.length < k && remaining.length > 0) {
    let bestMmr = -Infinity;
    let bestIdx = 0;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].finalScore;
      const maxSim =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((s) =>
                cosineSimilarity(remaining[i].embedding, s.embedding)
              )
            );
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Generates and writes an embedding for a single course document.
 * Fire-and-forget from course create/update routes so new courses are
 * immediately available to the recommendation engine.
 * Embeds title + description + skills for richer semantic signal.
 */
export async function generateCourseEmbedding(
  courseId: string,
  courseData: { title?: string; description?: string; skills?: string[] },
  collectionName: string = "coursesV2"
): Promise<void> {
  const text = [courseData.title, courseData.description, ...(courseData.skills ?? [])]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!text) return;

  const embedding = await embedQuery(text);

  await db.collection(collectionName).doc(courseId).update({ embedding });
}

/**
 * Runs the full hybrid semantic+lexical recommendation pipeline and returns up to 8 courses.
 *
 * Corpus fetch and query embedding run in parallel. BM25 index is built from the cached
 * corpus (no I/O) and merged with dense results via RRF before reranking.
 * Returns an empty array if no courses have embeddings yet.
 *
 * @param userMessage    Raw user message or agent-extracted topic string
 * @param profile        EffectiveUserProfile from lib/userProfileService, or null
 * @param recentMessages Recent conversation turns for session signal injection
 */
export async function getSemanticRecommendations(
  userMessage: string,
  profile: EffectiveUserProfile | null,
  recentMessages?: { role: string; content: string }[]
): Promise<ScoredCourse[]> {
  const compositeQuery = buildCompositeQuery(userMessage, profile, recentMessages);

  const [courses, queryEmbedding] = await Promise.all([
    fetchCourseEmbeddingsFromFirestore(),
    embedQuery(compositeQuery),
  ]);

  if (courses.length === 0) return [];

  // Candidate pool of 200 improves recall for niche topics (music, arts, languages)
  // where few relevant courses exist — they may rank beyond top-50 in dense-only retrieval.
  // At n=200: contentRerank is O(n), mmrFilter is O(n×k) = ~1,600 cosine sims — negligible.
  const { candidatePool, rrfK } = rankingConfig.retrieval;
  const { k: mmrK, lambda: mmrLambda } = rankingConfig.mmr;

  const bm25Idx   = getBM25Index(courses);
  const denseTop  = semanticSearch(queryEmbedding, courses, candidatePool);
  const bm25Top   = bm25Search(compositeQuery, bm25Idx, courses, candidatePool);

  const hybridCandidates = reciprocalRankFusion(
    denseTop, bm25Top, courses, queryEmbedding, candidatePool, rrfK
  );

  const reranked = contentRerank(hybridCandidates, profile);
  const diverse  = mmrFilter(reranked, mmrK, mmrLambda);

  return diverse;
}
