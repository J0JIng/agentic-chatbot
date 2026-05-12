import { db } from "@/lib/firebaseAdmin";
import {
  getUserMergedProfileData,
  createNewAIProfileData,
  updateAIProfileData,
} from "@/agents/userProfilingAgent";
import { log } from "@/lib/logger";

export type EnrollmentEvent = "enrolled" | "completed";

interface CourseSignalData {
  title: string;
  skills: string[];
  difficulty: string;
}

const SKILL_LEVELS = ["beginner", "intermediate", "advanced"] as const;
type SkillLevel = (typeof SKILL_LEVELS)[number];

/**
 * Updates the user's AI profile based on an enrollment or completion event.
 * Note: it is safe to call fire-and-forget. Errors are caught internally and logged.
 */
export async function updateProfileFromEnrollment(
  userId: string,
  courseId: string,
  event: EnrollmentEvent
): Promise<void> {
  if (!userId || !courseId) return;

  try {
    const courseData = await fetchCourseSignalData(courseId);
    if (!courseData) {
      log({ level: "info", node: "enrollmentProfiling", userId, message: `Course ${courseId} not found in coursesV2 or paidCourses — skipping` });
      return;
    }

    const { title, skills, difficulty } = courseData;

    if (skills.length === 0) {
      log({ level: "info", node: "enrollmentProfiling", userId, message: `"${title}" has no skills metadata — skipping interest update` });
      return;
    }

    const currentProfile = await getUserMergedProfileData(userId);

    const updatedSkillLevel = computeUpliftedSkillLevel(
      currentProfile?.aiDefined?.inferredSkillLevel,
      difficulty as SkillLevel,
      event
    );

    // Enrollment signals are treated as explicit, confidence:high positive interests.
    const syntheticSignals = {
      inferredInterests: skills,
      inferredSkillLevel: updatedSkillLevel,
      inferredCognitiveLevel:
        currentProfile?.aiDefined?.inferredCognitiveLevel ?? "not_specified",
    };

    const reasoningTrace =
      event === "completed"
        ? `Completed "${title}" (${difficulty}) — ${skills.join(", ")} reinforced; skill level updated to ${updatedSkillLevel}`
        : `Enrolled in "${title}" — ${skills.join(", ")} added as explicit enrollment signals`;

    const updatedProfile = createNewAIProfileData(
      currentProfile?.aiDefined,
      syntheticSignals,
      reasoningTrace
    );

    await updateAIProfileData(userId, updatedProfile);

    log({ level: "info", node: "enrollmentProfiling", userId, message: `Profile updated on ${event} of "${title}" (${skills.length} skills, level: ${updatedSkillLevel})` });
  } catch (err) {
    log({ level: "error", node: "enrollmentProfiling", userId, message: "Failed to update profile", error: String(err) });
  }
}

/** Fetches minimal course signal data from Firestore (coursesV2 → paidCourses fallback). */
async function fetchCourseSignalData(
  courseId: string
): Promise<CourseSignalData | null> {
  const freeDoc = await db.collection("coursesV2").doc(courseId).get();
  if (freeDoc.exists) {
    const d = freeDoc.data() as any;
    return {
      title: d?.title ?? courseId,
      skills: Array.isArray(d?.skills) ? d.skills : [],
      difficulty: (d?.difficulty ?? "beginner").toLowerCase(),
    };
  }

  const paidDoc = await db.collection("paidCourses").doc(courseId).get();
  if (paidDoc.exists) {
    const d = paidDoc.data() as any;
    return {
      title: d?.title ?? courseId,
      skills: Array.isArray(d?.skills) ? d.skills : [],
      difficulty: (d?.difficulty ?? "beginner").toLowerCase(),
    };
  }

  return null;
}

/**
 * Returns the skill level after an enrollment or completion event.
 * On "completed": advances one level if course difficulty ≥ current level and not at ceiling.
 * On "enrolled": no uplift — enrollment alone does not confirm mastery.
 */
function computeUpliftedSkillLevel(
  currentLevel: string | undefined,
  courseDifficulty: SkillLevel,
  event: EnrollmentEvent
): string {
  const current = SKILL_LEVELS.includes(currentLevel as SkillLevel)
    ? (currentLevel as SkillLevel)
    : "beginner";

  if (event !== "completed") return current;

  const currentIdx = SKILL_LEVELS.indexOf(current);
  const diffIdx = SKILL_LEVELS.indexOf(courseDifficulty);

  // Uplift: completed course must be at or above current level, ceiling at "advanced"
  if (diffIdx >= currentIdx && currentIdx < SKILL_LEVELS.length - 1) {
    return SKILL_LEVELS[currentIdx + 1];
  }

  return current;
}
