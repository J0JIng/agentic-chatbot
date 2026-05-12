import { DocumentReference } from "firebase/firestore";
export interface course {
  course_id: string;
  imageUrl: string;
  relevantTags: string[];
  courseType: string;
  courseName: string;
  courseProviderImage: string;
  courseProvider: string;
  rating: number;
  numberOfReviews: number;
  courseLevel: string;
  duration: string;
  price: number;
  language: string[];
}

export interface CourseDetails {
    course_id: DocumentReference; 
    courseDescription: string;
    location: string;
    attendees: number;
    learningObjectives: string[];
    skillsLearnt: string[];
    relevantJobs: string[];
    instructor: Instructor;
    comments: Record<string, Comment>;
    FAQ: FAQ[];
  }
  
  export interface Instructor {
    instructorName: string;
    rating: number;
    university: string;
    other_courses: number;
    no_learners: number;
  }
  
  export interface Comment {
    rating: number;
    date: string;
    comment: string;
  }
  
  export interface FAQ {
    [question: string]: string;
  }