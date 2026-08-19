// Firebase project setup for cloud login + saved projects. This config is a public client
// identifier (not a secret) — access to user data is enforced by Firestore security rules
// (see firestore.rules), not by keeping this hidden.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC0Ogmjg9GLdvULjeC9ipwDAhLR7J1KRls",
  authDomain: "grafischer-fahrplan.firebaseapp.com",
  projectId: "grafischer-fahrplan",
  storageBucket: "grafischer-fahrplan.firebasestorage.app",
  messagingSenderId: "488146416352",
  appId: "1:488146416352:web:407db7311f8f7ec141d685",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
