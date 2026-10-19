import React, { useState, useEffect } from 'react';
import { ParticipantView } from './components/ParticipantView.tsx';
import { HostView } from './components/HostView.tsx';
import { testConnection } from './firebase.ts';

export default function App() {
  const [mode, setMode] = useState<'participant' | 'host'>(() => {
    const path = window.location.pathname;
    const searchParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash;

    if (path.includes('/host') || searchParams.get('mode') === 'host' || hash === '#host') {
      return 'host';
    }
    return 'participant';
  });

  const [prefilledCode, setPrefilledCode] = useState<string>(() => {
    const searchParams = new URLSearchParams(window.location.search);
    return searchParams.get('code') || '';
  });

  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  useEffect(() => {
    // Validate connection to Firestore on mount as mandated by the Firebase guide
    testConnection();

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handlePopState = () => {
      const path = window.location.pathname;
      const searchParams = new URLSearchParams(window.location.search);
      const hash = window.location.hash;
      if (path.includes('/host') || searchParams.get('mode') === 'host' || hash === '#host') {
        setMode('host');
      } else {
        setMode('participant');
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const switchMode = (newMode: 'participant' | 'host') => {
    setMode(newMode);
    const url = new URL(window.location.href);
    if (newMode === 'host') {
      url.pathname = '/host';
      url.searchParams.delete('code');
    } else {
      url.pathname = '/';
    }
    window.history.pushState({}, '', url.toString());
  };

  return (
    <div className="min-h-screen bg-[#f7f9fb] text-[#191c1e] flex flex-col font-body selection:bg-[#42fed0] selection:text-[#002018]">
      {/* Offline Connectivity Alert */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-[#ba1a1a] text-white py-1.5 px-4 text-center text-xs font-semibold flex items-center justify-center gap-2 shadow-md">
          <span className="material-symbols-outlined text-sm animate-spin">sync</span>
          <span>Lost connectivity. Reconnecting to live server...</span>
        </div>
      )}

      {/* Mode View */}
      {mode === 'host' ? (
        <HostView onSwitchToParticipant={() => switchMode('participant')} />
      ) : (
        <ParticipantView
          initialCode={prefilledCode}
          onSwitchToHost={() => switchMode('host')}
        />
      )}
    </div>
  );
}
