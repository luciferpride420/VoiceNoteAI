import React, { useState, useEffect, useRef } from 'react';
import { Waveform } from './components/Waveform';
import { ToastContainer, ToastMessage, ToastType } from './components/Toast';
import { transcribeAudio, analyzeTranscript, AIAnalysisResult } from './lib/gemini';
import { auth, loginWithGoogle, signupWithEmail, loginWithEmail, logout, db } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';

interface Session {
  id: number;
  name: string;
  date: string;
  time: string;
  duration: number;
  transcript: string;
  wordCount: number;
  analysis?: AIAnalysisResult;
}

export default function App() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionName, setCurrentSessionName] = useState('');
  
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [analysis, setAnalysis] = useState<AIAnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>('transcript');
  const [pendingLabel, setPendingLabel] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const rawChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('vn_sessions');
    if (saved) {
      setSessions(JSON.parse(saved));
    }
    
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setGoogleToken(event.data.token);
        showToast('Google Calendar connected!', 'success');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const showToast = (message: string, type: ToastType = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const saveSession = (t: string, s: number, a?: AIAnalysisResult) => {
    const name = currentSessionName || 'Untitled Session';
    const now = new Date();
    const session: Session = {
      id: Date.now(),
      name,
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      duration: s,
      transcript: t,
      wordCount: t.trim().split(/\s+/).filter(Boolean).length,
      analysis: a
    };

    setSessions(prev => {
      const idx = prev.findIndex(x => x.name === name && x.date === session.date);
      let next = [...prev];
      if (idx >= 0) next[idx] = session;
      else next.unshift(session);
      localStorage.setItem('vn_sessions', JSON.stringify(next));
      return next;
    });
  };

  const loadSession = (id: number) => {
    const s = sessions.find(x => x.id === id);
    if (!s) return;
    setTranscript(s.transcript || '');
    setAnalysis(s.analysis || null);
    setCurrentSessionName(s.name);
    setSeconds(s.duration);
    setActiveTab(s.analysis ? 'summary' : 'transcript');
    showToast('Loaded: ' + s.name, 'info');
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      
      if (currentUser) {
        // Create or update user profile in Firestore
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: currentUser.uid,
              email: currentUser.email,
              displayName: currentUser.displayName,
              photoURL: currentUser.photoURL,
              createdAt: new Date()
            });
          }
        } catch (error) {
          console.error("Error saving user profile:", error);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleGoogleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      await loginWithGoogle();
      showToast('Successfully logged in!', 'success');
      setShowAuthModal(false);
    } catch (error: any) {
      if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
        showToast('Login cancelled. Please try again.', 'info');
      } else if (error.code === 'auth/popup-blocked') {
        showToast('Popup blocked by browser. Please allow popups for this site and try again.', 'error');
      } else {
        const msg = error.message || 'Unknown error';
        if (msg.includes('INTERNAL ASSERTION FAILED')) {
          showToast('Authentication state error. Please refresh the page and try again.', 'error');
        } else {
          showToast('Failed to log in: ' + msg, 'error');
        }
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      if (authMode === 'signup') {
        await signupWithEmail(authEmail, authPassword);
        showToast('Account created successfully!', 'success');
      } else {
        await loginWithEmail(authEmail, authPassword);
        showToast('Successfully logged in!', 'success');
      }
      setShowAuthModal(false);
      setAuthEmail('');
      setAuthPassword('');
    } catch (error: any) {
      showToast('Authentication failed: ' + (error.message || 'Unknown error'), 'error');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      showToast('Successfully logged out!', 'success');
    } catch (error) {
      showToast('Failed to log out', 'error');
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setIsRecording(true);
      setIsPaused(false);
      setTranscript('');
      micStreamRef.current = stream;
      rawChunksRef.current = [];

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass();
      audioContextRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const ana = ctx.createAnalyser();
      ana.fftSize = 256;
      src.connect(ana);
      setAnalyser(ana);

      setSeconds(0);
      timerIntervalRef.current = window.setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);

      const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
      const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
      
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          rawChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        if (rawChunksRef.current.length === 0) {
          showToast('No audio recorded.', 'error');
          setPendingLabel('No audio — try again');
          return;
        }
        const fullBlob = new Blob(rawChunksRef.current, { type: mimeType || 'audio/webm' });
        await handleTranscription(fullBlob, mimeType || 'audio/webm');
      };

      recorder.start();
      setPendingLabel('● Recording...');
      showToast('🎙️ Recording! Click ⏹ when done — AI will transcribe instantly.', 'success');
    } catch (e: any) {
      setIsRecording(false);
      showToast('Mic error: ' + e.message, 'error');
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    setIsPaused(false);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.requestData();
      mediaRecorderRef.current.stop();
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setAnalyser(null);
    setPendingLabel('⏳ Transcribing your recording with Gemini AI...');
  };

  const toggleRecording = () => {
    if (!isRecording) startRecording();
    else stopRecording();
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      setPendingLabel('⏸ Recording paused');
    } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      timerIntervalRef.current = window.setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);
      setPendingLabel('● Recording...');
    }
  };

  const handleTranscription = async (blob: Blob, mimeType: string) => {
    try {
      const text = await transcribeAudio(blob, mimeType);
      
      if (text) {
        setTranscript(text);
        setPendingLabel('⏳ Generating meeting summary...');
        
        try {
          const analysisResult = await analyzeTranscript(text);
          setAnalysis(analysisResult);
          setActiveTab('summary');
          setPendingLabel('✅ Transcription & Summary complete!');
          saveSession(text, seconds, analysisResult);
          showToast('✅ Meeting summarized successfully!', 'success');
        } catch (analysisError) {
          console.error("Analysis failed:", analysisError);
          setPendingLabel('✅ Transcription complete (Summary failed)');
          saveSession(text, seconds);
          showToast('Transcription done, but summary failed.', 'info');
        }
      } else {
        setPendingLabel('⚠️ Gemini returned empty — speak louder or longer');
        showToast('Gemini returned no text. Try speaking more clearly.', 'error');
      }
    } catch (e: any) {
      showToast('Error: ' + e.message, 'error');
      setPendingLabel('❌ ' + e.message);
    }
  };

  const connectGoogleCalendar = async () => {
    try {
      const res = await fetch('/api/auth/url');
      const data = await res.json();
      if (data.url) {
        window.open(data.url, 'oauth_popup', 'width=600,height=700');
      } else {
        showToast('Failed to get auth URL', 'error');
      }
    } catch (e) {
      showToast('Error connecting to calendar', 'error');
    }
  };

  const formatTimer = (s: number) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };

  return (
    <>
      <div className="ambient ambient-1"></div>
      <div className="ambient ambient-2"></div>

      <header className="relative z-10 flex items-center justify-between px-8 py-4 border-b border-[#1e2d40] bg-[rgba(6,8,16,0.9)] backdrop-blur-md">
        <div className="flex items-center gap-3.5">
          <div className="w-[38px] h-[38px] bg-gradient-to-br from-[#00d4ff] to-[#00e5a0] rounded-lg flex items-center justify-center text-lg shadow-[0_0_20px_rgba(0,212,255,0.3)]">
            🎙️
          </div>
          <div className="font-sans font-extrabold text-xl tracking-tight">
            Voice<em className="text-[#00d4ff] not-italic">Note</em> AI
          </div>
        </div>
        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                {user.photoURL && (
                  <img src={user.photoURL} alt="Profile" className="w-8 h-8 rounded-full border border-[#1e2d40]" referrerPolicy="no-referrer" />
                )}
                <span className="text-[13px] font-medium text-[#e2e8f0] hidden sm:block">
                  {user.displayName || user.email}
                </span>
              </div>
              <button 
                className="text-[13px] font-bold text-[#e2e8f0] hover:text-[#00d4ff] transition-colors ml-2"
                onClick={handleLogout}
              >
                Log out
              </button>
            </div>
          ) : (
            <>
              <button 
                className={`text-[13px] font-bold text-[#e2e8f0] hover:text-[#00d4ff] transition-colors`}
                onClick={() => { setAuthMode('login'); setShowAuthModal(true); }}
              >
                Log in
              </button>
              <button 
                className={`text-[13px] font-bold bg-[#1e2d40] text-[#e2e8f0] px-4 py-2 rounded-lg hover:bg-[#00d4ff] hover:text-[#060810] transition-all duration-200`}
                onClick={() => { setAuthMode('signup'); setShowAuthModal(true); }}
              >
                Sign up
              </button>
            </>
          )}
        </div>
      </header>

      <main className="relative z-1 grid grid-cols-[280px_1fr_450px] h-[calc(100vh-71px)] overflow-hidden">
        
        {/* LEFT SIDEBAR */}
        <aside className="border-r border-[#1e2d40] bg-[rgba(13,17,23,0.8)] flex flex-col overflow-hidden">
          <div className="p-4 border-b border-[#1e2d40]">
            <div className="text-[10px] font-bold tracking-[1.5px] uppercase text-[#64748b] mb-3">Integrations</div>
            <div 
              className={`flex items-center gap-2.5 p-2.5 rounded-lg border mb-2 cursor-pointer transition-all duration-200 text-[13px] font-medium ${googleToken ? 'border-[rgba(0,229,160,0.4)] bg-[rgba(0,229,160,0.05)]' : 'bg-[#161b27] border-[#1e2d40] hover:border-[#00d4ff] hover:bg-[#1e2535]'}`}
              onClick={connectGoogleCalendar}
            >
              <span className="text-lg w-7 text-center">📅</span>
              <span>Google Calendar</span>
              <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${googleToken ? 'bg-[rgba(0,229,160,0.15)] text-[#00e5a0]' : 'bg-[rgba(100,116,139,0.15)] text-[#64748b]'}`}>
                {googleToken ? '✓ Connected' : 'Connect'}
              </span>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[#161b27] border border-[#1e2d40] mb-2 cursor-pointer transition-all duration-200 text-[13px] font-medium hover:border-[#00d4ff] hover:bg-[#1e2535]" onClick={() => showToast('Google Meet integration coming soon!', 'info')}>
              <span className="text-lg w-7 text-center">🎥</span>
              <span>Google Meet</span>
              <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full bg-[rgba(100,116,139,0.15)] text-[#64748b]">Soon</span>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[#161b27] border border-[#1e2d40] mb-2 cursor-pointer transition-all duration-200 text-[13px] font-medium hover:border-[#00d4ff] hover:bg-[#1e2535]" onClick={() => showToast('Discord integration coming soon!', 'info')}>
              <span className="text-lg w-7 text-center">👾</span>
              <span>Discord</span>
              <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full bg-[rgba(100,116,139,0.15)] text-[#64748b]">Soon</span>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-[#161b27] border border-[#1e2d40] mb-2 cursor-pointer transition-all duration-200 text-[13px] font-medium hover:border-[#00d4ff] hover:bg-[#1e2535]" onClick={() => showToast('Slack integration coming soon!', 'info')}>
              <span className="text-lg w-7 text-center">💬</span>
              <span>Slack</span>
              <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full bg-[rgba(100,116,139,0.15)] text-[#64748b]">Soon</span>
            </div>
          </div>

          <div className="p-4 pb-1 border-b-0">
            <div className="text-[10px] font-bold tracking-[1.5px] uppercase text-[#64748b] mb-3">Past Sessions</div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {sessions.length === 0 ? (
              <div className="text-center p-10 text-[#64748b] text-[13px] leading-relaxed">
                <div className="text-4xl mb-3">📂</div>
                No sessions yet.<br/>Start recording to create one.
              </div>
            ) : (
              sessions.map(s => (
                <div key={s.id} className="p-3 rounded-lg bg-[#161b27] border border-[#1e2d40] mb-2 cursor-pointer transition-all duration-200 hover:border-[#00d4ff] hover:bg-[#1e2535]" onClick={() => loadSession(s.id)}>
                  <div className="text-[13px] font-semibold mb-1 whitespace-nowrap overflow-hidden text-ellipsis">{s.name}</div>
                  <div className="text-[11px] text-[#64748b]">{s.date} · {s.wordCount} words</div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* CENTER */}
        <section className="flex flex-col overflow-hidden bg-[#060810]">
          <div className="p-8 flex-1 flex flex-col items-center justify-center gap-8">
            <div className="text-center">
              <div className="text-[28px] font-bold tracking-tight">Meeting <em className="text-[#00d4ff] not-italic">Recorder</em></div>
              <div className="text-[15px] text-[#64748b] mt-2">Record your meetings and transcribe them instantly</div>
            </div>

            <div className="w-full max-w-[600px]">
              <Waveform analyser={analyser} isRecording={isRecording} isPaused={isPaused} />
            </div>

            <div className={`font-mono text-[56px] font-light tracking-[2px] ${isRecording && !isPaused ? 'text-[#ff4d6d] animate-timerPulse' : isPaused ? 'text-[#ff8800]' : 'text-[#00d4ff]'}`}>
              {formatTimer(seconds)}
            </div>

            <div className="flex gap-6 items-center">
              {isRecording && (
                <button 
                  className={`w-16 h-16 rounded-full border-none cursor-pointer flex items-center justify-center text-[24px] transition-all duration-300 bg-[#161b27] border-2 ${isPaused ? 'border-[#ff8800] text-[#ff8800] shadow-[0_0_20px_rgba(255,136,0,0.3)]' : 'border-[#1e2d40] text-[#e2e8f0] hover:border-[#00d4ff] hover:text-[#00d4ff]'}`}
                  onClick={pauseRecording}
                  title={isPaused ? "Resume Recording" : "Pause Recording"}
                >
                  {isPaused ? '▶️' : '⏸'}
                </button>
              )}
              <button 
                className={`w-24 h-24 rounded-full border-none cursor-pointer flex items-center justify-center text-[32px] transition-all duration-300 relative ${isRecording ? 'bg-gradient-to-br from-[#ff4d6d] to-[#cc0033] hover:scale-105 hover:shadow-[0_0_30px_rgba(255,77,109,0.5)]' : 'bg-gradient-to-br from-[#ff4d6d] to-[#cc0033] hover:scale-105 hover:shadow-[0_0_30px_rgba(255,77,109,0.5)]'}`}
                onClick={toggleRecording}
                title={isRecording ? "Stop Recording" : "Start Recording"}
              >
                {isRecording ? '⏹' : '🔴'}
              </button>
            </div>
            
            <div className="text-sm text-[#64748b] font-medium h-6">
              {isRecording ? (isPaused ? '⏸ Recording paused... click ▶️ to resume' : '● Recording... click ⏹ to stop and transcribe') : pendingLabel || 'Click to start recording'}
            </div>

            <div className="flex gap-2.5 w-full max-w-[500px] mt-4">
              <input 
                className="form-input flex-1 text-center text-lg py-3" 
                placeholder="Session name (e.g. Q3 Planning Meeting)" 
                value={currentSessionName}
                onChange={e => setCurrentSessionName(e.target.value)}
              />
            </div>
          </div>
        </section>

        {/* RIGHT SIDEBAR - TRANSCRIPT & SUMMARY */}
        <aside className="border-l border-[#1e2d40] bg-[rgba(13,17,23,0.8)] flex flex-col overflow-hidden w-[450px]">
          <div className="flex-1 overflow-y-auto p-6 flex flex-col">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <div className="flex gap-2 bg-[#161b27] p-1 rounded-lg border border-[#1e2d40]">
                <button 
                  className={`px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${activeTab === 'transcript' ? 'bg-[#1e2d40] text-white shadow-sm' : 'text-[#64748b] hover:text-[#e2e8f0]'}`}
                  onClick={() => setActiveTab('transcript')}
                >
                  Transcript
                </button>
                <button 
                  className={`px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${activeTab === 'summary' ? 'bg-[#1e2d40] text-white shadow-sm' : 'text-[#64748b] hover:text-[#e2e8f0]'}`}
                  onClick={() => setActiveTab('summary')}
                >
                  Summary
                </button>
              </div>
              <div className="flex gap-2">
                {activeTab === 'transcript' && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold tracking-[0.5px] bg-[rgba(0,212,255,0.1)] text-[#00d4ff] border border-[rgba(0,212,255,0.2)] mt-1">
                    {transcript.trim().split(/\s+/).filter(Boolean).length} words
                  </span>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => {
                  const content = activeTab === 'transcript' ? transcript : JSON.stringify(analysis, null, 2);
                  navigator.clipboard.writeText(content || '');
                  showToast('Copied to clipboard!', 'success');
                }}>Copy</button>
                <button className="btn btn-ghost btn-sm" onClick={() => {
                  setTranscript('');
                  setAnalysis(null);
                  setSeconds(0);
                }}>Clear</button>
              </div>
            </div>
            <div className="flex-1 bg-[#0d1117] border border-[#1e2d40] rounded-xl p-5 text-[15px] leading-[1.8] text-[#e2e8f0] font-sans overflow-y-auto">
              {activeTab === 'transcript' ? (
                <div className="whitespace-pre-wrap">
                  {!transcript && !pendingLabel && (
                    <span className="text-[#64748b] italic">Your transcription will appear here. Recording supports long sessions — no time limit.</span>
                  )}
                  {transcript}
                  {pendingLabel && !transcript && <span className="text-[#64748b] italic"> {pendingLabel}</span>}
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {!analysis && !pendingLabel && (
                    <span className="text-[#64748b] italic">Meeting summary will appear here after transcription.</span>
                  )}
                  {pendingLabel && !analysis && <span className="text-[#64748b] italic"> {pendingLabel}</span>}
                  
                  {analysis && (
                    <>
                      <div>
                        <h4 className="text-[11px] font-bold tracking-[1px] uppercase text-[#00d4ff] mb-2">Executive Summary</h4>
                        <p className="text-[14px] text-[#e2e8f0] leading-relaxed">{analysis.summary}</p>
                      </div>
                      
                      {analysis.key_topics?.length > 0 && (
                        <div>
                          <h4 className="text-[11px] font-bold tracking-[1px] uppercase text-[#00d4ff] mb-2">Key Topics</h4>
                          <ul className="list-disc pl-5 text-[14px] text-[#e2e8f0] space-y-1">
                            {analysis.key_topics.map((topic, i) => <li key={i}>{topic}</li>)}
                          </ul>
                        </div>
                      )}
                      
                      {analysis.action_items?.length > 0 && (
                        <div>
                          <h4 className="text-[11px] font-bold tracking-[1px] uppercase text-[#00d4ff] mb-2">Action Items</h4>
                          <div className="flex flex-col gap-2">
                            {analysis.action_items.map((item, i) => (
                              <div key={i} className="bg-[#161b27] p-3 rounded-lg border border-[#1e2d40] text-[13px]">
                                <div className="font-medium text-white mb-1">{item.task}</div>
                                <div className="flex gap-3 text-[#64748b] text-[11px]">
                                  {item.owner && <span>👤 {item.owner}</span>}
                                  {item.due && <span>📅 {item.due}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {analysis.decisions?.length > 0 && (
                        <div>
                          <h4 className="text-[11px] font-bold tracking-[1px] uppercase text-[#00d4ff] mb-2">Decisions Made</h4>
                          <ul className="list-disc pl-5 text-[14px] text-[#e2e8f0] space-y-1">
                            {analysis.decisions.map((decision, i) => <li key={i}>{decision}</li>)}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>
      </main>

      <ToastContainer toasts={toasts} removeToast={(id) => setToasts(prev => prev.filter(t => t.id !== id))} />

      {showAuthModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[#0d1117] border border-[#1e2d40] rounded-2xl p-8 w-full max-w-md shadow-2xl relative">
            <button 
              className="absolute top-4 right-4 text-[#64748b] hover:text-white transition-colors"
              onClick={() => setShowAuthModal(false)}
            >
              ✕
            </button>
            
            <h2 className="text-2xl font-bold text-white mb-6 text-center">
              {authMode === 'login' ? 'Welcome Back' : 'Create Account'}
            </h2>
            
            <form onSubmit={handleEmailAuth} className="flex flex-col gap-4 mb-6">
              <div>
                <label className="block text-[11px] font-bold tracking-wide text-[#64748b] uppercase mb-1.5">Email</label>
                <input 
                  type="email" 
                  required
                  className="w-full bg-[#161b27] border border-[#1e2d40] rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-[#00d4ff] transition-colors"
                  value={authEmail}
                  onChange={e => setAuthEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold tracking-wide text-[#64748b] uppercase mb-1.5">Password</label>
                <input 
                  type="password" 
                  required
                  className="w-full bg-[#161b27] border border-[#1e2d40] rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-[#00d4ff] transition-colors"
                  value={authPassword}
                  onChange={e => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                  minLength={6}
                />
              </div>
              <button 
                type="submit"
                disabled={isLoggingIn}
                className="w-full bg-[#00d4ff] text-[#060810] font-bold py-2.5 rounded-lg mt-2 hover:bg-[#00e5a0] transition-colors disabled:opacity-50"
              >
                {isLoggingIn ? 'Please wait...' : (authMode === 'login' ? 'Log In' : 'Sign Up')}
              </button>
            </form>
            
            <div className="relative flex items-center py-2 mb-6">
              <div className="flex-grow border-t border-[#1e2d40]"></div>
              <span className="flex-shrink-0 mx-4 text-[#64748b] text-xs">OR</span>
              <div className="flex-grow border-t border-[#1e2d40]"></div>
            </div>
            
            <button 
              type="button"
              onClick={handleGoogleLogin}
              disabled={isLoggingIn}
              className="w-full bg-white text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-3 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </button>
            
            <div className="mt-6 text-center text-[13px] text-[#64748b]">
              {authMode === 'login' ? "Don't have an account? " : "Already have an account? "}
              <button 
                className="text-[#00d4ff] hover:underline"
                onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
              >
                {authMode === 'login' ? 'Sign up' : 'Log in'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

