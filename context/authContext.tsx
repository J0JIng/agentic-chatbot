"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import auth from "@/lib/firebaseAuth";
import userService from "@/lib/UserService";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  userRole: "learner" | "instructor" | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider = ({ children }: AuthProviderProps): JSX.Element => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<"learner" | "instructor" | null>(
    null
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        setUser(user);
        if (user) {
          // Fetch user role from UserService
          const userData = await userService.fetchUserData();
          setUserRole(userData?.role || "learner");
        } else {
          setUserRole(null);
        }
        setLoading(false);
      },
      (error) => {
        console.error("Failed to subscribe to auth state changes", error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null); // Update the user state
    } catch (error) {
      console.error("Error logging out:", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, userRole, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
