import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import { Module } from "../components/course_content/module_content/types";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);

const db = getFirestore(app);

interface Course {
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

/** Uploads a file to Firebase Storage and returns the public download URL. */
export async function uploadFileToFirebase(file: File, path: string): Promise<string> {
  const storage = getStorage(app);
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return url;
}

export { db };
export default app;
