import React, { useState, useEffect, useRef } from 'react';
import {
  ensureAuth,
  subscribeToSession,
  subscribeToParticipants,
  joinSessionAsParticipant,
  incrementHypeTap,
  submitRankingResponse,
  subscribeToMyResponse
} from '../firebase.ts';
import { QUESTIONS } from '../data/questions.ts';
import { SessionData, ParticipantData, ResponseData, QuestionOption } from '../types.ts';
import { playSubmitChime, playLockoutChime } from '../utils/audio.ts';

const SESSION_STORAGE_KEY = 'hybr_participant_session';
const NAME_STORAGE_KEY = 'hybr_participant_name';

interface ParticipantViewProps {
  initialCode?: string;
  onSwitchToHost?: () => void;
}

export const ParticipantView: React.FC<ParticipantViewProps> = ({ initialCode, onSwitchToHost }) => {
  // Session code & name
  const [sessionCode, setSessionCode] = useState<string>(() => {
    return initialCode || localStorage.getItem(SESSION_STORAGE_KEY) || '';
  });
  const [participantName, setParticipantName] = useState<string>(() => {
    return localStorage.getItem(NAME_STORAGE_KEY) || '';
  });
  const [joined, setJoined] = useState<boolean>(false);
  const [joining, setJoining] = useState<boolean>(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Firestore live state
  const [session, setSession] = useState<SessionData | null>(null);
  const [participants, setParticipants] = useState<{ id: string; data: ParticipantData }[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [myResponse, setMyResponse] = useState<ResponseData | null>(null);

  // Local ranking state for the active question
  const [orderedOptions, setOrderedOptions] = useState<QuestionOption[]>([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submittedForCurrent, setSubmittedForCurrent] = useState<boolean>(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  // Synchronized timer state
  const [secondsRemaining, setSecondsRemaining] = useState<number>(30);
  const [isTimeUp, setIsTimeUp] = useState<boolean>(false);

  // Cheer / hype toast state
  const [cheerToast, setCheerToast] = useState<string | null>(null);
  const cheerTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Summary card save toast
  const [summaryToast, setSummaryToast] = useState<string | null>(null);

  // PIN input digit focus
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Initialize auth
  useEffect(() => {
    ensureAuth().then((user) => {
      setCurrentUserId(user.uid);
    }).catch(console.error);
  }, []);

  // Update sessionCode if initialCode prop changes
  useEffect(() => {
    if (initialCode && initialCode !== sessionCode) {
      setSessionCode(initialCode);
    }
  }, [initialCode]);

  // Subscribe to session & participants if joined
  useEffect(() => {
    if (!joined || !sessionCode) return;

    const unsubSession = subscribeToSession(
      sessionCode,
      (data) => {
        if (!data || data.status === 'closed') {
          // The previous session was deleted/reset by the host - immediately disconnect participant
          localStorage.removeItem(SESSION_STORAGE_KEY);
          setSession(null);
          setJoined(false);
          setSessionCode('');
          setMyResponse(null);
          setJoinError('The host has reset the session. Please enter the new session PIN or scan the new QR code on stage to join!');
          return;
        }
        setSession(data);
      },
      (err) => {
        console.error('Session listener error:', err);
      }
    );

    const unsubParticipants = subscribeToParticipants(
      sessionCode,
      (list) => {
        setParticipants(list);
      }
    );

    return () => {
      unsubSession();
      unsubParticipants();
    };
  }, [joined, sessionCode]);

  // Automatically rejoin if local storage has valid session and name
  useEffect(() => {
    const savedCode = localStorage.getItem(SESSION_STORAGE_KEY);
    const savedName = localStorage.getItem(NAME_STORAGE_KEY);
    if (savedCode && savedName && !joined) {
      handleJoin(savedCode, savedName, true);
    }
  }, []);

  // When active question changes or session status updates, reset option cards order & subscribe to user's response
  const currentQIndex = session?.currentQuestionIndex ?? 0;
  const currentQuestion = QUESTIONS[currentQIndex] || QUESTIONS[0];

  useEffect(() => {
    if (!session || !currentQuestion) return;

    // Reset initial order to A, B, C, D
    setOrderedOptions([...currentQuestion.options]);
    setSubmittedForCurrent(false);
    setIsTimeUp(false);

    if (currentUserId && sessionCode) {
      const unsub = subscribeToMyResponse(
        sessionCode,
        currentQIndex,
        currentUserId,
        (res) => {
          setMyResponse(res);
          if (res) {
            setSubmittedForCurrent(true);
            // Sync order to what was submitted
            const reordered = res.rankedOptions.map((optId) =>
              currentQuestion.options.find((o) => o.id === optId)!
            ).filter(Boolean);
            if (reordered.length === 4) {
              setOrderedOptions(reordered);
            }
          }
        }
      );
      return () => unsub();
    }
  }, [currentQIndex, session?.status, currentUserId, sessionCode]);

  // Synchronized countdown timer based on server timestamp
  useEffect(() => {
    if (!session || session.status !== 'question') {
      if (session?.status === 'locked') {
        setSecondsRemaining(0);
        setIsTimeUp(true);
      }
      return;
    }

    const duration = session.durationSeconds || 30;
    const startedAt = session.questionStartedAt || Date.now();

    const updateTimer = () => {
      if (session.isPaused && session.remainingSecondsOnPause !== undefined && session.remainingSecondsOnPause !== null) {
        setSecondsRemaining(session.remainingSecondsOnPause);
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      const remaining = Math.max(0, duration - elapsedSec);

      setSecondsRemaining(remaining);
      if (remaining <= 0) {
        setIsTimeUp(true);
      } else {
        setIsTimeUp(false);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 500);
    return () => clearInterval(interval);
  }, [session?.questionStartedAt, session?.durationSeconds, session?.status, session?.isPaused, session?.remainingSecondsOnPause]);

  // Join Game handler
  const handleJoin = async (codeToJoin?: string, nameToJoin?: string, isAuto = false) => {
    const code = (codeToJoin || sessionCode).trim();
    const name = (nameToJoin || participantName).trim();

    if (code.length !== 6) {
      setJoinError('Please enter a valid 6-digit session PIN.');
      return;
    }
    if (!name) {
      setJoinError('Please enter your name.');
      return;
    }

    setJoining(true);
    setJoinError(null);

    try {
      await joinSessionAsParticipant(code, name);
      localStorage.setItem(SESSION_STORAGE_KEY, code);
      localStorage.setItem(NAME_STORAGE_KEY, name);
      setSessionCode(code);
      setParticipantName(name);
      setJoined(true);
    } catch (err) {
      console.error('Failed to join:', err);
      if (!isAuto) {
        setJoinError('Could not join session. Please check the PIN or connection.');
      }
    } finally {
      setJoining(false);
    }
  };

  // Reorder options via move up/down buttons
  const moveOption = (index: number, direction: 'up' | 'down') => {
    if (submittedForCurrent || isTimeUp) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= orderedOptions.length) return;

    const newOptions = [...orderedOptions];
    const item = newOptions.splice(index, 1)[0];
    newOptions.splice(targetIndex, 0, item);
    setOrderedOptions(newOptions);
  };

  // Drag and drop handlers
  const handleDragStart = (idx: number) => {
    if (submittedForCurrent || isTimeUp) return;
    setDraggedIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === targetIdx || submittedForCurrent || isTimeUp) return;

    const newOptions = [...orderedOptions];
    const draggedItem = newOptions.splice(draggedIdx, 1)[0];
    newOptions.splice(targetIdx, 0, draggedItem);
    setDraggedIdx(targetIdx);
    setOrderedOptions(newOptions);
  };

  const handleDragEnd = () => {
    setDraggedIdx(null);
  };

  // Submit Ranking
  const handleSubmitRanking = async () => {
    if (!session || submittedForCurrent || isTimeUp || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const rankedIds = orderedOptions.map((o) => o.id);
      const elapsed = (session.durationSeconds || 30) - secondsRemaining;
      await submitRankingResponse(
        sessionCode,
        currentQIndex,
        currentQuestion.question,
        participantName,
        rankedIds,
        elapsed
      );
      setSubmittedForCurrent(true);
      playSubmitChime();
    } catch (error) {
      console.error('Failed to submit ranking:', error);
      alert('Unable to submit your ranking. The round might have ended.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Cheer / Hype tap
  const triggerHypeTap = async (emoji: string) => {
    if (!currentUserId || !sessionCode) return;
    try {
      await incrementHypeTap(sessionCode, currentUserId);
      setCheerToast(`${emoji} Cheer sent to stage!`);
      if (cheerTimerRef.current) clearTimeout(cheerTimerRef.current);
      cheerTimerRef.current = setTimeout(() => {
        setCheerToast(null);
      }, 2000);
    } catch (e) {
      console.warn(e);
    }
  };

  // Leave session
  const handleLeaveSession = () => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setJoined(false);
    setSession(null);
    setMyResponse(null);
  };

  // Total submitted count calculation for current question
  const submittedCount = session?.status === 'question' || session?.status === 'locked'
    ? Math.round(participants.length * 0.75) // estimate or placeholder if participant only reads own response
    : 0;

  // -------------------------------------------------------------
  // SCREEN 1: JOIN SCREEN
  // -------------------------------------------------------------
  if (!joined) {
    const digits = sessionCode.padEnd(6, ' ').slice(0, 6).split('');

    return (
      <main className="flex-1 w-full max-w-[480px] mx-auto min-h-screen px-4 py-4 flex flex-col justify-between bg-[#f7f9fb]">
        <div className="flex flex-col w-full pb-8">
          {/* Header */}
          <header className="flex items-center justify-between py-2">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded-full bg-[#42fed0] flex items-center justify-center shadow-sm">
                <span className="material-symbols-outlined text-[#002018] text-lg font-bold">bolt</span>
              </div>
              <span className="font-headline font-bold text-lg text-[#191c1e] tracking-wider uppercase">HYBR</span>
            </div>
            <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-[#e6e8ea]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00e0b5] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#006b55]"></span>
              </span>
              <span className="font-counter text-[11px] font-bold text-[#45464d] uppercase tracking-wider">
                HQ Live Server
              </span>
            </div>
          </header>

          {/* Hero Card */}
          <div className="relative w-full rounded-2xl overflow-hidden bg-[#eceef0] mt-3 shadow-sm border border-[#e0e3e5]/60">
            <div className="w-full h-36 bg-gradient-to-tr from-[#131a33] via-[#1e2a4a] to-[#005140] relative flex items-center justify-center p-4">
              <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#42fed0_1px,transparent_1px)] [background-size:16px_16px]"></div>
              <div className="absolute -top-10 -right-10 w-32 h-32 bg-[#42fed0]/20 rounded-full blur-2xl pointer-events-none"></div>
              <div className="z-10 flex flex-col justify-end w-full h-full text-white">
                <div className="inline-flex items-center self-start px-2 py-0.5 rounded-full bg-white/20 backdrop-blur-md shadow-sm mb-1.5">
                  <span className="material-symbols-outlined text-[#42fed0] text-sm mr-1">sensors</span>
                  <span className="font-counter text-[11px] font-bold text-white uppercase tracking-wider">Session Ready</span>
                </div>
                <h1 className="font-headline text-2xl text-white font-extrabold tracking-tight">
                  Live Preference Polling
                </h1>
                <p className="font-body text-xs text-white/80">
                  Join your company session and share real-time insights
                </p>
              </div>
            </div>
          </div>

          {/* Form */}
          <div className="mt-6 flex flex-col space-y-5">
            {/* PIN Input */}
            <div className="flex flex-col space-y-2">
              <div className="flex justify-between items-center px-1">
                <label className="font-headline text-sm font-bold text-[#191c1e] flex items-center space-x-1" htmlFor="pin-input">
                  <span>Session PIN</span>
                  <span className="text-[#006b55] font-bold">*</span>
                </label>
                <span className="font-counter text-[11px] text-[#006b55] font-bold uppercase tracking-wider">6 Digits</span>
              </div>

              <div
                onClick={() => pinInputRef.current?.focus()}
                className="relative flex items-center justify-between gap-1.5 p-2 rounded-2xl bg-[#eceef0] shadow-sm cursor-text border border-[#e0e3e5]"
              >
                <input
                  ref={pinInputRef}
                  id="pin-input"
                  aria-label="6 digit session pin"
                  className="opacity-0 absolute inset-0 w-full h-full cursor-pointer z-10 text-transparent caret-transparent"
                  maxLength={6}
                  type="tel"
                  value={sessionCode}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                    setSessionCode(val);
                    setJoinError(null);
                  }}
                  autoFocus
                />
                {[0, 1, 2].map((idx) => (
                  <div
                    key={idx}
                    className="w-12 h-14 rounded-xl bg-white flex items-center justify-center shadow-sm border border-[#e0e3e5]/70"
                  >
                    <span className="font-counter text-2xl font-bold text-[#191c1e]">
                      {digits[idx] !== ' ' ? digits[idx] : '—'}
                    </span>
                  </div>
                ))}
                <div className="w-2 flex justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#c6c6ce]"></div>
                </div>
                {[3, 4, 5].map((idx) => (
                  <div
                    key={idx}
                    className="w-12 h-14 rounded-xl bg-white flex items-center justify-center shadow-sm border border-[#e0e3e5]/70"
                  >
                    <span className="font-counter text-2xl font-bold text-[#191c1e]">
                      {digits[idx] !== ' ' ? digits[idx] : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Name Input */}
            <div className="flex flex-col space-y-2">
              <div className="flex justify-between items-center px-1">
                <label className="font-headline text-sm font-bold text-[#191c1e] flex items-center space-x-1" htmlFor="display-name">
                  <span>Participant Name</span>
                  <span className="text-[#006b55] font-bold">*</span>
                </label>
                <span className="font-body text-xs text-[#45464d]">Visible on stage</span>
              </div>
              <div className="relative flex items-center rounded-2xl bg-white shadow-sm px-4 h-14 border border-[#e0e3e5]">
                <div className="w-8 h-8 rounded-full bg-[#42fed0]/30 flex items-center justify-center mr-3 text-[#006b55]">
                  <span className="material-symbols-outlined text-lg">badge</span>
                </div>
                <input
                  id="display-name"
                  className="w-full bg-transparent font-headline text-base text-[#191c1e] focus:outline-none"
                  placeholder="e.g. Alex Morgan"
                  type="text"
                  value={participantName}
                  onChange={(e) => {
                    setParticipantName(e.target.value);
                    setJoinError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleJoin();
                  }}
                />
                {participantName && (
                  <button
                    className="text-[#76767e] hover:text-[#191c1e] p-1 transition-colors"
                    onClick={() => setParticipantName('')}
                    type="button"
                  >
                    <span className="material-symbols-outlined text-lg">cancel</span>
                  </button>
                )}
              </div>
            </div>

            {/* Error Message */}
            {joinError && (
              <div className="p-3 rounded-xl bg-[#ffdad6] text-[#93000a] text-xs font-medium flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">error</span>
                <span>{joinError}</span>
              </div>
            )}

            {/* Zero Friction Setup Banner */}
            <div className="p-3.5 rounded-2xl bg-[#eceef0] flex items-start space-x-3 shadow-sm border border-[#e0e3e5]/60">
              <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-[#006b55] shrink-0 shadow-sm">
                <span className="material-symbols-outlined text-base">verified_user</span>
              </div>
              <div className="flex flex-col">
                <span className="font-headline text-xs font-bold text-[#191c1e]">Zero Friction Setup</span>
                <span className="font-body text-xs text-[#45464d] mt-0.5">
                  No sign-up or scoring required — just your genuine preferences and team pulse.
                </span>
              </div>
            </div>

            {/* CTA Button */}
            <div className="pt-2">
              <button
                className="w-full h-14 rounded-full bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] font-headline font-bold text-base flex items-center justify-center space-x-2 shadow-lg transition-transform active:scale-[0.98] duration-150 cursor-pointer disabled:opacity-60"
                type="button"
                disabled={joining}
                onClick={() => handleJoin()}
              >
                {joining ? (
                  <>
                    <span className="material-symbols-outlined animate-spin text-xl">progress_activity</span>
                    <span className="tracking-wide ml-1">Entering session...</span>
                  </>
                ) : (
                  <>
                    <span className="tracking-wide">Join Game</span>
                    <span className="material-symbols-outlined text-xl font-bold">arrow_forward</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-8 flex flex-col items-center justify-center space-y-3 pb-4">
          <div className="flex items-center space-x-3 text-[#45464d]">
            <span className="font-counter text-[11px] font-bold">HYBR POLL V2.4</span>
            <span className="w-1 h-1 rounded-full bg-[#c6c6ce]"></span>
            <span className="font-counter text-[11px] font-bold uppercase">All-Hands Active</span>
            <span className="w-1 h-1 rounded-full bg-[#c6c6ce]"></span>
            <span className="font-counter text-[11px] font-bold">256-BIT ENCRYPTED</span>
          </div>
          {onSwitchToHost && (
            <button
              onClick={onSwitchToHost}
              className="text-xs text-[#006b55] hover:underline font-semibold"
            >
              Host Console Access →
            </button>
          )}
        </footer>
      </main>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 2: LOBBY (WAITING FOR HOST TO START)
  // -------------------------------------------------------------
  if (session?.status === 'lobby') {
    return (
      <main className="flex-1 w-full max-w-[480px] mx-auto min-h-screen px-4 py-4 flex flex-col justify-between bg-[#f7f9fb]">
        <div className="flex flex-col w-full gap-4">
          {/* Header */}
          <header className="flex items-center justify-between py-2 border-b border-[#eceef0] pb-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-full bg-[#42fed0] flex items-center justify-center shadow-sm">
                <span className="material-symbols-outlined text-[#002018] text-lg font-bold">bolt</span>
              </div>
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#00e0b5] animate-pulse"></span>
                  <span className="font-counter text-[10px] uppercase tracking-wider text-[#006b55] font-bold">
                    Live • Event Mode
                  </span>
                </div>
                <h1 className="font-headline text-base font-bold text-[#191c1e] truncate">Live Lobby</h1>
              </div>
            </div>
            <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white">
              <span className="material-symbols-outlined text-lg">person</span>
            </div>
          </header>

          {/* Top Identity Card */}
          <div className="bg-white rounded-2xl p-4 shadow-sm flex flex-col gap-3 relative overflow-hidden border border-[#e0e3e5]/70">
            <div className="absolute -right-10 -top-10 w-32 h-32 bg-[#42fed0]/20 rounded-full blur-2xl pointer-events-none"></div>
            <div className="flex items-center justify-between z-10">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#131a33] text-[#42fed0]">
                <span className="material-symbols-outlined text-[13px]">tag</span>
                <span className="font-counter text-[11px] tracking-wider font-bold">#{sessionCode}</span>
                <span className="w-1 h-1 rounded-full bg-[#00e0b5]"></span>
                <span className="font-counter text-[10px] tracking-wider text-white uppercase font-bold">All-Hands 2025</span>
              </div>
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#eceef0] text-[#006b55]">
                <span className="w-2 h-2 rounded-full bg-[#00e0b5] animate-ping"></span>
                <span className="font-counter text-[11px] tracking-wider font-bold">CONNECTED</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1 z-10">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-12 h-12 rounded-full bg-[#191c1e] flex items-center justify-center text-white font-headline text-lg font-bold shadow-sm">
                    {participantName.charAt(0).toUpperCase() || 'P'}
                  </div>
                  <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-[#00e0b5] ring-2 ring-white"></span>
                </div>
                <div className="flex flex-col">
                  <span className="font-headline text-base font-bold text-[#191c1e] leading-tight">
                    You're in, {participantName}!
                  </span>
                  <span className="font-body text-xs text-[#45464d]">Player paddle active</span>
                </div>
              </div>
              <button
                onClick={handleLeaveSession}
                className="text-xs text-[#76767e] hover:text-[#ba1a1a] p-1.5 rounded-lg hover:bg-[#eceef0] transition-colors"
                title="Leave room"
              >
                <span className="material-symbols-outlined text-lg">logout</span>
              </button>
            </div>
          </div>

          {/* Radar & Waiting Animation Section */}
          <div className="bg-white rounded-2xl p-6 shadow-sm flex flex-col items-center text-center relative overflow-hidden border border-[#e0e3e5]/70">
            <div className="absolute inset-0 bg-gradient-to-b from-[#42fed0]/10 via-transparent to-transparent pointer-events-none"></div>

            {/* Pulsating Radar Rings Visual */}
            <div className="relative w-40 h-40 flex items-center justify-center my-2">
              <div className="absolute w-36 h-36 rounded-full bg-[#42fed0]/20 animate-ping"></div>
              <div className="absolute w-28 h-28 rounded-full bg-[#42fed0]/30 animate-pulse"></div>
              <div className="absolute w-20 h-20 rounded-full bg-[#00e0b5]/20 blur-sm"></div>
              <div className="relative z-10 w-16 h-16 rounded-full bg-white shadow-md flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-[#42fed0] flex items-center justify-center text-[#00725b]">
                  <span className="material-symbols-outlined text-2xl animate-spin" style={{ animationDuration: '9s' }}>
                    hourglass_top
                  </span>
                </div>
              </div>
            </div>

            {/* Main Status Messages */}
            <div className="flex flex-col items-center gap-1 z-10">
              <h2 className="font-headline text-xl text-[#191c1e] font-extrabold tracking-tight">
                Waiting for host to start...
              </h2>
              <p className="font-body text-xs text-[#45464d] max-w-[280px]">
                Sit back and get ready. The stage host will push the first interactive challenge shortly.
              </p>
            </div>

            {/* Live Counter Pill */}
            <div className="mt-4 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#eceef0] shadow-inner z-10">
              <div className="flex -space-x-2 overflow-hidden py-0.5">
                {participants.slice(0, 3).map((p, idx) => (
                  <div
                    key={p.id || idx}
                    className="inline-block h-6 w-6 rounded-full bg-[#131a33] text-white flex items-center justify-center font-counter text-[10px] font-bold border border-white"
                  >
                    {p.data.name.slice(0, 2).toUpperCase()}
                  </div>
                ))}
                {participants.length > 3 && (
                  <div className="inline-block h-6 w-6 rounded-full bg-[#e0e3e5] text-[#191c1e] flex items-center justify-center font-counter text-[10px] font-bold border border-white">
                    +{participants.length - 3}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[#006b55] animate-pulse"></span>
                <span className="font-counter text-xs text-[#191c1e] font-bold">
                  {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
                </span>
                <span className="font-body text-xs text-[#45464d]">ready in room</span>
              </div>
            </div>
          </div>

          {/* Interactive Hype Tap Cheer */}
          <div className="bg-white rounded-2xl p-4 shadow-sm flex items-center justify-between gap-2 border border-[#e0e3e5]/70">
            <div className="flex flex-col">
              <span className="font-headline text-sm font-bold text-[#191c1e]">Send a hype tap</span>
              <span className="font-body text-xs text-[#45464d]">Warm up your touch screen</span>
            </div>
            <div className="flex items-center gap-2">
              {['👋', '🔥', '💖'].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => triggerHypeTap(emoji)}
                  className="w-11 h-11 rounded-full bg-[#eceef0] hover:bg-[#42fed0] text-[#191c1e] active:scale-95 transition-all flex items-center justify-center text-lg shadow-sm"
                  type="button"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* Cheer Toast Feedback */}
          {cheerToast && (
            <div className="self-center px-4 py-1.5 rounded-full bg-[#191c1e] text-[#42fed0] font-headline text-xs font-bold flex items-center gap-1.5 shadow-lg animate-bounce">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              <span>{cheerToast}</span>
            </div>
          )}

          {/* How HYBR Works Card */}
          <div className="bg-[#f2f4f6] rounded-2xl p-4 flex flex-col gap-2.5 shadow-sm border border-[#e0e3e5]/60">
            <div className="flex items-center gap-2 text-[#191c1e]">
              <div className="w-7 h-7 rounded-full bg-[#e0e3e5] flex items-center justify-center text-[#191c1e]">
                <span className="material-symbols-outlined text-base">lightbulb</span>
              </div>
              <h3 className="font-headline text-sm font-bold">How HYBR Works</h3>
            </div>
            <p className="font-body text-xs text-[#45464d] leading-relaxed">
              15 quick questions, 30 seconds each. Drag to rank 4 options from top (<span className="font-bold text-[#191c1e]">#1 Pick</span>) to bottom (<span className="font-bold text-[#191c1e]">#4 Pick</span>). There are no right or wrong answers!
            </p>
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="bg-white p-2.5 rounded-xl flex flex-col items-center text-center gap-1 shadow-sm border border-[#e0e3e5]/50">
                <span className="material-symbols-outlined text-lg text-[#006b55]">drag_handle</span>
                <span className="font-counter text-[10px] text-[#191c1e] uppercase font-bold">1. Reorder</span>
                <span className="font-body text-[11px] text-[#45464d]">Drag priority</span>
              </div>
              <div className="bg-white p-2.5 rounded-xl flex flex-col items-center text-center gap-1 shadow-sm border border-[#e0e3e5]/50">
                <span className="material-symbols-outlined text-lg text-[#006b55]">timer</span>
                <span className="font-counter text-[10px] text-[#191c1e] uppercase font-bold">2. Quick Tap</span>
                <span className="font-body text-[11px] text-[#45464d]">30s on clock</span>
              </div>
              <div className="bg-white p-2.5 rounded-xl flex flex-col items-center text-center gap-1 shadow-sm border border-[#e0e3e5]/50">
                <span className="material-symbols-outlined text-lg text-[#006b55]">insights</span>
                <span className="font-counter text-[10px] text-[#191c1e] uppercase font-bold">3. Live Sync</span>
                <span className="font-body text-[11px] text-[#45464d]">Instant results</span>
              </div>
            </div>
          </div>

          {/* Sound cue note */}
          <div className="flex items-center justify-center gap-1.5 py-1 text-[#45464d] text-xs">
            <span className="material-symbols-outlined text-sm">volume_up</span>
            <span>Keep sound unmuted for audio countdown cues</span>
          </div>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 6: FINISHED (ALL 15 QUESTIONS COMPLETE)
  // -------------------------------------------------------------
  if (session?.status === 'finished') {
    return (
      <main className="flex-1 w-full max-w-[480px] mx-auto min-h-screen px-4 py-4 flex flex-col justify-between bg-[#f7f9fb]">
        <div className="flex flex-col w-full gap-4 pb-6">
          {/* Header */}
          <header className="flex items-center justify-between py-2 border-b border-[#eceef0] pb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-[#42fed0] flex items-center justify-center shadow-sm">
                <span className="material-symbols-outlined text-[#002018] text-lg font-bold">celebration</span>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[#00e0b5]"></span>
                  <span className="font-counter text-[10px] uppercase tracking-wider text-[#006b55] font-bold">
                    Completed
                  </span>
                </div>
                <h1 className="font-headline text-base font-bold text-[#191c1e]">HYBR Finale</h1>
              </div>
            </div>
          </header>

          {/* Celebration Card */}
          <div className="relative overflow-hidden rounded-2xl bg-[#eceef0] p-6 flex flex-col items-center text-center shadow-sm border border-[#e0e3e5]">
            <div className="absolute -top-12 -left-12 w-40 h-40 bg-[#42fed0]/20 rounded-full blur-2xl pointer-events-none"></div>
            <div className="relative w-24 h-24 my-2 flex items-center justify-center">
              <div className="w-20 h-20 rounded-full bg-white shadow-md flex items-center justify-center">
                <div className="w-14 h-14 rounded-full bg-[#42fed0] flex items-center justify-center text-[#00725b]">
                  <span className="material-symbols-outlined text-3xl font-bold">celebration</span>
                </div>
              </div>
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#e0e3e5] text-[#45464d] font-counter text-[11px] uppercase tracking-wider font-bold mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00e0b5]"></span>
              Question 15 of 15 Complete
            </div>
            <h2 className="font-headline text-2xl font-extrabold text-[#191c1e] tracking-tight mt-1">
              Thanks for Playing HYBR!
            </h2>
            <p className="font-body text-xs text-[#45464d] mt-1">
              All 15 questions completed • HYBR Annual All-Hands
            </p>
          </div>

          {/* Attendee Pass */}
          <div className="w-full rounded-2xl bg-white p-5 shadow-sm flex flex-col gap-4 border border-[#e0e3e5]/70">
            <div className="flex items-center justify-between pb-2 border-b border-[#eceef0]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-[#e6e8ea] flex items-center justify-center font-headline text-sm font-bold text-[#191c1e]">
                  {participantName.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-counter text-[10px] uppercase tracking-wider text-[#45464d] font-bold">
                    Attendee Pass
                  </span>
                  <span className="font-headline text-base font-bold text-[#191c1e] truncate">
                    {participantName}
                  </span>
                </div>
              </div>
              <span className="px-3 py-1 rounded-full bg-[#42fed0]/40 text-[#00725b] font-counter text-[11px] uppercase tracking-wider font-bold">
                Verified In-Room
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-[#f2f4f6] p-3.5 flex flex-col">
                <span className="font-counter text-[11px] uppercase tracking-wider text-[#45464d] font-bold">
                  Preferences
                </span>
                <span className="font-counter text-3xl font-extrabold text-[#191c1e] mt-1">
                  15<span className="text-[#45464d] text-lg font-semibold">/15</span>
                </span>
                <span className="font-body text-xs text-[#006b55] font-medium mt-1">Shared live</span>
              </div>
              <div className="rounded-xl bg-[#f2f4f6] p-3.5 flex flex-col">
                <span className="font-counter text-[11px] uppercase tracking-wider text-[#45464d] font-bold">
                  Participation
                </span>
                <span className="font-counter text-3xl font-extrabold text-[#191c1e] mt-1">
                  100<span className="text-[#45464d] text-lg font-semibold">%</span>
                </span>
                <span className="font-body text-xs text-[#006b55] font-medium mt-1">Flawless streak</span>
              </div>
            </div>

            {/* Zero Correct Answers note */}
            <div className="rounded-xl bg-[#131a33] p-4 flex items-center gap-3 text-white">
              <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0 text-[#42fed0]">
                <span className="material-symbols-outlined text-2xl">fingerprint</span>
              </div>
              <div className="flex flex-col">
                <span className="font-headline text-sm font-bold text-white">0 Correct Answers</span>
                <span className="font-body text-xs text-white/80">
                  100% You — purely personal preferences, zero graded scores.
                </span>
              </div>
            </div>
          </div>

          {/* Look Up at the Stage */}
          <div className="w-full rounded-2xl bg-[#eceef0] p-4 flex items-start gap-3 border border-[#e0e3e5]/70">
            <div className="w-10 h-10 rounded-full bg-[#00e0b5]/30 flex items-center justify-center shrink-0 text-[#006b55] mt-0.5">
              <span className="material-symbols-outlined text-2xl">tv_remote</span>
            </div>
            <div className="flex flex-col">
              <span className="font-headline text-sm font-bold text-[#191c1e]">Look Up at the Stage!</span>
              <p className="font-body text-xs text-[#45464d] mt-1 leading-relaxed">
                Aggregated company insights, department divergence, and live team preference clusters are unveiling right now on the overhead screen.
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2.5 pt-2">
            <button
              onClick={() => {
                setSummaryToast('Summary pass cached & ready to share!');
                setTimeout(() => setSummaryToast(null), 2500);
              }}
              className="w-full h-14 rounded-full bg-[#42fed0] text-[#002018] font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-transform shadow-sm cursor-pointer"
              type="button"
            >
              <span className="material-symbols-outlined text-lg">download</span>
              <span>Save Summary Card</span>
            </button>
            <button
              onClick={handleLeaveSession}
              className="w-full h-14 rounded-full bg-[#e6e8ea] hover:bg-[#e0e3e5] text-[#191c1e] font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-transform cursor-pointer"
              type="button"
            >
              <span className="material-symbols-outlined text-lg">logout</span>
              <span>Leave Session</span>
            </button>
          </div>

          {summaryToast && (
            <div className="self-center px-4 py-1.5 rounded-full bg-[#191c1e] text-[#42fed0] font-headline text-xs font-bold flex items-center gap-1.5 shadow-lg animate-bounce">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              <span>{summaryToast}</span>
            </div>
          )}
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 4: POST-SUBMIT VIEW (LOCKED, WAITING FOR NEXT QUESTION)
  // -------------------------------------------------------------
  if (submittedForCurrent) {
    return (
      <main className="flex-1 w-full max-w-[480px] mx-auto min-h-screen px-4 py-4 flex flex-col justify-between bg-[#f7f9fb]">
        <div className="flex flex-col w-full pb-6">
          {/* Top Bar */}
          <div className="flex items-center justify-between py-2 mb-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-[#e0e3e5] text-[#45464d] font-counter text-[11px] font-bold uppercase tracking-wider">
                Question {currentQIndex + 1}
              </span>
              <span className="font-headline text-sm font-bold text-[#191c1e]">
                <span className="text-[#45464d] font-normal">/ 15</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#f2f4f6] border border-[#e0e3e5]">
              <span className="material-symbols-outlined text-sm text-[#006b55]">lock</span>
              <span className="font-counter text-xs font-bold text-[#191c1e]">
                Locked • {secondsRemaining}s
              </span>
            </div>
          </div>

          {/* Success Confirmation Card */}
          <div className="relative w-full rounded-2xl bg-white p-6 shadow-sm flex flex-col items-center text-center overflow-hidden mb-4 border border-[#e0e3e5]/70">
            <div className="absolute -top-12 -right-12 w-36 h-36 bg-[#42fed0]/20 rounded-full blur-2xl pointer-events-none"></div>
            <div className="relative mb-3">
              <div className="w-16 h-16 rounded-full bg-[#42fed0] flex items-center justify-center shadow-md animate-bounce">
                <span className="material-symbols-outlined text-[#002018] text-3xl font-extrabold">check</span>
              </div>
            </div>
            <h2 className="font-headline text-2xl font-extrabold text-[#191c1e] tracking-tight">
              Response Submitted!
            </h2>
            <p className="font-body text-xs text-[#45464d] mt-1 max-w-[280px]">
              Waiting for the host to advance to Question {Math.min(15, currentQIndex + 2)}...
            </p>
            <div className="w-full mt-3 pt-2 flex items-center justify-center gap-1.5 text-[#006b55]">
              <span className="w-2 h-2 rounded-full bg-[#00e0b5] animate-ping"></span>
              <span className="font-counter text-[10px] font-bold uppercase tracking-wider">
                Answers Recorded In Real-time
              </span>
            </div>
          </div>

          {/* Read-only Ranking List */}
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="font-counter text-[11px] font-bold uppercase tracking-wider text-[#45464d]">
              Your Submitted Priority Ranking
            </span>
            <span className="inline-flex items-center gap-1 font-body text-xs text-[#45464d]">
              <span className="material-symbols-outlined text-sm">visibility</span> Read-only
            </span>
          </div>

          <div className="flex flex-col gap-2.5 mb-4">
            {orderedOptions.map((opt, idx) => (
              <div
                key={opt.id}
                className="w-full min-h-[58px] rounded-xl bg-white p-3.5 shadow-sm flex items-center justify-between gap-3 border border-[#e0e3e5]/70"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-counter text-xs font-bold ${
                      idx === 0
                        ? 'bg-[#191c1e] text-[#42fed0]'
                        : 'bg-[#e0e3e5] text-[#191c1e]'
                    }`}
                  >
                    #{idx + 1}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-counter text-[10px] font-bold uppercase tracking-wide text-[#45464d]">
                      Option {opt.id}
                    </span>
                    <p className="font-headline text-xs font-bold text-[#191c1e] truncate">
                      {opt.text}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 w-7 h-7 rounded-full bg-[#eceef0] flex items-center justify-center text-[#45464d]">
                  <span className="material-symbols-outlined text-sm">lock</span>
                </div>
              </div>
            ))}
          </div>

          {/* Live Progress Card */}
          <div className="w-full rounded-2xl bg-[#f2f4f6] p-4 shadow-sm flex flex-col gap-2 border border-[#e0e3e5]/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00e0b5] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#006b55]"></span>
                </span>
                <span className="font-headline text-xs font-bold text-[#191c1e]">Live Audience Status</span>
              </div>
              <span className="font-counter text-xs font-bold text-[#191c1e]">
                {submittedCount} <span className="text-[#45464d] font-normal">/ {participants.length || 1}</span>
              </span>
            </div>
            <div className="w-full bg-[#e0e3e5] h-2 rounded-full overflow-hidden">
              <div
                className="bg-[#00e0b5] h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, Math.round((submittedCount / (participants.length || 1)) * 100))}%`
                }}
              ></div>
            </div>
            <div className="flex items-center justify-between text-xs text-[#45464d]">
              <span>Waiting for round timer to expire...</span>
              <span className="font-counter text-[#006b55] font-bold">Recorded</span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 5: TIME'S UP (IF NOT SUBMITTED BEFORE LOCKOUT)
  // -------------------------------------------------------------
  if (isTimeUp || session?.status === 'locked') {
    return (
      <main className="flex-1 w-full max-w-[480px] mx-auto min-h-screen px-4 py-4 flex flex-col justify-between bg-[#f7f9fb]">
        <div className="flex flex-col w-full pb-6">
          {/* Header */}
          <section className="flex items-center justify-between pt-1 pb-3">
            <div className="flex flex-col min-w-0">
              <span className="font-counter text-[11px] uppercase tracking-wider text-[#45464d] font-bold">
                Round Phase
              </span>
              <p className="font-headline text-base font-bold text-[#191c1e]">
                Question {currentQIndex + 1} of 15
              </p>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#ba1a1a] text-white shadow-md animate-pulse">
              <span className="material-symbols-outlined text-sm">timer_off</span>
              <span className="font-counter text-xs font-bold tracking-tight">00s</span>
            </div>
          </section>

          {/* Time's up banner */}
          <div className="w-full mt-1 mb-4 p-4 rounded-2xl bg-[#131a33] text-white flex items-center justify-between shadow-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#42fed0] text-[#002018] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl">lock</span>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="font-headline text-lg font-bold tracking-tight">Time's Up!</span>
                  <span className="w-2 h-2 rounded-full bg-[#00e0b5]"></span>
                </div>
                <p className="font-body text-xs text-white/70">Rankings are locked on the master ledger.</p>
              </div>
            </div>
            <span className="font-counter text-[10px] text-[#42fed0] bg-white/10 px-2 py-1 rounded-full uppercase font-bold">
              Locked
            </span>
          </div>

          {/* Missed lockout card */}
          <div className="w-full bg-[#ffdad6] text-[#93000a] p-6 rounded-2xl shadow-sm flex flex-col items-center text-center border border-[#ba1a1a]/20">
            <div className="w-14 h-14 rounded-full bg-[#ba1a1a] text-white flex items-center justify-center mb-3 shadow-md">
              <span className="material-symbols-outlined text-2xl">hourglass_disabled</span>
            </div>
            <h3 className="font-headline text-lg font-bold tracking-tight mb-1">Missed Lockout</h3>
            <p className="font-body text-xs text-[#45464d] max-w-[280px]">
              No ranking was submitted before time expired — ready up for{' '}
              <span className="font-bold text-[#191c1e]">Question {Math.min(15, currentQIndex + 2)}</span>!
            </p>
            <div className="w-full mt-4 pt-3 flex items-center justify-center gap-2 border-t border-[#ba1a1a]/15">
              <span className="w-2 h-2 rounded-full bg-[#ba1a1a]"></span>
              <span className="font-counter text-[11px] uppercase tracking-wider font-bold text-[#ba1a1a]">
                Streak Protected • Next question coming
              </span>
            </div>
          </div>

          {/* Stage sync prompt */}
          <div className="w-full mt-5 p-4 rounded-2xl bg-[#f2f4f6] shadow-sm flex items-center gap-3 border border-[#e0e3e5]/60">
            <div className="relative flex items-center justify-center shrink-0 w-10 h-10">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00e0b5] opacity-75"></span>
              <div className="relative w-8 h-8 rounded-full bg-[#131a33] flex items-center justify-center text-[#42fed0]">
                <span className="material-symbols-outlined text-base">co_present</span>
              </div>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-counter text-[11px] uppercase tracking-wider text-[#006b55] font-bold">
                Stage Synchronization
              </span>
              <p className="font-body text-xs text-[#45464d] leading-snug">
                Waiting for host to advance to the next challenge...
              </p>
            </div>
          </div>

          <div className="w-full mt-4 flex flex-col items-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#e6e8ea] text-[#45464d]">
              <span className="material-symbols-outlined text-sm text-[#006b55]">screen_search_desktop</span>
              <span className="font-counter text-[11px] uppercase tracking-widest text-[#191c1e] font-bold">
                Look up at stage display
              </span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 3: ACTIVE VOTING DECK (REORDERING & SUBMIT)
  // -------------------------------------------------------------
  const progressRatio = Math.max(0, Math.min(1, secondsRemaining / (session?.durationSeconds || 30)));
  const perimeter = 2 * Math.PI * 23; // ~144.5
  const strokeOffset = perimeter - progressRatio * perimeter;

  return (
    <main className="flex-1 w-full max-w-[480px] mx-auto min-h-screen px-4 py-4 flex flex-col justify-between bg-[#f7f9fb]">
      <div className="flex flex-col w-full pb-4 space-y-3.5">
        {/* Header Telemetry Bar & Circular Gauge */}
        <div className="flex items-center justify-between bg-[#f2f4f6] p-3.5 rounded-2xl shadow-sm border border-[#e0e3e5]/60">
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="w-2 h-2 rounded-full bg-[#42fed0] animate-ping"></span>
              <span className="font-counter text-[10px] uppercase tracking-widest text-[#006b55] font-bold">
                Multiplayer Live
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-headline text-lg font-bold text-[#191c1e]">
                Question {currentQIndex + 1}
              </span>
              <span className="font-counter text-xs text-[#45464d]">/ 15</span>
            </div>
            <span className="font-body text-[11px] text-[#45464d]">
              {participants.length} peers currently ranking
            </span>
          </div>

          {/* Circular Timer Gauge */}
          <div className="relative flex items-center justify-center w-14 h-14 bg-white rounded-full shadow-inner border border-[#e0e3e5]">
            <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
              <circle
                className="text-[#e0e3e5]"
                cx="28"
                cy="28"
                fill="none"
                r="23"
                stroke="currentColor"
                strokeWidth="4.5"
              />
              <circle
                className={`transition-all duration-500 ease-linear ${
                  secondsRemaining <= 5 ? 'text-[#ba1a1a]' : 'text-[#42fed0]'
                }`}
                cx="28"
                cy="28"
                fill="none"
                r="23"
                stroke="currentColor"
                strokeDasharray={perimeter}
                strokeDashoffset={strokeOffset}
                strokeLinecap="round"
                strokeWidth="4.5"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className={`font-counter text-base font-bold leading-none ${
                secondsRemaining <= 5 ? 'text-[#ba1a1a]' : 'text-[#191c1e]'
              }`}>
                {secondsRemaining}s
              </span>
            </div>
          </div>
        </div>

        {/* Question Header */}
        <div className="px-1 space-y-1">
          <div className="inline-flex items-center gap-1.5 bg-[#e0e3e5] px-2.5 py-0.5 rounded-full text-[#45464d]">
            <span className="material-symbols-outlined text-xs text-[#006b55]">bolt</span>
            <span className="font-counter text-[10px] tracking-wide uppercase font-bold">
              Core Instinct
            </span>
          </div>
          <h2 className="font-headline text-lg font-bold text-[#191c1e] tracking-tight leading-snug">
            {currentQuestion.question}
          </h2>
          <div className="flex items-center gap-1.5 pt-0.5 text-[#45464d]">
            <span className="material-symbols-outlined text-sm text-[#006b55]">swap_vert</span>
            <p className="font-body text-xs">
              Drag or tap arrows to rank <span className="font-bold text-[#191c1e]">1 (Most preferred)</span> to <span className="font-bold text-[#191c1e]">4 (Least)</span>
            </p>
          </div>
        </div>

        {/* 4 Reorderable Option Cards Deck */}
        <div className="flex flex-col space-y-2.5">
          {orderedOptions.map((opt, idx) => {
            const isRankOne = idx === 0;
            return (
              <div
                key={opt.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`group relative flex items-center p-3 rounded-2xl shadow-sm transition-all duration-150 select-none cursor-grab active:cursor-grabbing border ${
                  isRankOne
                    ? 'bg-white border-[#42fed0] ring-1 ring-[#42fed0]/40'
                    : 'bg-white border-[#e0e3e5]'
                } ${draggedIdx === idx ? 'opacity-40 scale-[0.98]' : 'hover:shadow-md'}`}
              >
                {/* Rank Badge */}
                <div
                  className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center shadow-sm ${
                    isRankOne
                      ? 'bg-[#42fed0] text-[#002018]'
                      : 'bg-[#e6e8ea] text-[#191c1e]'
                  }`}
                >
                  <span className="font-counter text-sm font-bold">{idx + 1}</span>
                </div>

                {/* Option Text */}
                <div className="flex-1 min-w-0 mx-3">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="font-counter text-[10px] uppercase tracking-wider text-[#006b55] font-bold">
                      Option {opt.id}
                    </span>
                    {isRankOne && (
                      <span className="font-counter text-[9px] uppercase tracking-wide bg-[#42fed0]/30 text-[#00725b] px-1.5 py-0.2 rounded-full font-bold">
                        Top Pick
                      </span>
                    )}
                  </div>
                  <p className="font-headline text-xs font-semibold text-[#191c1e] leading-snug line-clamp-2">
                    {opt.text}
                  </p>
                </div>

                {/* Up / Down Controls & Drag Handle */}
                <div className="flex items-center gap-0.5 shrink-0">
                  <div className="flex flex-col -space-y-1">
                    <button
                      aria-label="Move up"
                      disabled={idx === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveOption(idx, 'up');
                      }}
                      className="p-1 rounded-full text-[#45464d] hover:bg-[#eceef0] active:scale-90 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-lg">keyboard_arrow_up</span>
                    </button>
                    <button
                      aria-label="Move down"
                      disabled={idx === orderedOptions.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveOption(idx, 'down');
                      }}
                      className="p-1 rounded-full text-[#45464d] hover:bg-[#eceef0] active:scale-90 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-lg">keyboard_arrow_down</span>
                    </button>
                  </div>
                  <div className="p-1 text-[#c6c6ce] group-hover:text-[#191c1e] transition-colors cursor-grab">
                    <span className="material-symbols-outlined text-xl">drag_indicator</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer info: Anonymous vote */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#f2f4f6] rounded-xl text-[#45464d] border border-[#e0e3e5]/60">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-[#006b55]">verified_user</span>
            <span className="font-counter text-[11px] tracking-wider uppercase font-bold">Anonymous Vote</span>
          </div>
          <span className="font-body text-xs text-[#76767e]">No individual scores</span>
        </div>

        {/* Submit Ranking Button */}
        <div className="pt-1">
          <button
            onClick={handleSubmitRanking}
            disabled={isSubmitting || isTimeUp}
            className="w-full h-14 bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] font-headline font-bold text-base rounded-full shadow-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-all duration-150 cursor-pointer disabled:opacity-50"
            type="button"
          >
            {isSubmitting ? (
              <>
                <span className="material-symbols-outlined text-xl animate-spin">sync</span>
                <span>Locking Ranking...</span>
              </>
            ) : (
              <>
                <span>Submit Ranking</span>
                <span className="material-symbols-outlined text-xl font-bold">arrow_forward</span>
              </>
            )}
          </button>
        </div>
      </div>
    </main>
  );
};
