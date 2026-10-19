export interface QuestionOption {
  id: 'A' | 'B' | 'C' | 'D';
  text: string;
}

export interface Question {
  number: number;
  question: string;
  options: QuestionOption[];
}

export type SessionStatus = 'lobby' | 'question' | 'locked' | 'finished' | 'closed';

export interface SessionData {
  status: SessionStatus;
  currentQuestionIndex: number; // 0 to 14
  questionStartedAt: number; // UTC timestamp in milliseconds
  durationSeconds: number; // 30
  createdAt: number;
  hostUid: string;
  isPaused?: boolean;
  pausedAt?: number | null;
  remainingSecondsOnPause?: number | null;
}

export interface ParticipantData {
  name: string;
  joinedAt: number;
  hypeCount?: number;
}

export interface ResponseData {
  participantId: string;
  participantName: string;
  questionIndex: number;
  questionText: string;
  rankedOptions: ('A' | 'B' | 'C' | 'D')[];
  submittedAt: number;
  secondsToSubmit?: number;
}
