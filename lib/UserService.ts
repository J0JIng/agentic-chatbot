// UserService.ts
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
} from "firebase/firestore";
import { getAuth, onAuthStateChanged, User } from "firebase/auth";
import app from "./firebaseConfig";

const db = getFirestore(app);
const auth = getAuth(app);

// Define TypeScript interfaces for better type safety
export interface UserSubscription {
  type: "none" | "monthly" | "annual" | "lifetime";
  startDate: string;
  endDate: string;
  isActive: boolean;
  autoRenew: boolean;
  paymentMethod?: string;
}

export interface UserPersonalInfo {
  name: string;
  email: string;
  occupation?: string;
  company?: string;
  educationLevel?: string;
  location?: string;
  timezone?: string;
}

export interface InstructorProfile {
  information: string;
  expertise: string;
  qualification: string;
  yearsOfExperience: number;
  website?: string;
  teachingAreas: string[];
  extraInfoProvided: boolean;
  approvalStatus: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface AIInferredProfile {
  inferredInterests: string[];
  inferredSkillLevel: "beginner" | "intermediate" | "advanced";
  /** Bloom's Taxonomy cognitive level (Anderson & Krathwohl, 2001). Replaces VARK. */
  inferredCognitiveLevel: string;
  /**
   * Per-interest decay weights. Key = normalised interest label (lowercase).
   * Value = { weight: 0–1, lastUpdated: ISO timestamp }.
   * Interests decay with a 30-day half-life; culled when weight < 0.1.
   * Citation: Gauch et al. (2007). User Profiles for Personalised Information Access.
   */
  interestWeights?: Record<string, { weight: number; lastUpdated: string }>;
  /** Auditor chain-of-thought stored for explainability (IMP-D). */
  lastReasoningTrace?: string;
  lastUpdated: string;
}

export interface MergedProfile {
  userDefined: {
    name: string;
    skills: string[];
  };
  aiDefined: AIInferredProfile;
  hasAiData: boolean;
}

export interface UserData {
  role?: "learner" | "instructor";
  courses: string[];
  ratings: Record<string, number>;
  skills: string[];
  subcategory?: string;
  age?: number;
  time_spent: Record<string, number>;
  completion_rate: number;
  feedback: Record<string, "liked" | "disliked" | "neutral">;
  subscription: UserSubscription;
  personalInfo: UserPersonalInfo;
  instructorProfile?: InstructorProfile;
  aiProfile?: AIInferredProfile;
  createdAt?: string;
  modifiedAt?: string;

  // For onboarding and personality assessment
  learnerProfile?: LearnerProfileV1;
  learnerPreferences?: LearnerPreferencesV1;
  onboarding?: {
    version: 1;
    status: "not_started" | "completed" | "skipped";
    completedAt?: string;
    skippedAt?: string;
  };
}

// For personality assessment onboarding to recommend courses
// -- Start
export type RiasecLetter = "R" | "I" | "A" | "S" | "E" | "C";

export interface LearnerProfileV1 {
  version: 1;
  instrument: "onet-mini-ip-30";
  createdAt: string;
  updatedAt: string;

  // raw answers keyed by item id 1..30, each 1..5
  answers: Record<string, number>;

  scores: Record<RiasecLetter, number>; // sums per domain
  top: RiasecLetter[];                  // top 2–3 letters
  confidence: number;                   // top1 - top2
}

export interface LearnerPreferencesV1 {
  version: 1;
  createdAt: string;
  updatedAt: string;

  intent: "explore" | "upskill" | "career_switch" | "credential" | "portfolio";
  weeklyTime: "<2" | "2-5" | "5-10" | ">10";
  idealDuration: "1-3" | "4-10" | "11-25" | ">26" | "no_pref";
  difficulty: "intro" | "intro_intermediate" | "any";
  mode: "video" | "reading" | "project" | "mixed";
  structure: "self_paced" | "structured" | "either";
  assessment: "quizzes" | "projects" | "either";
  support: "independent" | "reminders" | "cohort";
}
// -- End

class UserService {
  private currentUser: User | null = null;
  private userData: UserData | null = null;
  private userDataListeners: ((userData: UserData | null) => void)[] = [];

  constructor() {
    // Listen for auth state changes
    onAuthStateChanged(auth, (user) => {
      this.currentUser = user;
      if (user) {
        this.fetchUserData();
      } else {
        this.userData = null;
        this.notifyDataListeners();
      }
    });
  }

  // Get current Firebase user
  getCurrentUser(): User | null {
    return this.currentUser;
  }

  // Get user ID or fallback to a default for development
  getUserId(): string {
    return this.currentUser?.uid || "user1";
  }

  // Add a listener for user data changes
  addUserDataListener(
    listener: (userData: UserData | null) => void
  ): () => void {
    this.userDataListeners.push(listener);

    // Immediately notify with current data if available
    if (this.userData) {
      listener(this.userData);
    }

    // Return unsubscribe function
    return () => {
      this.userDataListeners = this.userDataListeners.filter(
        (l) => l !== listener
      );
    };
  }

  // Notify all listeners about data changes
  private notifyDataListeners(): void {
    for (const listener of this.userDataListeners) {
      listener(this.userData);
    }
  }

  // Fetch user data from Firestore
  async fetchUserData(): Promise<UserData | null> {
    try {
      const userId = this.getUserId();
      const userDocRef = doc(db, "users", userId);
      const userDoc = await getDoc(userDocRef);

      if (userDoc.exists()) {
        this.userData = userDoc.data() as UserData;
        this.notifyDataListeners();
        return this.userData;
      } else {
        console.log("No user data found, creating default profile");
        // Create a default profile if none exists
        const defaultUserData = this.createDefaultUserData();
        await this.saveUserData(defaultUserData);
        return defaultUserData;
      }
    } catch (error) {
      console.error("Error fetching user data:", error);
      return null;
    }
  }

  // Create default user data for new users
  private createDefaultUserData(): UserData {
    // Get user email from auth if available
    const email = this.currentUser?.email || "";
    const name = this.currentUser?.displayName || "User";

    return {
      role:"learner",
      courses: [],
      ratings: {},
      skills: [],
      time_spent: {},
      completion_rate: 0,
      feedback: {},
      subscription: {
        type: "none",
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString(),
        isActive: false,
        autoRenew: false,
      },
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      personalInfo: {
        name: name,
        email: email,
        occupation: "Not specified",
        company: "Not specified",
        educationLevel: "not_specified",
        location: "Not specified",
        timezone: "UTC",
      },
      onboarding: {
        version: 1,
        status: "not_started",
      },
    };
  }

  // Save user data to Firestore
  async saveUserData(userData: UserData): Promise<void> {
    try {
      const userId = this.getUserId();
      const userDocRef = doc(db, "users", userId);

      // Update local cache
      this.userData = userData;

      // Save to Firestore
      await setDoc(userDocRef, userData);

      // Notify listeners
      this.notifyDataListeners();
    } catch (error) {
      console.error("Error saving user data:", error);
      throw error;
    }
  }

  // Update specific fields in user data
  async updateUserData(updates: Partial<UserData>): Promise<void> {
    try {
      const userId = this.getUserId();
      const userDocRef = doc(db, "users", userId);

      // Update Firestore
      await updateDoc(userDocRef, updates as any);

      // Update local cache and notify
      if (this.userData) {
        this.userData = { ...this.userData, ...updates };
        this.notifyDataListeners();
      }
    } catch (error) {
      console.error("Error updating user data:", error);
      throw error;
    }
  }

  // Set user role
  async setUserRole(role: "learner" | "instructor"): Promise<void> {
    try {
      await this.updateUserData({ role });
    } catch (error) {
      console.error("Error setting user role:", error);
      throw error;
    }
  }

  // Get cached user data
  getUserData(): UserData | null {
    return this.userData;
  }

  // Check if the user has an active subscription
  hasActiveSubscription(): boolean {
    if (!this.userData) return false;

    const { subscription } = this.userData;

    // Check if subscription is active
    if (!subscription.isActive) return false;

    // Check if subscription is expired
    const now = new Date();
    const endDate = new Date(subscription.endDate);

    return now <= endDate;
  }

  // Get subscription details
  getSubscriptionDetails(): UserSubscription | null {
    return this.userData?.subscription || null;
  }

  // Add a completed course
  async addCompletedCourse(courseId: string, rating?: number): Promise<void> {
    if (!this.userData) return;

    // Add to courses if not already there
    const updatedCourses = [...this.userData.courses];
    if (!updatedCourses.includes(courseId)) {
      updatedCourses.push(courseId);
    }

    // Update ratings if provided
    const updatedRatings = { ...this.userData.ratings };
    if (rating !== undefined) {
      updatedRatings[courseId] = rating;
    }

    // Calculate new completion rate
    // This is simplified; in a real app, you'd have a more complex calculation
    const completionRate = Math.min(
      1.0,
      (updatedCourses.length / 10) * 0.8 + 0.2
    );

    await this.updateUserData({
      courses: updatedCourses,
      ratings: updatedRatings,
      completion_rate: completionRate,
    });
  }

  // Add course feedback
  async addCourseFeedback(
    courseId: string,
    feedbackType: "liked" | "disliked" | "neutral"
  ): Promise<void> {
    if (!this.userData) return;

    const updatedFeedback = {
      ...this.userData.feedback,
      [courseId]: feedbackType,
    };

    await this.updateUserData({ feedback: updatedFeedback });
  }

  // Update time spent on a course
  async updateCourseTimeSpent(
    courseId: string,
    additionalMinutes: number
  ): Promise<void> {
    if (!this.userData) return;

    const updatedTimeSpent = { ...this.userData.time_spent };
    updatedTimeSpent[courseId] =
      (updatedTimeSpent[courseId] || 0) + additionalMinutes;

    await this.updateUserData({ time_spent: updatedTimeSpent });
  }

  // Update user skills
  async updateSkills(skills: string[]): Promise<void> {
    if (!this.userData) return;

    // Combine existing and new skills, remove duplicates
    const updatedSkills = Array.from(
      new Set([...this.userData.skills, ...skills])
    );

    await this.updateUserData({ skills: updatedSkills });
  }

  // Update user personal information
  async updatePersonalInfo(info: Partial<UserPersonalInfo>): Promise<void> {
    if (!this.userData) return;

    const updatedPersonalInfo = {
      ...this.userData.personalInfo,
      ...info,
    };

    await this.updateUserData({ personalInfo: updatedPersonalInfo });
  }

  // Update user subscription
  async updateSubscription(
    subscription: Partial<UserSubscription>
  ): Promise<void> {
    if (!this.userData) return;

    const updatedSubscription = {
      ...this.userData.subscription,
      ...subscription,
    };

    await this.updateUserData({ subscription: updatedSubscription });
  }

  // Check if instructor has provided extra information
  hasExtraInfo(): boolean {
    if (!this.userData) return false;
    if (this.userData.role !== "instructor") return true; // Non-instructors don't need onboarding
    return this.userData.instructorProfile?.extraInfoProvided ?? false;
  }

  // Get instructor profile
  getInstructorProfile(): InstructorProfile | null {
    return this.userData?.instructorProfile || null;
  }

  getAIInferredProfile(): AIInferredProfile | null {
    return this.userData?.aiProfile || null;
  }

  hasAiProfile(): boolean {
    return !!this.userData?.aiProfile;
  }

  async updateAIProfile(profile: AIInferredProfile): Promise<void> {
    try {
 
      const userId = this.getUserId();
      if (!userId) throw new Error("No active user ID found");

      const userDocRef = doc(db, "users", userId);

      await updateDoc(userDocRef, { 
        aiProfile: profile,
      });

      if (this.userData) {
        this.userData = {
          ...this.userData,
          aiProfile: profile,
          modifiedAt: new Date().toISOString()
        };
        this.notifyDataListeners();
      }
    } catch (error) {
      console.error("Error updating AI profile:", error);
      throw error;
    }
  }

  // Get merged profile data
  getMergedProfileData() : MergedProfile | null{
    const data = this.userData;
    if (!data) return null;
    return {
      userDefined: {
        name: data?.personalInfo?.name || "",
        skills: data?.skills || [],
      },
      aiDefined: {
        inferredInterests: data?.aiProfile?.inferredInterests || [],
        inferredSkillLevel: data?.aiProfile?.inferredSkillLevel || "beginner",
        inferredLearningStyle: data?.aiProfile?.inferredLearningStyle || "not_specified",
        lastUpdated: data?.aiProfile?.lastUpdated || ""
      },
      hasAiData: !!data?.aiProfile
    };
  }

  // Save learner profile from onboarding --
  async saveLearnerProfile(profile: LearnerProfileV1): Promise<void> {
    await this.updateUserData({
      learnerProfile: profile,
      modifiedAt: new Date().toISOString(),
    });
  }

  async saveLearnerPreferences(prefs: LearnerPreferencesV1): Promise<void> {
    const now = new Date().toISOString();

    await this.updateUserData({
      learnerPreferences: prefs,
      onboarding: {
        version: 1,
        status: "completed",
        completedAt: now,
      },
      modifiedAt: now,
    });
  }

  async skipLearnerOnboarding(): Promise<void> {
    const now = new Date().toISOString();

    await this.updateUserData({
      onboarding: {
        version: 1,
        status: "skipped",
        skippedAt: now,
      },
      modifiedAt: now,
    });
  }

  hasCompletedLearnerOnboarding(): boolean {
    const status = this.userData?.onboarding?.status;
    return status === "completed" || status === "skipped";
  }
  // -- End of onboarding methods
}

// Create a singleton instance
const userService = new UserService();
export default userService;
