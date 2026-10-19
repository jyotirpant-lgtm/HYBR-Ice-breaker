import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  onSnapshot,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  Unsubscribe
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { SessionData, ParticipantData, ResponseData } from './types.ts';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
  };
}

export interface AppUser {
  uid: string;
  isAnonymous: boolean;
}

let cachedUser: AppUser | null = null;

export function getFallbackUid(): string {
  const key = 'hybr_device_client_uid';
  let uid = localStorage.getItem(key);
  if (!uid) {
    uid = 'usr_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    localStorage.setItem(key, uid);
  }
  return uid;
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || cachedUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous ?? true,
      tenantId: auth.currentUser?.tenantId || null,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Ensure anonymous authentication with graceful fallback if disabled on Firebase Console
export async function ensureAuth(): Promise<AppUser> {
  if (cachedUser) {
    return cachedUser;
  }
  if (auth.currentUser) {
    cachedUser = { uid: auth.currentUser.uid, isAnonymous: auth.currentUser.isAnonymous };
    return cachedUser;
  }

  try {
    const cred = await signInAnonymously(auth);
    cachedUser = { uid: cred.user.uid, isAnonymous: cred.user.isAnonymous };
    return cachedUser;
  } catch (err: unknown) {
    // If Anonymous Auth is not yet toggled on in the Firebase Console (auth/admin-restricted-operation),
    // fallback gracefully to a persistent device UID so users can test and play immediately!
    console.warn('Anonymous auth provider restricted in Firebase Console, using device identity:', err);
    cachedUser = { uid: getFallbackUid(), isAnonymous: true };
    return cachedUser;
  }
}

// Test connectivity
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline, retrying...');
    }
  }
}

// Session Helpers
export function subscribeToSession(
  code: string,
  onUpdate: (data: SessionData | null) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  const path = `sessions/${code}`;
  const sessionRef = doc(db, 'sessions', code);
  return onSnapshot(
    sessionRef,
    (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as SessionData);
      } else {
        onUpdate(null);
      }
    },
    (error) => {
      console.warn('Session snapshot error:', error);
      if (onError) onError(error);
    }
  );
}

export async function createSession(code: string, hostUid: string): Promise<void> {
  const path = `sessions/${code}`;
  const now = Date.now();
  const sessionData: SessionData = {
    status: 'lobby',
    currentQuestionIndex: 0,
    questionStartedAt: now,
    durationSeconds: 30,
    createdAt: now,
    hostUid,
    isPaused: false,
    pausedAt: null,
    remainingSecondsOnPause: null
  };

  try {
    await setDoc(doc(db, 'sessions', code), sessionData);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateSessionState(code: string, updates: Partial<SessionData>): Promise<void> {
  const path = `sessions/${code}`;
  try {
    await setDoc(doc(db, 'sessions', code), updates, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// Participants Helpers
export function subscribeToParticipants(
  code: string,
  onUpdate: (participants: { id: string; data: ParticipantData }[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  const path = `sessions/${code}/participants`;
  const colRef = collection(db, 'sessions', code, 'participants');
  return onSnapshot(
    colRef,
    (snapshot) => {
      const list = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        data: docSnap.data() as ParticipantData,
      }));
      onUpdate(list);
    },
    (error) => {
      console.warn('Participants snapshot error:', error);
      if (onError) onError(error);
    }
  );
}

export async function joinSessionAsParticipant(code: string, name: string): Promise<string> {
  const user = await ensureAuth();
  const path = `sessions/${code}/participants/${user.uid}`;
  const participantData: ParticipantData = {
    name: name.trim(),
    joinedAt: Date.now(),
    hypeCount: 0,
  };

  try {
    await setDoc(doc(db, 'sessions', code, 'participants', user.uid), participantData);
    return user.uid;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    throw error;
  }
}

export async function incrementHypeTap(code: string, uid: string): Promise<void> {
  try {
    const ref = doc(db, 'sessions', code, 'participants', uid);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const current = (snap.data().hypeCount || 0) + 1;
      await setDoc(ref, { hypeCount: current }, { merge: true });
    }
  } catch (error) {
    console.warn('Failed to register hype tap:', error);
  }
}

// Responses Helpers
export async function submitRankingResponse(
  code: string,
  questionIndex: number,
  questionText: string,
  participantName: string,
  rankedOptions: ('A' | 'B' | 'C' | 'D')[],
  secondsToSubmit: number
): Promise<void> {
  const user = await ensureAuth();
  const responseId = `${questionIndex}_${user.uid}`;
  const path = `sessions/${code}/responses/${responseId}`;

  const responseDoc: ResponseData = {
    participantId: user.uid,
    participantName,
    questionIndex,
    questionText,
    rankedOptions,
    submittedAt: Date.now(),
    secondsToSubmit: Math.max(1, Math.round(secondsToSubmit))
  };

  try {
    await setDoc(doc(db, 'sessions', code, 'responses', responseId), responseDoc);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToMyResponse(
  code: string,
  questionIndex: number,
  participantId: string,
  onUpdate: (res: ResponseData | null) => void
): Unsubscribe {
  const responseId = `${questionIndex}_${participantId}`;
  const ref = doc(db, 'sessions', code, 'responses', responseId);

  return onSnapshot(
    ref,
    (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as ResponseData);
      } else {
        onUpdate(null);
      }
    },
    (error) => {
      console.warn('My response snapshot error:', error);
    }
  );
}

// Host subscribes to all responses for the session
export function subscribeToAllResponses(
  code: string,
  onUpdate: (responses: ResponseData[]) => void
): Unsubscribe {
  const colRef = collection(db, 'sessions', code, 'responses');
  return onSnapshot(
    colRef,
    (snapshot) => {
      const list = snapshot.docs.map((docSnap) => docSnap.data() as ResponseData);
      onUpdate(list);
    },
    (error) => {
      console.warn('All responses snapshot error:', error);
    }
  );
}

// Delete entire session and all its subcollections (participants & responses)
export async function deleteEntireSession(code: string): Promise<void> {
  if (!code) return;

  try {
    const sessionRef = doc(db, 'sessions', code);

    // 1. Mark session as closed so real-time listeners on participants disconnect immediately
    await setDoc(sessionRef, { status: 'closed' }, { merge: true }).catch(() => {});

    // 2. Delete all participants
    const participantsRef = collection(db, 'sessions', code, 'participants');
    const participantsSnap = await getDocs(participantsRef).catch(() => null);
    if (participantsSnap && !participantsSnap.empty) {
      const deletePromises = participantsSnap.docs.map((d) => deleteDoc(d.ref));
      await Promise.all(deletePromises);
    }

    // 3. Delete all responses
    const responsesRef = collection(db, 'sessions', code, 'responses');
    const responsesSnap = await getDocs(responsesRef).catch(() => null);
    if (responsesSnap && !responsesSnap.empty) {
      const deletePromises = responsesSnap.docs.map((d) => deleteDoc(d.ref));
      await Promise.all(deletePromises);
    }

    // 4. Finally delete the parent session document
    await deleteDoc(sessionRef).catch(() => {});
  } catch (err) {
    console.warn('Error deleting entire session:', err);
  }
}
