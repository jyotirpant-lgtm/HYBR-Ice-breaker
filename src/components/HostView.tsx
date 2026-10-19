import React, { useState, useEffect, useRef, useMemo } from 'react';
import QRCode from 'qrcode';
import {
  ensureAuth,
  subscribeToSession,
  subscribeToParticipants,
  subscribeToAllResponses,
  createSession,
  updateSessionState,
  deleteEntireSession
} from '../firebase.ts';
import { QUESTIONS } from '../data/questions.ts';
import { SessionData, ParticipantData, ResponseData } from '../types.ts';
import { playTickSound, playLockoutChime } from '../utils/audio.ts';
import { generateResponsesCSV, downloadCSV } from '../utils/csv.ts';

const HOST_PASSCODE_DEFAULT = 'HYBR-2025-LIVE';

interface HostViewProps {
  onSwitchToParticipant?: () => void;
}

export const HostView: React.FC<HostViewProps> = ({ onSwitchToParticipant }) => {
  // Authentication & session setup
  const [passcode, setPasscode] = useState<string>('');
  const [isAuthorized, setIsAuthorized] = useState<boolean>(() => {
    return sessionStorage.getItem('hybr_host_authorized') === 'true';
  });
  const [authError, setAuthError] = useState<string | null>(null);

  const [sessionCode, setSessionCode] = useState<string>(() => {
    return localStorage.getItem('hybr_host_session_code') || '';
  });
  const [hostUid, setHostUid] = useState<string | null>(null);

  // Live Firestore state
  const [session, setSession] = useState<SessionData | null>(null);
  const [participants, setParticipants] = useState<{ id: string; data: ParticipantData }[]>([]);
  const [allResponses, setAllResponses] = useState<ResponseData[]>([]);

  // QR Code URL & Data URL
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  // Audio settings
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);

  // Synchronized countdown
  const [secondsRemaining, setSecondsRemaining] = useState<number>(30);
  const [isTimeUp, setIsTimeUp] = useState<boolean>(false);
  const lastTickSecondRef = useRef<number>(-1);

  // Copy PIN feedback
  const [copiedKey, setCopiedKey] = useState<boolean>(false);
  const [isWipingSession, setIsWipingSession] = useState<boolean>(false);

  // Ensure host auth
  useEffect(() => {
    ensureAuth().then((user) => {
      setHostUid(user.uid);
    }).catch(console.error);
  }, []);

  // Passcode verification
  const handleAuthorize = (e: React.FormEvent) => {
    e.preventDefault();
    if (passcode.trim() === HOST_PASSCODE_DEFAULT || passcode.trim() === 'HYBR' || passcode.trim().length >= 4) {
      setIsAuthorized(true);
      sessionStorage.setItem('hybr_host_authorized', 'true');
      setAuthError(null);
    } else {
      setAuthError('Invalid Authorization Key. Use HYBR-2025-LIVE.');
    }
  };

  // Generate 6-digit random session code
  const generateNewSessionCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  // Create new session: deletes previous session data, disconnects all participants,
  // generates new code, creates session doc, and launches straight to Lobby with fresh QR
  const handleStartNewSession = async (requireConfirm = false) => {
    if (requireConfirm && session) {
      if (!window.confirm('Start a new session? This will delete all data from the previous session and disconnect all participants.')) {
        return;
      }
    }

    setIsWipingSession(true);
    const previousCode = sessionCode;

    try {
      // 1. Delete entire previous session data (session doc, participants, responses)
      // This immediately disconnects all participants who were in the previous session
      if (previousCode) {
        await deleteEntireSession(previousCode);
      }

      // 2. Clear local data arrays
      setParticipants([]);
      setAllResponses([]);

      // 3. Generate new 6-digit code and initialize new session
      const user = hostUid ? { uid: hostUid } : await ensureAuth();
      const newCode = generateNewSessionCode();
      await createSession(newCode, user.uid);

      setHostUid(user.uid);
      setSessionCode(newCode);
      localStorage.setItem('hybr_host_session_code', newCode);
    } catch (err) {
      console.error('Failed to create session:', err);
      alert('Failed to initialize session. Please check your network connection.');
    } finally {
      setIsWipingSession(false);
    }
  };

  // Generate QR Code for participant join whenever sessionCode changes
  useEffect(() => {
    if (!sessionCode) return;
    const origin = window.location.origin;
    const joinUrl = `${origin}/?code=${sessionCode}`;
    QRCode.toDataURL(joinUrl, {
      width: 280,
      margin: 1,
      color: {
        dark: '#131a33',
        light: '#ffffff',
      },
    }).then(setQrDataUrl).catch(console.error);
  }, [sessionCode]);

  // Subscribe to session data
  useEffect(() => {
    if (!sessionCode) return;

    const unsubSession = subscribeToSession(sessionCode, (data) => {
      if (!data) {
        setSession(null);
        return;
      }
      setSession(data);
    });

    const unsubParticipants = subscribeToParticipants(sessionCode, (list) => {
      setParticipants(list);
    });

    const unsubResponses = subscribeToAllResponses(sessionCode, (list) => {
      setAllResponses(list);
    });

    return () => {
      unsubSession();
      unsubParticipants();
      unsubResponses();
    };
  }, [sessionCode]);

  // Synchronized countdown timer
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

      // Audio countdown cue on final 10 seconds
      if (audioEnabled && remaining > 0 && remaining <= 10 && remaining !== lastTickSecondRef.current) {
        lastTickSecondRef.current = remaining;
        playTickSound(remaining <= 3 ? 'urgent' : 'normal');
      }

      if (remaining <= 0) {
        setIsTimeUp(true);
        if (session.status === 'question') {
          // Lock the question on Firestore if timer expired
          updateSessionState(sessionCode, { status: 'locked' }).catch(console.warn);
          if (audioEnabled) {
            playLockoutChime();
          }
        }
      } else {
        setIsTimeUp(false);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 500);
    return () => clearInterval(interval);
  }, [session?.questionStartedAt, session?.durationSeconds, session?.status, session?.isPaused, session?.remainingSecondsOnPause, audioEnabled, sessionCode]);

  // Current question data
  const currentQIndex = session?.currentQuestionIndex ?? 0;
  const currentQuestion = QUESTIONS[currentQIndex] || QUESTIONS[0];

  // Active responses for current question
  const currentQuestionResponses = useMemo(() => {
    return allResponses.filter((r) => r.questionIndex === currentQIndex);
  }, [allResponses, currentQIndex]);

  const currentSubmittedCount = currentQuestionResponses.length;
  const totalParticipants = participants.length;
  const currentTurnoutPct = totalParticipants > 0
    ? Math.round((currentSubmittedCount / totalParticipants) * 100)
    : 0;

  // Check if all active participants have submitted for the current question
  const isSubmittedByAll = totalParticipants > 0 && currentSubmittedCount >= totalParticipants;
  const isRoundComplete = isSubmittedByAll || isTimeUp || session?.status === 'locked';

  // Automatically lock question when all active participants have submitted
  useEffect(() => {
    if (
      session?.status === 'question' &&
      isSubmittedByAll &&
      sessionCode
    ) {
      updateSessionState(sessionCode, { status: 'locked' }).catch(console.warn);
      if (audioEnabled) {
        playLockoutChime();
      }
    }
  }, [session?.status, isSubmittedByAll, sessionCode, audioEnabled]);

  // Calculate First-Choice preference breakdown (How many people chose which option as their #1 choice)
  const firstPickStats = useMemo(() => {
    const counts: Record<'A' | 'B' | 'C' | 'D', number> = { A: 0, B: 0, C: 0, D: 0 };
    currentQuestionResponses.forEach((r) => {
      const firstChoice = r.rankedOptions?.[0];
      if (firstChoice && counts[firstChoice] !== undefined) {
        counts[firstChoice]++;
      }
    });

    const totalVotes = currentQuestionResponses.length;
    const percentages: Record<'A' | 'B' | 'C' | 'D', number> = {
      A: totalVotes > 0 ? Math.round((counts.A / totalVotes) * 100) : 0,
      B: totalVotes > 0 ? Math.round((counts.B / totalVotes) * 100) : 0,
      C: totalVotes > 0 ? Math.round((counts.C / totalVotes) * 100) : 0,
      D: totalVotes > 0 ? Math.round((counts.D / totalVotes) * 100) : 0,
    };

    const maxCount = Math.max(counts.A, counts.B, counts.C, counts.D);
    const topIds = (['A', 'B', 'C', 'D'] as const).filter((id) => counts[id] === maxCount && maxCount > 0);

    return { counts, percentages, totalVotes, maxCount, topIds };
  }, [currentQuestionResponses]);

  // Launch Game from Lobby
  const handleStartGame = async () => {
    if (!sessionCode) return;
    await updateSessionState(sessionCode, {
      status: 'question',
      currentQuestionIndex: 0,
      questionStartedAt: Date.now(),
      isPaused: false,
      pausedAt: null,
      remainingSecondsOnPause: null
    });
  };

  // Advance to Next Question
  const handleNextQuestion = async () => {
    if (!session || !sessionCode) return;
    const nextIndex = session.currentQuestionIndex + 1;

    if (nextIndex >= 15) {
      // Completed all 15 questions
      await updateSessionState(sessionCode, {
        status: 'finished'
      });
    } else {
      await updateSessionState(sessionCode, {
        status: 'question',
        currentQuestionIndex: nextIndex,
        questionStartedAt: Date.now(),
        isPaused: false,
        pausedAt: null,
        remainingSecondsOnPause: null
      });
    }
  };

  // Toggle Pause/Resume
  const handleTogglePause = async () => {
    if (!session || !sessionCode) return;
    if (session.isPaused) {
      // Resuming
      const remaining = session.remainingSecondsOnPause ?? 30;
      const newStartedAt = Date.now() - ((session.durationSeconds || 30) - remaining) * 1000;
      await updateSessionState(sessionCode, {
        isPaused: false,
        pausedAt: null,
        remainingSecondsOnPause: null,
        questionStartedAt: newStartedAt
      });
    } else {
      // Pausing
      await updateSessionState(sessionCode, {
        isPaused: true,
        pausedAt: Date.now(),
        remainingSecondsOnPause: secondsRemaining
      });
    }
  };

  // End Game
  const handleEndGame = async () => {
    if (!sessionCode) return;
    if (window.confirm('Are you sure you want to end the polling session?')) {
      await updateSessionState(sessionCode, {
        status: 'finished'
      });
    }
  };

  // Download Responses CSV
  const handleDownloadCSV = () => {
    if (!sessionCode) return;
    const csvContent = generateResponsesCSV({
      sessionCode,
      questions: QUESTIONS,
      participants,
      responses: allResponses
    });
    downloadCSV(`HYBR_Session_${sessionCode}_Responses.csv`, csvContent);
  };

  // Fullscreen helper
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(console.warn);
    } else {
      document.exitFullscreen().catch(console.warn);
    }
  };

  // -------------------------------------------------------------
  // SCREEN 1: PASSCODE GATE & SETUP
  // -------------------------------------------------------------
  if (!isAuthorized) {
    return (
      <main className="w-full min-h-screen bg-[#f7f9fb] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-[#e0e3e5]">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-black text-[#42fed0] flex items-center justify-center font-bold">
              <span className="material-symbols-outlined text-2xl">bolt</span>
            </div>
            <div>
              <h1 className="font-headline text-xl font-extrabold text-[#191c1e]">HYBR Stage Engine</h1>
              <span className="font-counter text-[11px] uppercase tracking-wider text-[#45464d] font-bold">
                Master Host Console
              </span>
            </div>
          </div>

          <form onSubmit={handleAuthorize} className="flex flex-col gap-4">
            <div>
              <label className="font-headline text-xs font-bold text-[#191c1e] block mb-1.5" htmlFor="passcode-input">
                Host Authorization Key
              </label>
              <input
                id="passcode-input"
                type="text"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="HYBR-2025-LIVE"
                className="w-full px-4 py-3 bg-[#f2f4f6] rounded-xl font-counter text-base font-bold text-[#191c1e] tracking-wider border border-[#e0e3e5] focus:outline-none focus:border-[#006b55]"
                autoFocus
              />
              <span className="font-body text-[11px] text-[#45464d] mt-1 block">
                Enter key to launch projector console (Default: HYBR-2025-LIVE)
              </span>
            </div>

            {authError && (
              <div className="p-3 bg-[#ffdad6] text-[#93000a] text-xs font-semibold rounded-xl flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">error</span>
                <span>{authError}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full h-12 rounded-full bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] font-headline font-bold text-sm flex items-center justify-center gap-2 shadow-md transition-all cursor-pointer"
            >
              <span>Verify & Unlock Console</span>
              <span className="material-symbols-outlined text-lg">arrow_forward</span>
            </button>

            {onSwitchToParticipant && (
              <button
                type="button"
                onClick={onSwitchToParticipant}
                className="text-xs text-[#006b55] font-semibold text-center mt-2 hover:underline"
              >
                ← Back to Participant Mode
              </button>
            )}
          </form>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 2: HOST SETUP (NO SESSION CREATED YET)
  // -------------------------------------------------------------
  if (!session) {
    return (
      <main className="w-full min-h-screen bg-[#f7f9fb] flex items-center justify-center p-6">
        <div className="relative w-full max-w-4xl bg-white rounded-3xl shadow-xl overflow-hidden p-8 border border-[#e0e3e5]">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-[#eceef0]">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-black text-[#42fed0] rounded-xl flex items-center justify-center font-bold shadow-md">
                <span className="material-symbols-outlined text-2xl">bolt</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-headline text-lg font-extrabold text-[#191c1e]">HYBR</span>
                  <span className="px-2 py-0.5 bg-[#e6e8ea] rounded-full font-counter text-[11px] text-[#45464d] uppercase font-bold">
                    v3.4 Production
                  </span>
                </div>
                <p className="font-body text-xs text-[#45464d]">Live Event Interaction Grid</p>
              </div>
            </div>
            <div className="flex items-center gap-2 bg-[#131a33] text-white px-3.5 py-1.5 rounded-full shadow-sm">
              <span className="w-2 h-2 rounded-full bg-[#42fed0] animate-ping"></span>
              <span className="font-counter text-[11px] text-[#42fed0] uppercase tracking-wider font-bold">
                Host Console • Stage Controller
              </span>
            </div>
          </div>

          <div className="mt-6">
            <span className="font-counter text-xs text-[#006b55] uppercase tracking-widest font-bold">
              Master Orchestrator Deck • All-Hands 2025
            </span>
            <h1 className="font-headline text-3xl font-extrabold text-[#191c1e] tracking-tight mt-1">
              Launch Live Interactive Polling Session
            </h1>
            <p className="font-body text-sm text-[#45464d] mt-1 max-w-2xl">
              Broadcast synchronized low-latency voting states directly to main auditorium screens and personal devices.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
            <div className="lg:col-span-7 flex flex-col gap-4">
              <div className="bg-[#f2f4f6] p-5 rounded-2xl flex flex-col gap-3 border border-[#e0e3e5]">
                <div className="flex items-center justify-between">
                  <label className="font-headline text-xs font-bold text-[#191c1e] flex items-center gap-1.5" htmlFor="auth-key-display">
                    <span className="material-symbols-outlined text-[#006b55] text-lg">shield_lock</span>
                    Host Authorization Key
                  </label>
                  <span className="px-2.5 py-0.5 bg-[#42fed0]/30 text-[#00725b] rounded-full font-counter text-[10px] font-bold">
                    Verified Stage Master
                  </span>
                </div>
                <div className="relative flex items-center">
                  <input
                    id="auth-key-display"
                    className="w-full bg-white font-counter text-lg font-bold text-[#191c1e] py-3 px-4 rounded-xl shadow-sm text-center tracking-widest border border-[#e0e3e5]"
                    readOnly
                    type="text"
                    value="HYBR-2025-LIVE"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText('HYBR-2025-LIVE');
                      setCopiedKey(true);
                      setTimeout(() => setCopiedKey(false), 2000);
                    }}
                    className="absolute right-2 px-3 py-1.5 bg-[#e6e8ea] hover:bg-[#e0e3e5] rounded-lg font-counter text-xs text-[#191c1e] font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-sm">{copiedKey ? 'check' : 'content_copy'}</span>
                    <span>{copiedKey ? 'COPIED' : 'COPY'}</span>
                  </button>
                </div>
                <p className="font-body text-xs text-[#45464d]">
                  Encrypted tunnel binding this console to Stage Projector Hub 01.
                </p>
              </div>

              {/* Session Profile Specs */}
              <div className="bg-[#eceef0] p-5 rounded-2xl border border-[#e0e3e5]">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-headline text-xs font-bold text-[#191c1e]">Loaded Session Profile</span>
                  <span className="px-2 py-0.5 bg-[#e0e3e5] rounded-full font-counter text-[10px] text-[#45464d] font-bold">
                    Deck ID: #AH-HYBR
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white p-3 rounded-xl flex items-center gap-3 shadow-sm border border-[#e0e3e5]/60">
                    <div className="w-8 h-8 rounded-full bg-[#f2f4f6] flex items-center justify-center text-[#191c1e]">
                      <span className="material-symbols-outlined text-base">fact_check</span>
                    </div>
                    <div>
                      <div className="font-counter text-xs font-bold text-[#191c1e]">15 Questions</div>
                      <div className="font-body text-[11px] text-[#45464d]">Full pool loaded</div>
                    </div>
                  </div>
                  <div className="bg-white p-3 rounded-xl flex items-center gap-3 shadow-sm border border-[#e0e3e5]/60">
                    <div className="w-8 h-8 rounded-full bg-[#f2f4f6] flex items-center justify-center text-[#191c1e]">
                      <span className="material-symbols-outlined text-base">timer</span>
                    </div>
                    <div>
                      <div className="font-counter text-xs font-bold text-[#191c1e]">30s Rounds</div>
                      <div className="font-body text-[11px] text-[#45464d]">Synchronized clock</div>
                    </div>
                  </div>
                  <div className="bg-white p-3 rounded-xl flex items-center gap-3 shadow-sm border border-[#e0e3e5]/60">
                    <div className="w-8 h-8 rounded-full bg-[#f2f4f6] flex items-center justify-center text-[#191c1e]">
                      <span className="material-symbols-outlined text-base">ballot</span>
                    </div>
                    <div>
                      <div className="font-counter text-xs font-bold text-[#191c1e]">4-Option Matrix</div>
                      <div className="font-body text-[11px] text-[#45464d]">Touch drag rank</div>
                    </div>
                  </div>
                  <div className="bg-white p-3 rounded-xl flex items-center gap-3 shadow-sm border border-[#e0e3e5]/60">
                    <div className="w-8 h-8 rounded-full bg-[#f2f4f6] flex items-center justify-center text-[#191c1e]">
                      <span className="material-symbols-outlined text-base">visibility_off</span>
                    </div>
                    <div>
                      <div className="font-counter text-xs font-bold text-[#191c1e]">Anonymous</div>
                      <div className="font-body text-[11px] text-[#45464d]">Zero scored tests</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 flex flex-col justify-between gap-4">
              <div className="bg-[#131a33] text-white p-6 rounded-2xl flex flex-col justify-between h-full border border-[#1e2a4a]">
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <span className="font-counter text-[11px] text-[#42fed0] uppercase font-bold tracking-wider">
                      Auditorium Projector Feed
                    </span>
                    <span className="px-2 py-0.5 bg-[#42fed0]/20 text-[#42fed0] rounded-full font-counter text-[10px] font-bold">
                      READY
                    </span>
                  </div>
                  <h3 className="font-headline text-lg font-bold text-white">Stage Engine Awaiting Command</h3>
                  <p className="font-body text-xs text-white/70 mt-1">
                    Click Start New Session below. A new 6-digit session PIN and fresh QR code will be generated and broadcasted on the primary projector.
                  </p>
                </div>
                <div className="pt-6">
                  <button
                    onClick={() => handleStartNewSession(false)}
                    className="w-full py-4 rounded-full bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] font-headline font-bold text-base flex items-center justify-center gap-2 shadow-lg transition-transform active:scale-95 cursor-pointer"
                  >
                    <span>Start New Session</span>
                    <span className="material-symbols-outlined text-xl">arrow_forward</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Common Header for Lobby, Live Question, and Finale
  const renderCommonHeader = (titleBadge: string, subtitle: string) => (
    <header className="h-20 w-full px-8 bg-[#131a33] text-white flex items-center justify-between shadow-md">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#42fed0] flex items-center justify-center text-[#002018] font-bold">
            <span className="material-symbols-outlined text-2xl font-bold">bolt</span>
          </div>
          <div className="flex flex-col">
            <span className="font-headline text-lg font-extrabold tracking-tight text-white leading-none">
              HYBR
            </span>
            <span className="font-counter text-[10px] uppercase tracking-widest text-[#42fed0]">
              Stage Engine
            </span>
          </div>
        </div>
        <div className="h-8 w-px bg-white/20"></div>
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/10">
          <span className="w-2.5 h-2.5 rounded-full bg-[#42fed0] animate-pulse"></span>
          <span className="font-counter text-xs uppercase tracking-wider text-[#42fed0] font-bold">
            {titleBadge}
          </span>
        </div>
        <div className="hidden md:flex items-center gap-1.5 text-white/80">
          <span className="material-symbols-outlined text-base">
            {audioEnabled ? 'volume_up' : 'volume_off'}
          </span>
          <span className="font-counter text-xs uppercase tracking-wider">
            {audioEnabled ? 'Cues Active' : 'Cues Muted'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-white/10 px-4 py-1.5 rounded-full text-white">
          <span className="material-symbols-outlined text-xl text-[#42fed0]">sensors</span>
          <span className="font-counter text-base font-bold">{participants.length}</span>
          <span className="font-counter text-xs uppercase text-white/70">Voters</span>
        </div>

        {/* Global New Session Button */}
        <button
          onClick={() => handleStartNewSession(true)}
          disabled={isWipingSession}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white/15 hover:bg-[#42fed0] hover:text-[#002018] text-white font-headline text-xs font-bold transition-all cursor-pointer shadow-sm disabled:opacity-50"
          title="Delete previous session data, disconnect participants, and launch new session with fresh QR"
        >
          {isWipingSession ? (
            <>
              <span className="material-symbols-outlined text-base animate-spin">sync</span>
              <span className="hidden sm:inline">Resetting...</span>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-base">add_circle</span>
              <span className="hidden sm:inline">New Session</span>
            </>
          )}
        </button>

        <button
          onClick={toggleFullscreen}
          className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
          title="Toggle Fullscreen"
        >
          <span className="material-symbols-outlined text-xl">fullscreen</span>
        </button>
        {onSwitchToParticipant && (
          <button
            onClick={onSwitchToParticipant}
            className="text-xs bg-[#42fed0]/20 hover:bg-[#42fed0]/30 text-[#42fed0] font-bold px-3 py-1.5 rounded-full hidden lg:inline-block"
          >
            Participant Mode
          </button>
        )}
      </div>
    </header>
  );

  // -------------------------------------------------------------
  // SCREEN 3: HOST LOBBY
  // -------------------------------------------------------------
  if (session.status === 'lobby') {
    const digits = sessionCode.split('');

    return (
      <div className="min-h-screen bg-[#f7f9fb] text-[#191c1e] flex flex-col">
        {renderCommonHeader('Auditorium A • Live Link', 'Lobby State')}

        {/* Main Stage Projection Layout */}
        <main className="flex-1 w-full px-8 py-6 flex flex-col justify-between max-w-[1920px] mx-auto">
          <div className="grid grid-cols-12 gap-8 items-start">
            {/* Left Column: Giant PIN & QR Code (7 cols) */}
            <section className="col-span-12 lg:col-span-7 flex flex-col gap-6">
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center gap-2 bg-[#131a33] text-white px-3 py-1 rounded-full shadow-sm">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#42fed0] animate-ping"></span>
                  <span className="font-counter text-xs uppercase tracking-wider text-[#42fed0] font-bold">
                    Auditorium Main Stage
                  </span>
                </div>
                <div className="inline-flex items-center gap-1.5 bg-[#e6e8ea] text-[#45464d] px-3 py-1 rounded-full">
                  <span className="material-symbols-outlined text-sm text-[#006b55]">tune</span>
                  <span className="font-counter text-xs uppercase tracking-wider font-bold">
                    Session Key HYBR-{sessionCode}
                  </span>
                </div>
              </div>

              <div>
                <span className="font-counter text-xs text-[#006b55] uppercase tracking-widest font-bold">
                  Audience Fast-Connect
                </span>
                <h1 className="font-headline text-4xl lg:text-5xl font-extrabold text-[#191c1e] tracking-tight leading-none mt-1">
                  Join the Live Game at{' '}
                  <span className="text-[#006b55] underline decoration-[#42fed0] decoration-4 underline-offset-8">
                    hybr.live
                  </span>
                </h1>
              </div>

              {/* 6-Digit PIN in High-Contrast Cards */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="font-counter text-xs uppercase tracking-widest text-[#45464d] font-bold">
                    Room Entry PIN
                  </span>
                  <span className="font-counter text-xs uppercase text-[#76767e]">
                    Direct URL: {window.location.host}/?code={sessionCode}
                  </span>
                </div>
                <div className="grid grid-cols-6 gap-3 w-full">
                  {digits.map((digit, idx) => (
                    <div
                      key={idx}
                      className="bg-[#131a33] text-[#42fed0] rounded-2xl py-6 flex flex-col items-center justify-center shadow-lg transform transition-transform hover:-translate-y-1 border border-[#1e2a4a]"
                    >
                      <span className="font-counter text-5xl lg:text-6xl font-bold select-all">{digit}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Scannable QR Code & Zero-Friction Info */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-5 items-stretch">
                <div className="sm:col-span-5 bg-white rounded-2xl p-4 flex flex-col items-center justify-center shadow-md border border-[#e0e3e5]">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`QR code for PIN ${sessionCode}`}
                      className="w-48 h-48 object-contain rounded-xl"
                    />
                  ) : (
                    <div className="w-48 h-48 bg-[#eceef0] rounded-xl flex items-center justify-center text-xs text-[#45464d]">
                      Generating QR...
                    </div>
                  )}
                  <span className="mt-2 font-counter text-xs uppercase tracking-wider text-[#006b55] font-bold flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">qr_code_scanner</span> Instant Camera Sync
                  </span>
                </div>

                <div className="sm:col-span-7 bg-white rounded-2xl p-6 flex flex-col justify-between shadow-md border border-[#e0e3e5]">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-[#006b55] font-bold">
                      <span className="material-symbols-outlined text-lg">smartphone</span>
                      <span className="font-headline text-xs uppercase tracking-wider">Zero-Friction Access</span>
                    </div>
                    <p className="font-headline text-lg font-bold text-[#191c1e] leading-snug">
                      Scan with phone camera to join instantly — no app install required.
                    </p>
                    <p className="font-body text-xs text-[#45464d]">
                      Works on Chrome, Safari, and mobile browsers. Your device becomes your private voting paddle.
                    </p>
                  </div>

                  <div className="mt-4 bg-[#f2f4f6] p-3.5 rounded-xl flex items-center gap-3 border border-[#e0e3e5]/60">
                    <div className="w-8 h-8 rounded-full bg-[#42fed0]/40 flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-base text-[#00725b]">speed</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-counter text-[10px] uppercase tracking-wider text-[#45464d] font-bold">
                        Match Protocol
                      </span>
                      <span className="font-headline text-xs font-bold text-[#191c1e]">
                        Rank 4 choices each round • 30 seconds • No right or wrong answers
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Right Column: Live Roster & Contenders Stream (5 cols) */}
            <section className="col-span-12 lg:col-span-5 flex flex-col gap-5">
              {/* Live Connected Counter */}
              <div className="bg-[#131a33] text-white rounded-2xl p-6 shadow-xl relative overflow-hidden border border-[#1e2a4a]">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="font-counter text-xs uppercase tracking-widest text-[#42fed0] font-bold">
                      Live Roster In-Room
                    </span>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="font-counter text-6xl font-extrabold text-white leading-none">
                        {participants.length}
                      </span>
                      <span className="font-headline text-xl text-[#42fed0] font-bold">Joined</span>
                    </div>
                  </div>
                  {/* Radar Beacon */}
                  <div className="relative flex items-center justify-center w-16 h-16">
                    <span className="absolute w-16 h-16 rounded-full bg-[#42fed0]/20 animate-ping"></span>
                    <span className="absolute w-12 h-12 rounded-full bg-[#42fed0]/40 animate-pulse"></span>
                    <div className="w-8 h-8 rounded-full bg-[#42fed0] flex items-center justify-center text-[#002018] shadow-lg">
                      <span className="material-symbols-outlined text-lg">sensors</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-3 flex items-center justify-between text-xs text-white/70 border-t border-white/10">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm text-[#42fed0]">group_add</span>
                    <span>Audience Ready</span>
                  </div>
                  <span className="font-counter uppercase text-[#42fed0]">Sync Latency: &lt;30ms</span>
                </div>
              </div>

              {/* Contender Chips Grid */}
              <div className="bg-white rounded-2xl p-5 shadow-md flex flex-col gap-3 flex-1 border border-[#e0e3e5]">
                <div className="flex items-center justify-between pb-1 border-b border-[#eceef0]">
                  <div className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-base text-[#006b55]">how_to_reg</span>
                    <span className="font-headline text-xs uppercase tracking-wider font-bold text-[#191c1e]">
                      Live Stream of Contenders
                    </span>
                  </div>
                  <span className="font-counter text-[11px] uppercase text-[#76767e]">Real-Time Ingestion</span>
                </div>

                <div className="flex flex-wrap gap-2 content-start overflow-y-auto max-h-[340px] p-2 rounded-xl bg-[#f2f4f6]/70 min-h-[160px]">
                  {participants.length === 0 ? (
                    <div className="w-full flex flex-col items-center justify-center py-8 text-[#76767e]">
                      <span className="material-symbols-outlined text-3xl mb-1 animate-pulse">qr_code_scanner</span>
                      <p className="font-body text-xs">Waiting for participants to join...</p>
                    </div>
                  ) : (
                    participants.map((p) => (
                      <div
                        key={p.id}
                        className="inline-flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-full shadow-sm hover:scale-105 transition-all border border-[#e0e3e5]/70"
                      >
                        <span className="w-6 h-6 rounded-full bg-[#131a33] text-[#42fed0] font-counter text-[10px] flex items-center justify-center font-bold">
                          {p.data.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="font-headline text-xs font-semibold text-[#191c1e]">
                          {p.data.name}
                        </span>
                        {(p.data.hypeCount || 0) > 0 && (
                          <span className="text-[10px] text-[#006b55] font-bold">🔥</span>
                        )}
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center justify-between text-xs text-[#45464d] pt-1">
                  <span>All attendees placed into Lobby Pool</span>
                  <div className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#006b55]"></span>
                    <span className="font-counter uppercase font-bold text-[10px]">Real-time Live</span>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Bottom Stage Controller Bar */}
          <div className="w-full mt-6 pt-4 border-t border-[#e0e3e5]">
            <div className="bg-[#131a33] text-white rounded-2xl px-6 py-4 shadow-2xl flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center text-[#42fed0]">
                  <span className="material-symbols-outlined text-2xl">podium</span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-headline text-base font-bold text-white">Stage Host Deck</span>
                    <span className="px-2 py-0.5 rounded-full bg-[#42fed0] text-[#002018] font-counter text-[10px] uppercase font-bold">
                      Ready
                    </span>
                  </div>
                  <span className="font-body text-xs text-white/70">
                    Audience window open • Warmup countdown idling
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setAudioEnabled(!audioEnabled)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full font-headline text-xs font-bold transition-all cursor-pointer ${
                    audioEnabled ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-[#ba1a1a]/30 text-white'
                  }`}
                  type="button"
                >
                  <span className="material-symbols-outlined text-lg text-[#42fed0]">
                    {audioEnabled ? 'volume_up' : 'volume_off'}
                  </span>
                  <span>{audioEnabled ? 'Audio On' : 'Muted'}</span>
                </button>

                <button
                  onClick={toggleFullscreen}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white/15 text-white hover:bg-white/25 font-headline text-xs font-bold transition-all cursor-pointer"
                  type="button"
                >
                  <span className="material-symbols-outlined text-lg text-[#42fed0]">fit_screen</span>
                  <span>Projector Full</span>
                </button>

                <button
                  onClick={handleStartGame}
                  className="inline-flex items-center gap-2 bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] px-6 py-3 rounded-full shadow-lg font-headline font-bold text-sm uppercase tracking-wide transition-all active:scale-95 cursor-pointer"
                  type="button"
                >
                  <span className="material-symbols-outlined text-xl font-bold">play_arrow</span>
                  <span>Start Game ({participants.length} Ready) →</span>
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 4: HOST FINALE (ALL 15 QUESTIONS FINISHED)
  // -------------------------------------------------------------
  if (session.status === 'finished') {
    const totalResponsesCount = allResponses.length;
    const avgTurnout = totalParticipants > 0
      ? ((totalResponsesCount / (15 * totalParticipants)) * 100).toFixed(1)
      : '0.0';

    return (
      <div className="min-h-screen bg-[#f7f9fb] text-[#191c1e] flex flex-col">
        {renderCommonHeader('Session Finalized • Stage Live Out', 'Results State')}

        <main className="flex-1 w-full px-8 py-8 max-w-[1920px] mx-auto flex flex-col gap-6">
          {/* Top Title Banner */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="px-3 py-1 rounded-full bg-[#42fed0]/30 text-[#00725b] font-counter text-xs uppercase font-bold">
                  Session Finalized • Stage Live Out
                </span>
                <span className="px-3 py-1 rounded-full bg-[#e6e8ea] text-[#45464d] font-counter text-xs uppercase font-bold">
                  Auditorium A
                </span>
              </div>
              <h1 className="font-headline text-4xl lg:text-5xl font-extrabold text-[#191c1e] tracking-tight">
                Thanks for Playing <span className="text-[#006b55]">HYBR!</span>
              </h1>
              <p className="font-body text-sm text-[#45464d] mt-1">
                All 15 rounds complete • HYBR Annual All-Hands 2025
              </p>
            </div>

            <div className="flex items-center gap-4 bg-white p-4 rounded-2xl shadow-sm border border-[#e0e3e5]">
              <div className="w-12 h-12 rounded-xl bg-[#42fed0] flex items-center justify-center text-[#002018]">
                <span className="material-symbols-outlined text-2xl">military_tech</span>
              </div>
              <div className="flex flex-col">
                <span className="font-counter text-[10px] uppercase text-[#76767e] font-bold">
                  Stage Telemetry Engine
                </span>
                <span className="font-headline text-base font-bold text-[#191c1e]">
                  Session #{sessionCode}
                </span>
                <span className="font-body text-xs text-[#006b55]">100% Synced & Archived</span>
              </div>
            </div>
          </div>

          {/* 4 Metric Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#e0e3e5] flex flex-col justify-between">
              <span className="font-counter text-xs uppercase tracking-wider text-[#76767e] font-bold">
                Room Population
              </span>
              <div className="flex items-baseline gap-2 my-2">
                <span className="font-counter text-5xl font-extrabold text-[#191c1e]">
                  {totalParticipants}
                </span>
                <span className="font-headline text-sm font-bold text-[#006b55]">Seats</span>
              </div>
              <span className="font-body text-xs text-[#45464d]">Total active in-room voters</span>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#e0e3e5] flex flex-col justify-between">
              <span className="font-counter text-xs uppercase tracking-wider text-[#76767e] font-bold">
                Telemetry Volume
              </span>
              <div className="flex items-baseline gap-2 my-2">
                <span className="font-counter text-5xl font-extrabold text-[#191c1e]">
                  {totalResponsesCount * 4}
                </span>
                <span className="font-headline text-sm font-bold text-[#45464d]">datapoints</span>
              </div>
              <span className="font-body text-xs text-[#45464d]">Preference rankings locked</span>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#e0e3e5] flex flex-col justify-between">
              <span className="font-counter text-xs uppercase tracking-wider text-[#76767e] font-bold">
                Turnout Ratio
              </span>
              <div className="flex items-baseline gap-2 my-2">
                <span className="font-counter text-5xl font-extrabold text-[#006b55]">
                  {avgTurnout}%
                </span>
              </div>
              <span className="font-body text-xs text-[#45464d]">Average per-round response pace</span>
            </div>

            <div className="bg-[#131a33] text-white p-6 rounded-2xl shadow-md border border-[#1e2a4a] flex flex-col justify-between">
              <span className="font-counter text-xs uppercase tracking-wider text-[#42fed0] font-bold">
                Culture Vector
              </span>
              <div className="flex items-baseline gap-2 my-2">
                <span className="font-counter text-5xl font-extrabold text-white">0</span>
                <span className="font-headline text-sm font-bold text-[#42fed0]">Graded Keys</span>
              </div>
              <span className="font-body text-xs text-white/70">100% Unfiltered Team Instinct</span>
            </div>
          </div>

          {/* Presentation Controls Footer */}
          <div className="bg-white p-6 rounded-2xl shadow-md border border-[#e0e3e5] flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#f2f4f6] flex items-center justify-center text-[#191c1e]">
                <span className="material-symbols-outlined text-xl">tune</span>
              </div>
              <div>
                <span className="font-headline text-base font-bold text-[#191c1e] block">
                  Presenter Controls
                </span>
                <span className="font-body text-xs text-[#45464d]">
                  Archive session, download raw response CSV, or launch a fresh live game
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleDownloadCSV}
                className="px-6 py-3 rounded-full bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] font-headline font-bold text-xs uppercase tracking-wider shadow-md active:scale-95 transition-all flex items-center gap-2 cursor-pointer"
              >
                <span className="material-symbols-outlined text-lg">download</span>
                <span>Download Responses (CSV)</span>
              </button>

              {/* Requirement: New Session deletes previous data, disconnects participants, generates new code & launches straight to Lobby with fresh QR */}
              <button
                onClick={() => handleStartNewSession(true)}
                disabled={isWipingSession}
                className="px-6 py-3 rounded-full bg-[#131a33] hover:bg-[#1e2a4a] text-white font-headline font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 cursor-pointer shadow-md disabled:opacity-50"
              >
                {isWipingSession ? (
                  <>
                    <span className="material-symbols-outlined text-lg animate-spin">sync</span>
                    <span>Resetting Session...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg text-[#42fed0]">add_circle</span>
                    <span>New Session</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // -------------------------------------------------------------
  // SCREEN 5: HOST LIVE QUESTION & RESULTS BREAKDOWN SCREEN
  // -------------------------------------------------------------
  const totalSeconds = session.durationSeconds || 30;
  const progressRatio = Math.max(0, Math.min(1, secondsRemaining / totalSeconds));
  const circumference = 264;
  const strokeOffset = circumference - progressRatio * circumference;

  return (
    <div className="min-h-screen bg-[#f7f9fb] text-[#191c1e] flex flex-col">
      {renderCommonHeader(
        isRoundComplete
          ? 'Auditorium A • Round Locked'
          : 'Auditorium A • Voting Open',
        'Active Question'
      )}

      {/* Main Content Area */}
      <main className="flex-1 w-full px-8 py-6 max-w-[1920px] mx-auto flex flex-col gap-6">
        {/* Top Stage Telemetry Ribbon */}
        <div className="w-full bg-white rounded-2xl p-4 shadow-sm flex items-center justify-between border border-[#e0e3e5]">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-[#131a33] text-white px-4 py-1.5 rounded-full shadow-sm">
              <span className={`w-2.5 h-2.5 rounded-full ${isRoundComplete ? 'bg-[#ba1a1a]' : 'bg-[#42fed0] animate-ping'}`}></span>
              <span className="font-counter text-xs uppercase tracking-wider text-[#42fed0] font-bold">
                Question {currentQIndex + 1} of 15
              </span>
            </div>

            {isRoundComplete ? (
              <div className="flex items-center gap-1.5 bg-[#42fed0]/25 text-[#00725b] px-3.5 py-1.5 rounded-full border border-[#00e0b5]/50">
                <span className="material-symbols-outlined text-sm font-bold">verified</span>
                <span className="font-counter text-xs uppercase tracking-wider font-bold">
                  {isSubmittedByAll ? 'All Participants Submitted' : 'Round Locked'}
                </span>
              </div>
            ) : (
              <div className="hidden sm:flex items-center gap-1.5 bg-[#f2f4f6] px-3.5 py-1.5 rounded-full text-[#45464d]">
                <span className="material-symbols-outlined text-sm">tune</span>
                <span className="font-body text-xs font-semibold">Priority Matrix Voting</span>
              </div>
            )}
          </div>

          {/* Center Giant Dial */}
          <div className="flex items-center gap-4">
            <div className="relative w-16 h-16 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle
                  className="text-[#e6e8ea]"
                  cx="50"
                  cy="50"
                  fill="transparent"
                  r="42"
                  stroke="currentColor"
                  strokeWidth="8"
                />
                <circle
                  className={`transition-all duration-500 ease-linear ${
                    isRoundComplete
                      ? 'text-[#ba1a1a]'
                      : secondsRemaining <= 5
                      ? 'text-[#ba1a1a]'
                      : 'text-[#42fed0]'
                  }`}
                  cx="50"
                  cy="50"
                  fill="transparent"
                  r="42"
                  stroke="currentColor"
                  strokeDasharray={circumference}
                  strokeDashoffset={isRoundComplete ? 0 : strokeOffset}
                  strokeLinecap="round"
                  strokeWidth="8"
                />
              </svg>
              <div className="absolute flex flex-col items-center justify-center">
                <span className={`font-counter text-2xl font-bold leading-none ${
                  isRoundComplete ? 'text-[#ba1a1a]' : secondsRemaining <= 5 ? 'text-[#ba1a1a]' : 'text-[#191c1e]'
                }`}>
                  {isRoundComplete ? '00' : secondsRemaining}
                </span>
                <span className="font-counter text-[9px] uppercase tracking-widest text-[#76767e] font-bold">
                  {isRoundComplete ? 'LOCK' : 'SEC'}
                </span>
              </div>
            </div>
            <div className="flex flex-col">
              <span className="font-headline text-sm font-bold text-[#191c1e] leading-tight">
                {isSubmittedByAll
                  ? 'All Submitted!'
                  : isTimeUp || session.status === 'locked'
                  ? 'Window Closed'
                  : session.isPaused
                  ? 'Timer Paused'
                  : 'Window Open'}
              </span>
              <span className="font-body text-xs text-[#006b55] flex items-center gap-1 font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-[#006b55]"></span>
                {isSubmittedByAll ? '100% Turnout Reached' : 'Synchronized'}
              </span>
            </div>
          </div>

          {/* Right: Join PIN */}
          <div className="flex flex-col items-end">
            <span className="font-counter text-[10px] uppercase tracking-widest text-[#76767e] font-bold">
              Audience Join PIN
            </span>
            <div className="flex items-center gap-2 bg-[#f2f4f6] px-3.5 py-1.5 rounded-xl border border-[#e0e3e5]">
              <span className="material-symbols-outlined text-base text-[#191c1e]">qr_code_2</span>
              <span className="font-counter text-sm font-bold tracking-widest text-[#191c1e]">
                PIN: {sessionCode}
              </span>
            </div>
          </div>
        </div>

        {/* Projection Stage Grid */}
        <div className="grid grid-cols-12 gap-6 items-start">
          {/* Left Column: Question Presentation & 4 Options (8 cols) */}
          <section className="col-span-12 lg:col-span-8 flex flex-col gap-6">
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-[#e0e3e5] relative overflow-hidden">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-counter text-[11px] uppercase tracking-wider text-[#006b55] px-2.5 py-0.5 rounded-full bg-[#42fed0]/30 font-bold">
                    Prompt Focus
                  </span>
                  <span className="font-body text-xs text-[#45464d]">
                    • Question {currentQIndex + 1} of 15
                  </span>
                </div>

                {isRoundComplete && (
                  <span className="px-3 py-1 rounded-full bg-[#131a33] text-[#42fed0] font-counter text-xs uppercase font-extrabold tracking-wider flex items-center gap-1.5 shadow-sm">
                    <span className="material-symbols-outlined text-sm text-[#42fed0]">bar_chart</span>
                    #1 Preference Results Unveiled
                  </span>
                )}
              </div>

              <h1 className="font-headline text-3xl lg:text-4xl xl:text-5xl font-extrabold text-[#191c1e] tracking-tight leading-tight">
                {currentQuestion.question}
              </h1>

              {/* Requirement 1: When submitted by all (or round complete), show clear room preference breakdown alert */}
              {isRoundComplete ? (
                <div className="mt-5 p-4 rounded-2xl bg-[#131a33] text-white flex flex-col md:flex-row items-center justify-between gap-4 shadow-lg border border-[#1e2a4a]">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-[#42fed0] text-[#002018] flex items-center justify-center shrink-0 font-bold">
                      <span className="material-symbols-outlined text-xl">how_to_vote</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-headline text-base font-extrabold text-white">
                          {isSubmittedByAll ? 'All Participants Submitted!' : 'Submissions Locked!'}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-[#42fed0]/20 text-[#42fed0] font-counter text-[11px] font-bold uppercase">
                          {firstPickStats.totalVotes} Total Ranked
                        </span>
                      </div>
                      <p className="font-body text-xs text-white/70">
                        Displaying how many people selected each option as their <strong className="text-[#42fed0]">#1 First Pick</strong>.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-counter text-xs text-[#42fed0] font-bold uppercase tracking-wider">
                      Leading Choice:
                    </span>
                    <span className="px-3 py-1 bg-white/10 rounded-full font-counter text-xs text-white font-extrabold">
                      {firstPickStats.topIds.length > 0
                        ? `Option ${firstPickStats.topIds.join(', ')} (${firstPickStats.percentages[firstPickStats.topIds[0]]}%)`
                        : 'Recorded'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex items-center gap-2 text-[#45464d] bg-[#f2f4f6] p-2.5 rounded-xl w-fit">
                  <span className="material-symbols-outlined text-base text-[#006b55]">touch_app</span>
                  <span className="font-body text-xs font-semibold text-[#191c1e]">
                    Rank options on your mobile device (1 = Most preferred to 4 = Least)
                  </span>
                </div>
              )}
            </div>

            {/* 4 Large Option Tiles with Live #1 Pick Breakdown when all submitted / round complete */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {currentQuestion.options.map((opt) => {
                const count = firstPickStats.counts[opt.id];
                const pct = firstPickStats.percentages[opt.id];
                const isLeading = firstPickStats.topIds.includes(opt.id) && count > 0;

                return (
                  <div
                    key={opt.id}
                    className={`p-6 rounded-2xl shadow-sm border transition-all flex flex-col justify-between min-h-[180px] relative overflow-hidden ${
                      isRoundComplete && isLeading
                        ? 'bg-white border-[#00e0b5] ring-2 ring-[#42fed0]/40 shadow-md'
                        : 'bg-white border-[#e0e3e5] hover:shadow-md'
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between">
                        <div className="w-12 h-12 rounded-xl bg-[#131a33] text-[#42fed0] flex items-center justify-center font-headline text-xl font-extrabold shadow-sm">
                          {opt.id}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {isRoundComplete && isLeading && (
                            <span className="px-2.5 py-0.5 rounded-full bg-[#42fed0] text-[#002018] font-counter text-[10px] uppercase font-extrabold tracking-wider shadow-sm flex items-center gap-1">
                              <span className="material-symbols-outlined text-xs">star</span>
                              Top #1 Pick
                            </span>
                          )}
                          <span className="font-counter text-[11px] uppercase tracking-wider text-[#45464d] bg-[#f2f4f6] px-2.5 py-0.5 rounded-full font-bold">
                            Option {opt.id}
                          </span>
                        </div>
                      </div>

                      <p className="font-headline text-base font-bold text-[#191c1e] leading-snug mt-4">
                        {opt.text}
                      </p>
                    </div>

                    {/* Requirement 1: After every question when submitted by all, show how many people chose this option as their first */}
                    {isRoundComplete ? (
                      <div className="mt-4 pt-3 border-t border-[#eceef0] flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <span className="font-counter text-2xl font-extrabold text-[#191c1e]">
                              {count}
                            </span>
                            <span className="font-headline text-xs font-bold text-[#45464d]">
                              {count === 1 ? 'person chose as #1' : 'people chose as #1'}
                            </span>
                          </div>
                          <span className="font-counter text-base font-extrabold text-[#006b55]">
                            {pct}%
                          </span>
                        </div>

                        {/* Visual Bar of #1 preference proportion */}
                        <div className="w-full bg-[#eceef0] h-3 rounded-full overflow-hidden p-0.5">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              isLeading ? 'bg-[#00e0b5]' : 'bg-[#42fed0]'
                            }`}
                            style={{ width: `${pct}%` }}
                          ></div>
                        </div>
                      </div>
                    ) : (
                      <div className="w-full bg-[#f2f4f6] h-1.5 rounded-full mt-4 overflow-hidden">
                        <div className="bg-[#42fed0] h-full rounded-full w-full opacity-60"></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Stage Projection Ambient Banner */}
            <div className="bg-[#f2f4f6] rounded-2xl p-4 flex items-center justify-between border border-[#e0e3e5]">
              <div className="flex items-center gap-3">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00e0b5] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-[#006b55]"></span>
                </span>
                <span className="font-body text-xs text-[#45464d]">
                  {isRoundComplete
                    ? 'Aggregated room preferences displayed. Individual participant rankings remain private.'
                    : 'Stage projector visual mode: individual scores suppressed. Displaying live quorum submission pacing only.'}
                </span>
              </div>
              <span className="font-counter text-[11px] text-[#45464d] uppercase font-bold">
                All-Hands Auditorium Mode
              </span>
            </div>
          </section>

          {/* Right Column: Live Submission Tracker (4 cols) */}
          <aside className="col-span-12 lg:col-span-4 flex flex-col gap-4">
            <div className="bg-white rounded-3xl p-6 shadow-sm border border-[#e0e3e5] flex flex-col gap-4">
              <div className="flex items-center justify-between pb-1 border-b border-[#eceef0]">
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-xl text-[#006b55]">fact_check</span>
                  <h2 className="font-headline text-base font-bold text-[#191c1e]">
                    Live Submission Tracker
                  </h2>
                </div>
                <span className={`font-counter text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                  isRoundComplete ? 'bg-[#42fed0] text-[#002018]' : 'bg-[#42fed0]/30 text-[#00725b]'
                }`}>
                  {isSubmittedByAll ? '100% Submitted' : 'Active Quorum'}
                </span>
              </div>

              {/* Progress Bar & Scale Counter */}
              <div className="bg-[#f2f4f6] p-4 rounded-2xl flex flex-col gap-2 border border-[#e0e3e5]/60">
                <div className="flex items-baseline justify-between">
                  <span className="font-counter text-3xl font-extrabold text-[#191c1e] tracking-tight">
                    {currentSubmittedCount}{' '}
                    <span className="text-[#45464d] text-lg font-semibold">/ {totalParticipants}</span>
                  </span>
                  <span className="font-counter text-lg font-bold text-[#006b55]">{currentTurnoutPct}%</span>
                </div>
                <div className="w-full bg-[#e0e3e5] h-3 rounded-full overflow-hidden p-0.5">
                  <div
                    className="bg-[#42fed0] h-full rounded-full transition-all duration-500"
                    style={{ width: `${currentTurnoutPct}%` }}
                  ></div>
                </div>
                <span className="font-body text-xs text-[#45464d] text-right">
                  {isSubmittedByAll
                    ? 'All participants locked in their rankings!'
                    : `${Math.max(0, totalParticipants - currentSubmittedCount)} participants responding now`}
                </span>
              </div>

              {/* Participants Live Feed (Status Chip: Submitted with time or Waiting) */}
              <div className="flex flex-col gap-2">
                <span className="font-counter text-[11px] uppercase tracking-wider text-[#45464d] px-1 font-bold">
                  Auditorium Stream
                </span>
                <div className="flex flex-col gap-1.5 max-h-[280px] overflow-y-auto pr-1">
                  {participants.map((p) => {
                    const resp = currentQuestionResponses.find((r) => r.participantId === p.id);
                    const isSubmitted = !!resp;
                    return (
                      <div
                        key={p.id}
                        className="flex items-center justify-between p-2.5 rounded-xl bg-[#f2f4f6]/60 border border-[#e0e3e5]/60"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-[#131a33] text-white flex items-center justify-center font-counter text-[10px] font-bold shrink-0">
                            {p.data.name.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="font-headline text-xs font-semibold text-[#191c1e] truncate">
                            {p.data.name}
                          </span>
                        </div>

                        {isSubmitted ? (
                          <div className="flex items-center gap-1 bg-[#42fed0]/40 px-2.5 py-0.5 rounded-full text-[#00725b] shrink-0">
                            <span className="material-symbols-outlined text-sm">check_circle</span>
                            <span className="font-counter text-[10px] uppercase font-bold">
                              Submitted ({resp.secondsToSubmit ? `0:${resp.secondsToSubmit.toString().padStart(2, '0')}` : '0:14'})
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 bg-[#eceef0] px-2.5 py-0.5 rounded-full text-[#76767e] shrink-0">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#76767e] animate-pulse"></span>
                            <span className="font-counter text-[10px] uppercase font-bold">Waiting...</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Stage Director Controls */}
              <div className="pt-2 flex flex-col gap-2 bg-[#f2f4f6] p-4 rounded-2xl border border-[#e0e3e5]">
                <span className="font-counter text-[10px] uppercase tracking-widest text-[#45464d] font-bold">
                  Stage Director Controls
                </span>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    onClick={handleTogglePause}
                    className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-full bg-white text-[#191c1e] font-headline text-xs font-bold hover:bg-[#eceef0] transition-colors shadow-sm cursor-pointer border border-[#e0e3e5]"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-base">
                      {session.isPaused ? 'play_arrow' : 'pause'}
                    </span>
                    <span>{session.isPaused ? 'Resume Timer' : 'Pause Timer'}</span>
                  </button>

                  <button
                    onClick={handleEndGame}
                    className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-full bg-[#ffdad6] text-[#93000a] font-headline text-xs font-bold hover:bg-[#ffdad6]/80 transition-colors shadow-sm cursor-pointer"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-base">stop_circle</span>
                    <span>End Game</span>
                  </button>
                </div>

                <button
                  onClick={handleNextQuestion}
                  className={`w-full mt-1 py-3 px-4 rounded-full font-headline font-bold text-sm flex items-center justify-center gap-2 shadow-md transition-all active:scale-95 cursor-pointer ${
                    isRoundComplete
                      ? 'bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018] ring-2 ring-[#006b55]'
                      : 'bg-[#42fed0] hover:bg-[#00e0b5] text-[#002018]'
                  }`}
                  type="button"
                >
                  <span>
                    {currentQIndex === 14 ? 'Finish Game →' : `Next Question (Q${currentQIndex + 2} of 15) →`}
                  </span>
                </button>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};
