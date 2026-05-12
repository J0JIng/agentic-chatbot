import { db } from "@/lib/firebaseAdmin";
import { UserData } from "@/lib/UserService";

/** Merged, de-duplicated user profile consumed by the agent pipeline. */
export interface EffectiveUserProfile {
  /** De-duplicated merge of: aiProfile.inferredInterests + userData.skills */
  interests: string[];
  skillLevel: "beginner" | "intermediate" | "advanced";
  cognitiveLevel: string;
  enrolledCourseIds: string[];
}

/** Reads Firestore and returns the merged effective profile for the agent pipeline. */
export async function buildEffectiveUserProfile(
  userId: string
): Promise<EffectiveUserProfile | null> {
  if (!userId) return null;

  const userDoc = await db.collection("users").doc(userId).get();
  if (!userDoc.exists) return null;

  const data = userDoc.data() as UserData;

  const rawInterests = [
    ...(data?.aiProfile?.inferredInterests ?? []),
    ...(data?.skills ?? []),
  ];

  const seen = new Set<string>();
  const interests: string[] = [];
  for (const raw of rawInterests) {
    const key = raw.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      // Re-capitalise first letter for display
      interests.push(key.charAt(0).toUpperCase() + key.slice(1));
    }
  }

  const rawSkill = data?.aiProfile?.inferredSkillLevel;
  const skillLevel: "beginner" | "intermediate" | "advanced" =
    rawSkill === "intermediate" || rawSkill === "advanced" ? rawSkill : "beginner";

  // Backward-compatible: documents predating Bloom's migration have 
  // no inferredCognitiveLevel and default to "not_specified".
  const cognitiveLevel = data?.aiProfile?.inferredCognitiveLevel ?? "not_specified";

  return {
    interests,
    skillLevel,
    cognitiveLevel,
    enrolledCourseIds: data?.courses ?? [],
  };
}
