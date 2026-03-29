/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Mic, 
  Square, 
  Search, 
  Folder, 
  Plus, 
  MoreVertical, 
  FileText, 
  Share2, 
  Trash2, 
  ChevronRight, 
  Clock, 
  Calendar as CalendarIcon,
  CheckSquare,
  List,
  PlusCircle,
  MessageSquare,
  LogOut,
  User,
  Download,
  Mail,
  Slack,
  Loader2,
  X,
  Menu,
  Upload,
  MessageCircle,
  FileDown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { jsPDF } from 'jspdf';
import html2pdf from 'html2pdf.js';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  doc, 
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { db, auth, signIn, logOut } from './firebase';
import { GoogleGenAI, Type } from "@google/genai";
import { format } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import { cn } from './lib/utils';

// --- Types ---

interface Meeting {
  id: string;
  title: string;
  date: any;
  duration: number;
  transcript: string;
  summary: string;
  actionItems: string[];
  keyPoints: string[];
  nextSteps: string[];
  folder: string;
  uid: string;
  language?: string;
  translations?: Record<string, Partial<Meeting>>;
}

const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn("animate-pulse bg-zinc-800/50 rounded-2xl", className)} />
);

const Waveform = ({ isRecording, stream, isSkippingSilence }: { isRecording: boolean; stream: MediaStream | null; isSkippingSilence?: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const analyzerRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    if (isRecording && stream && canvasRef.current) {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 256;
      source.connect(analyzer);
      analyzerRef.current = analyzer;

      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d')!;

      const draw = () => {
        animationRef.current = requestAnimationFrame(draw);
        analyzer.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          barHeight = isSkippingSilence ? 2 : (dataArray[i] / 255) * canvas.height;
          ctx.fillStyle = isSkippingSilence 
            ? `rgba(161, 161, 170, 0.2)` 
            : `rgba(242, 125, 38, ${0.3 + (dataArray[i] / 255) * 0.7})`;
          ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
          x += barWidth + 1;
        }
      };

      draw();

      return () => {
        cancelAnimationFrame(animationRef.current);
        audioContext.close();
      };
    }
  }, [isRecording, stream, isSkippingSilence]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-24 rounded-lg opacity-50"
      width={400}
      height={100}
    />
  );
};

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isSkippingSilence, setIsSkippingSilence] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [wakeLock, setWakeLock] = useState<any>(null);
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('All');
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'ai'; text: string; timestamp: Date }[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isPDFModalOpen, setIsPDFModalOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isNewMeetingModalOpen, setIsNewMeetingModalOpen] = useState(false);
  const [newMeetingName, setNewMeetingName] = useState('');

  const folderCounts = useMemo(() => {
    return {
      All: meetings.length,
      Work: meetings.filter(m => m.folder === 'Work').length,
      School: meetings.filter(m => m.folder === 'School').length,
      Personal: meetings.filter(m => m.folder === 'Personal').length,
      General: meetings.filter(m => m.folder === 'General').length,
    };
  }, [meetings]);
  const [meetingToDeleteId, setMeetingToDeleteId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, isChatLoading]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isPausedRef = useRef<boolean>(false);
  const totalPausedTimeRef = useRef<number>(0);
  const pauseStartTimeRef = useRef<number | null>(null);

  // Re-request Wake Lock if tab becomes visible again and we are recording
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (isRecording && document.visibilityState === 'visible' && !wakeLock) {
        if ('wakeLock' in navigator) {
          try {
            const lock = await (navigator as any).wakeLock.request('screen');
            setWakeLock(lock);
            console.log('Wake Lock re-acquired');
          } catch (err) {
            console.error('Wake Lock re-acquisition failed:', err);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isRecording, wakeLock]);

  // --- Auth & Data ---

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (user) {
      const q = query(
        collection(db, 'meetings'),
        where('uid', '==', user.uid),
        orderBy('date', 'desc')
      );
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Meeting));
        setMeetings(docs);
        setIsInitialLoading(false);
      }, (error) => {
        console.error("Firestore Error: ", error);
        setIsInitialLoading(false);
      });
      return unsubscribe;
    } else {
      setIsInitialLoading(false);
    }
  }, [user]);

  // Test connection
  useEffect(() => {
    if (isAuthReady) {
      const testConnection = async () => {
        try {
          await getDocFromServer(doc(db, 'test', 'connection'));
        } catch (error) {
          if (error instanceof Error && error.message.includes('the client is offline')) {
            console.error("Please check your Firebase configuration.");
          }
        }
      };
      testConnection();
    }
  }, [isAuthReady]);

  // --- Recording Logic ---

  const startRecording = async (name?: string) => {
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStream(audioStream);
      const recorder = new MediaRecorder(audioStream);
      setMediaRecorder(recorder);
      
      // Request Wake Lock to keep recording in background
      if ('wakeLock' in navigator) {
        try {
          const lock = await (navigator as any).wakeLock.request('screen');
          setWakeLock(lock);
          console.log('Wake Lock is active');
        } catch (err) {
          console.error('Wake Lock request failed:', err);
        }
      }

      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = async () => {
        const audioBlob = new Blob(chunks, { type: 'audio/webm' });
        const duration = recordingTime;
        await processAudio(audioBlob, duration, name || null);
      };

      // --- Silence Detection Setup ---
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      const SILENCE_THRESHOLD = 15; // Adjustment might be needed
      const SILENCE_DURATION = 2000; // 2 seconds of silence before skipping
      let lastSoundTime = Date.now();

      const checkSilence = () => {
        if (!recorder || recorder.state === 'inactive') return;
        
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        if (average > SILENCE_THRESHOLD) {
          lastSoundTime = Date.now();
          if (isPausedRef.current) {
            recorder.resume();
            isPausedRef.current = false;
            setIsSkippingSilence(false);
            if (pauseStartTimeRef.current) {
              totalPausedTimeRef.current += (Date.now() - pauseStartTimeRef.current);
              pauseStartTimeRef.current = null;
            }
          }
        } else {
          if (Date.now() - lastSoundTime > SILENCE_DURATION) {
            if (!isPausedRef.current && recorder.state === 'recording') {
              recorder.pause();
              isPausedRef.current = true;
              setIsSkippingSilence(true);
              pauseStartTimeRef.current = Date.now();
            }
          }
        }
        
        animationFrameRef.current = requestAnimationFrame(checkSilence);
      };

      recorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      setIsSkippingSilence(false);
      isPausedRef.current = false;
      totalPausedTimeRef.current = 0;
      pauseStartTimeRef.current = null;
      startTimeRef.current = Date.now();
      
      checkSilence();

      timerRef.current = setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = Date.now() - startTimeRef.current;
          const currentPaused = pauseStartTimeRef.current ? (Date.now() - pauseStartTimeRef.current) : 0;
          const activeTime = elapsed - (totalPausedTimeRef.current + currentPaused);
          setRecordingTime(Math.floor(activeTime / 1000));
        }
      }, 1000);
    } catch (err) {
      console.error("Failed to start recording:", err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      stream?.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      setIsSkippingSilence(false);
      
      // Cleanup Audio Analysis
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
      
      audioContextRef.current = null;
      analyserRef.current = null;
      isPausedRef.current = false;

      // Release Wake Lock
      if (wakeLock) {
        wakeLock.release().then(() => {
          setWakeLock(null);
          console.log('Wake Lock released');
        });
      }

      if (timerRef.current) clearInterval(timerRef.current);
      startTimeRef.current = null;
      totalPausedTimeRef.current = 0;
      pauseStartTimeRef.current = null;
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    
    // Get duration
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.onloadedmetadata = () => {
      const duration = Math.round(audio.duration);
      processAudio(file, duration);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    
    audio.onerror = () => {
      // If we can't get duration, just process with 0
      processAudio(file, 0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
  };

  const processAudio = async (blob: Blob, duration: number, customName: string | null = null) => {
    setIsProcessing(true);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const base64Audio = (reader.result as string).split(',')[1];
        
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              inlineData: {
                mimeType: blob.type || "audio/webm",
                data: base64Audio
              }
            },
            {
              text: `Transcribe this meeting audio with high accuracy. 
              Identify different speakers (Speaker 1, Speaker 2, etc.).
              Then, provide a structured summary in JSON format with the following fields:
              - title: ${customName ? `Use exactly "${customName}" as the title.` : "A short, catchy title for the meeting."}
              - summary: A 3-sentence executive summary in the primary language detected.
              - keyPoints: An array of main topics discussed in the primary language detected.
              - actionItems: An array of tasks assigned to specific people in the primary language detected.
              - nextSteps: An array of dates or deadlines mentioned in the primary language detected.
              - folder: Suggest a folder (Work, School, Personal, or General).
              - language: The primary language spoken in the audio (e.g., "English", "Hindi", "Spanish", etc.).
              
              Return ONLY the JSON object.`
            }
          ],
          config: {
            responseMimeType: "application/json"
          }
        });

        const result = JSON.parse(response.text);
        
        // Save to Firestore
        await addDoc(collection(db, 'meetings'), {
          ...result,
          transcript: response.text, // In a real app, we'd store the full transcript separately
          date: serverTimestamp(),
          duration: duration,
          uid: user?.uid
        });

        setIsProcessing(false);
      };
    } catch (err) {
      console.error("AI Processing failed:", err);
      setIsProcessing(false);
    }
  };

  // --- Helpers ---

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const filteredMeetings = useMemo(() => {
    return meetings.filter(m => {
      const matchesSearch = m.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          m.summary.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesFolder = selectedFolder === 'All' || m.folder === selectedFolder;
      return matchesSearch && matchesFolder;
    });
  }, [meetings, searchQuery, selectedFolder]);

  const handleChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatMessage.trim() || !selectedMeeting) return;

    const newMessage = { role: 'user' as const, text: chatMessage, timestamp: new Date() };
    setChatHistory(prev => [...prev, newMessage]);
    setChatMessage('');
    setIsChatLoading(true);

    // Initial AI message for streaming
    const aiMessageId = Date.now().toString();
    setChatHistory(prev => [...prev, { role: 'ai', text: '', timestamp: new Date() }]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const stream = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        contents: [
          { text: `Context: This is a meeting titled "${selectedMeeting.title}". 
            Transcript: ${selectedMeeting.transcript}
            Summary: ${selectedMeeting.summary}
            Detected Meeting Language: ${selectedMeeting.language || 'Unknown'}
            
            User Question: ${chatMessage}
            
            IMPORTANT: 
            1. Respond in the same language as the user's question. If the user's language is unclear, use the Detected Meeting Language (${selectedMeeting.language || 'English'}).
            2. Use a clear, point-wise (bulleted) format for the response.
            3. Use bold text for key terms.
            4. Keep the tone professional and helpful.` }
        ]
      });

      let fullText = '';
      for await (const chunk of stream) {
        fullText += chunk.text;
        setChatHistory(prev => {
          const newHistory = [...prev];
          const lastMsg = newHistory[newHistory.length - 1];
          if (lastMsg && lastMsg.role === 'ai') {
            lastMsg.text = fullText;
          }
          return newHistory;
        });
      }
    } catch (err) {
      console.error("Chat failed:", err);
      setChatHistory(prev => [...prev, { role: 'ai', text: 'Sorry, I encountered an error. Please try again.', timestamp: new Date() }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const downloadAudio = (meeting: Meeting) => {
    // In a real app, we'd store the audio in Firebase Storage and get a URL.
    // For this demo, we'll assume the user wants to download the current recording if they just finished it.
    // However, since we don't persist the audio blob in Firestore (due to 1MB limit), 
    // we'll inform the user that audio storage requires a storage bucket.
    alert("Audio storage requires Firebase Storage. Transcripts and summaries are saved securely in Firestore.");
  };

  const downloadSummary = (meeting: Meeting) => {
    const content = `
${meeting.title}
Date: ${meeting.date ? format(meeting.date.toDate(), 'MMMM d, yyyy h:mm a') : 'N/A'}

EXECUTIVE SUMMARY
${meeting.summary}

KEY POINTS
${meeting.keyPoints.map(p => `- ${p}`).join('\n')}

ACTION ITEMS
${meeting.actionItems.map(a => `- ${a}`).join('\n')}

NEXT STEPS
${meeting.nextSteps.map(s => `- ${s}`).join('\n')}

TRANSCRIPT
${meeting.transcript}
    `;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${meeting.title.replace(/\s+/g, '_')}_Summary.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shareToWhatsApp = (meeting: Meeting) => {
    const display = meeting;
    const lang = meeting.language || 'English';
    
    let message = `*Meeting Summary: ${display.title}*\n\n`;
    
    // Truncate summary if it's too long to avoid URL length issues (especially with non-latin chars)
    const maxSummaryLen = lang.toLowerCase().includes('english') ? 1000 : 400;
    const summary = display.summary.length > maxSummaryLen 
      ? display.summary.substring(0, maxSummaryLen) + '...' 
      : display.summary;

    message += `*Summary:*\n${summary}\n\n`;
    
    if (display.keyPoints && display.keyPoints.length > 0) {
      message += `*Key Points:*\n`;
      // Limit key points to avoid URL length issues
      display.keyPoints.slice(0, 8).forEach((point: string) => {
        message += `• ${point}\n`;
      });
      message += `\n`;
    }
    
    if (display.nextSteps && display.nextSteps.length > 0) {
      message += `*Next Steps:*\n`;
      display.nextSteps.slice(0, 5).forEach((step: string) => {
        message += `• ${step}\n`;
      });
    }
    
    const encodedMessage = encodeURIComponent(message);
    // wa.me is often better for long messages
    const whatsappUrl = `https://wa.me/?text=${encodedMessage}`;
    window.open(whatsappUrl, '_blank');
  };

  const deleteMeeting = async (meetingId: string) => {
    // Optimistic update
    setMeetings(prev => prev.filter(m => m.id !== meetingId));
    if (selectedMeeting?.id === meetingId) {
      setSelectedMeeting(null);
    }
    setIsDeleteConfirmOpen(false);
    setMeetingToDeleteId(null);
    
    try {
      await deleteDoc(doc(db, 'meetings', meetingId));
    } catch (err) {
      console.error("Delete failed:", err);
      // In a real app, we might want to revert the optimistic update here
      // but Firestore real-time listeners usually handle this.
    }
  };
  const exportToEmail = (meeting: Meeting) => {
    const subject = `Meeting Summary: ${meeting.title}`;
    const body = `
Executive Summary:
${meeting.summary}

Key Discussion Points:
${meeting.keyPoints.map(p => `- ${p}`).join('\n')}

Action Items:
${meeting.actionItems.map(a => `- ${a}`).join('\n')}

Next Steps:
${meeting.nextSteps.map(s => `- ${s}`).join('\n')}
    `;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const generatePDF = async (meeting: Meeting, shouldShare: boolean = false) => {
    const display = meeting;
    const dateStr = meeting.date ? format(meeting.date.toDate(), 'MMMM d, yyyy h:mm a') : 'Recent';

    // Create a temporary container for the PDF content
    const element = document.createElement('div');
    element.style.padding = '40px';
    element.style.color = '#000';
    element.style.backgroundColor = '#fff';
    element.style.fontFamily = '"Inter", "Arial", sans-serif';
    element.style.width = '800px'; // Fixed width for consistent rendering

    element.innerHTML = `
      <div style="margin-bottom: 30px; border-bottom: 2px solid #F27D26; padding-bottom: 10px;">
        <h1 style="color: #F27D26; font-size: 28px; margin: 0;">${display.title}</h1>
        <p style="color: #666; font-size: 12px; margin-top: 5px;">
          Date: ${dateStr} | Duration: ${formatTime(meeting.duration)} | Folder: ${meeting.folder} | Language: ${meeting.language || 'Detected'}
        </p>
      </div>

      <div style="margin-bottom: 25px;">
        <h2 style="font-size: 18px; color: #333; margin-bottom: 10px; border-left: 4px solid #F27D26; padding-left: 10px;">
          Summary
        </h2>
        <p style="font-size: 14px; line-height: 1.6; color: #444; white-space: pre-wrap;">${display.summary}</p>
      </div>

      ${display.keyPoints?.length > 0 ? `
        <div style="margin-bottom: 25px;">
          <h2 style="font-size: 18px; color: #333; margin-bottom: 10px; border-left: 4px solid #F27D26; padding-left: 10px;">
            Key Points
          </h2>
          <ul style="font-size: 14px; line-height: 1.6; color: #444; padding-left: 20px;">
            ${display.keyPoints.map((point: string) => `<li style="margin-bottom: 5px;">${point}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      ${display.actionItems?.length > 0 ? `
        <div style="margin-bottom: 25px;">
          <h2 style="font-size: 18px; color: #333; margin-bottom: 10px; border-left: 4px solid #F27D26; padding-left: 10px;">
            Action Items
          </h2>
          <ul style="font-size: 14px; line-height: 1.6; color: #444; padding-left: 20px; list-style-type: none;">
            ${display.actionItems.map((item: string) => `<li style="margin-bottom: 5px;">☐ ${item}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      ${display.nextSteps?.length > 0 ? `
        <div style="margin-bottom: 25px;">
          <h2 style="font-size: 18px; color: #333; margin-bottom: 10px; border-left: 4px solid #F27D26; padding-left: 10px;">
            Next Steps
          </h2>
          <ul style="font-size: 14px; line-height: 1.6; color: #444; padding-left: 20px;">
            ${display.nextSteps.map((step: string) => `<li style="margin-bottom: 5px;">${step}</li>`).join('')}
          </ul>
        </div>
      ` : ''}

      <div style="margin-top: 50px; border-top: 1px solid #eee; padding-top: 10px; text-align: center; color: #999; font-size: 10px;">
        Generated by Digital Graphity
      </div>
    `;

    const opt = {
      margin: 10,
      filename: `${display.title.replace(/\s+/g, '_')}_Summary.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, letterRendering: true },
      jsPDF: { unit: 'mm' as const, format: 'a4' as const, orientation: 'portrait' as const }
    };

    try {
      await html2pdf().from(element).set(opt).save();
      
      if (shouldShare) {
        const message = `Thank you Sir for this meeting this is our Meets Of Meeting please check.\n\n*Thanks*\n*Digital Graphity*`;
        window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
      }
    } catch (err) {
      console.error("PDF generation failed:", err);
    } finally {
      setIsPDFModalOpen(false);
    }
  };

  if (!isAuthReady) return <div className="h-screen flex items-center justify-center bg-[#050505]"><Loader2 className="animate-spin text-[#F27D26]" /></div>;

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#050505] p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md"
        >
          <div className="w-20 h-20 bg-[#F27D26] rounded-3xl flex items-center justify-center mb-8 mx-auto shadow-[0_0_40px_rgba(242,125,38,0.3)]">
            <Mic className="text-white w-10 h-10" />
          </div>
          <h1 className="text-5xl font-bold text-white mb-4 tracking-tight">Digital Graphity</h1>
          <p className="text-zinc-400 mb-10 text-lg">Securely record, transcribe, and summarize your meetings with professional-grade AI.</p>
          <button 
            onClick={signIn}
            className="w-full py-4 bg-white text-black font-semibold rounded-2xl hover:bg-zinc-200 transition-colors flex items-center justify-center gap-3"
          >
            <User className="w-5 h-5" />
            Continue with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white flex flex-col md:flex-row font-sans relative overflow-hidden">
      {/* Background Glows */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#F27D26]/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/5 blur-[120px] rounded-full pointer-events-none" />

      {/* Sidebar - Desktop */}
      <div className="hidden md:flex w-72 border-r border-zinc-800/50 flex-col p-6 bg-[#050505]/40 backdrop-blur-xl z-20">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 bg-[#F27D26] rounded-xl flex items-center justify-center">
            <Mic className="text-white w-6 h-6" />
          </div>
          <span className="font-bold text-xl tracking-tight">Digital Graphity</span>
        </div>

        <nav className="space-y-2 flex-1">
          <button 
            onClick={() => setSelectedFolder('All')}
            className={cn(
              "w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors",
              selectedFolder === 'All' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"
            )}
          >
            <div className="flex items-center gap-3">
              <List className="w-5 h-5" />
              All Meetings
            </div>
            <span className="text-xs font-medium bg-zinc-900 px-2 py-0.5 rounded-full text-zinc-500">
              {folderCounts.All}
            </span>
          </button>
          {['Work', 'School', 'Personal', 'General'].map(folder => (
            <button 
              key={folder}
              onClick={() => setSelectedFolder(folder)}
              className={cn(
                "w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors",
                selectedFolder === folder ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"
              )}
            >
              <div className="flex items-center gap-3">
                <Folder className="w-5 h-5" />
                {folder}
              </div>
              <span className="text-xs font-medium bg-zinc-900 px-2 py-0.5 rounded-full text-zinc-500">
                {folderCounts[folder as keyof typeof folderCounts]}
              </span>
            </button>
          ))}
        </nav>

        <div className="pt-6 border-t border-zinc-800">
          <div className="flex items-center gap-3 mb-4 px-2">
            <img src={user.photoURL || ''} className="w-8 h-8 rounded-full" alt="" />
            <div className="flex-1 overflow-hidden">
              <p className="text-sm font-medium truncate">{user.displayName}</p>
              <p className="text-xs text-zinc-500 truncate">{user.email}</p>
            </div>
          </div>
          <button 
            onClick={logOut}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Header */}
        <header className="p-4 md:p-6 border-b border-zinc-800 flex items-center justify-between bg-[#050505]/80 backdrop-blur-xl z-10">
          <div className="flex items-center gap-2 md:gap-4 flex-1">
            <button 
              onClick={() => setIsMobileMenuOpen(true)}
              className="md:hidden p-2 bg-zinc-900 rounded-xl text-zinc-400 hover:text-white transition-colors"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-2 md:hidden">
              <div className="w-8 h-8 bg-[#F27D26] rounded-lg flex items-center justify-center flex-shrink-0">
                <Mic className="text-white w-5 h-5" />
              </div>
              <span className="font-bold text-base tracking-tight hidden sm:inline">Digital Graphity</span>
            </div>
            <div className="relative flex-1 max-w-md hidden md:block">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
              <input 
                type="text" 
                placeholder="Search meetings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-zinc-900 border-none rounded-2xl py-3 pl-12 pr-4 text-sm focus:ring-2 focus:ring-[#F27D26] transition-all"
              />
            </div>
          </div>
          <div className="flex items-center gap-4 ml-4">
            <input 
              type="file" 
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="audio/*"
              className="hidden"
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isRecording || isProcessing}
              className="p-3 md:px-6 md:py-3 rounded-2xl font-semibold flex items-center gap-2 bg-zinc-800 text-white hover:bg-zinc-700 transition-all shadow-lg disabled:opacity-50"
              title="Upload Audio"
            >
              <Upload className="w-5 h-5" />
              <span className="hidden md:inline">Upload Audio</span>
            </button>
            <button 
              onClick={isRecording ? stopRecording : () => setIsNewMeetingModalOpen(true)}
              disabled={isProcessing}
              className={cn(
                "p-3 md:px-6 md:py-3 rounded-2xl font-semibold flex items-center gap-2 transition-all shadow-lg disabled:opacity-50",
                isRecording 
                  ? "bg-red-500 text-white animate-pulse" 
                  : "bg-[#F27D26] text-white hover:bg-[#d96a1b]"
              )}
              title={isRecording ? "Stop Recording" : "New Meeting"}
            >
              {isRecording ? <Square className="w-5 h-5 fill-current" /> : <PlusCircle className="w-5 h-5" />}
              <span className="text-sm md:text-base">
                {isRecording ? formatTime(recordingTime) : "New Meeting"}
              </span>
            </button>
          </div>
        </header>

        {/* Mobile Sidebar Overlay */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <>
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsMobileMenuOpen(false)}
                className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] md:hidden"
              />
              <motion.div 
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed inset-y-0 left-0 w-72 bg-[#050505] border-r border-zinc-800 z-[70] md:hidden flex flex-col p-6 shadow-2xl"
              >
                <div className="flex items-center justify-between mb-10">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-[#F27D26] rounded-xl flex items-center justify-center">
                      <Mic className="text-white w-6 h-6" />
                    </div>
                    <span className="font-bold text-xl tracking-tight">Digital Graphity</span>
                  </div>
                  <button 
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="p-2 bg-zinc-900 rounded-xl text-zinc-400 hover:text-white transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <nav className="space-y-2 flex-1">
                  <button 
                    onClick={() => {
                      setSelectedFolder('All');
                      setIsMobileMenuOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors",
                      selectedFolder === 'All' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <List className="w-5 h-5" />
                      All Meetings
                    </div>
                    <span className="text-xs font-medium bg-zinc-900 px-2 py-0.5 rounded-full text-zinc-500">
                      {folderCounts.All}
                    </span>
                  </button>
                  {['Work', 'School', 'Personal', 'General'].map(folder => (
                    <button 
                      key={folder}
                      onClick={() => {
                        setSelectedFolder(folder);
                        setIsMobileMenuOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors",
                        selectedFolder === folder ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <Folder className="w-5 h-5" />
                        {folder}
                      </div>
                      <span className="text-xs font-medium bg-zinc-900 px-2 py-0.5 rounded-full text-zinc-500">
                        {folderCounts[folder as keyof typeof folderCounts]}
                      </span>
                    </button>
                  ))}
                </nav>

                <div className="pt-6 border-t border-zinc-800">
                  <div className="flex items-center gap-3 mb-4 px-2">
                    <img src={user.photoURL || ''} className="w-8 h-8 rounded-full" alt="" />
                    <div className="flex-1 overflow-hidden">
                      <p className="text-sm font-medium truncate">{user.displayName}</p>
                      <p className="text-xs text-zinc-500 truncate">{user.email}</p>
                    </div>
                  </div>
                  <button 
                    onClick={logOut}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <LogOut className="w-5 h-5" />
                    Sign Out
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-6 space-y-6 relative">
          {isRecording && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-zinc-900/50 backdrop-blur-md rounded-[32px] p-8 border border-red-500/20 relative overflow-hidden shadow-2xl"
            >
              <div className="absolute top-0 left-0 w-1 h-full bg-red-500" />
              <div className="flex flex-col items-center text-center space-y-6">
                <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center relative">
                  <div className={cn("absolute inset-0 bg-red-500/20 rounded-full", !isSkippingSilence && "animate-ping")} />
                  <Mic className={cn("text-red-500 w-10 h-10 relative z-10", !isSkippingSilence && "animate-bounce")} />
                </div>
                <div>
                  <h2 className="text-3xl font-bold tracking-tight mb-2">
                    {isSkippingSilence ? "Skipping Silence..." : "Recording in Progress"}
                  </h2>
                  <p className="text-zinc-400 text-lg">
                    {isSkippingSilence 
                      ? "Audio capture paused to save space" 
                      : `Capturing audio... ${formatTime(recordingTime)}`}
                  </p>
                </div>
                <div className="w-full max-w-md">
                  <Waveform isRecording={isRecording} stream={stream} isSkippingSilence={isSkippingSilence} />
                </div>
              </div>
            </motion.div>
          )}

          {isProcessing && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-zinc-900/50 backdrop-blur-md rounded-[32px] p-10 border border-[#F27D26]/20 flex flex-col items-center text-center space-y-6 shadow-2xl"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-[#F27D26]/20 blur-xl rounded-full animate-pulse" />
                <Loader2 className="w-12 h-12 text-[#F27D26] animate-spin relative z-10" />
              </div>
              <div>
                <h2 className="text-2xl font-bold tracking-tight mb-2">Transcribing & Summarizing</h2>
                <p className="text-zinc-400 text-lg">Our AI is processing your meeting notes. This may take a minute...</p>
              </div>
            </motion.div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {isInitialLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-zinc-900/30 border border-zinc-800/50 rounded-[32px] p-6 space-y-4">
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-20 w-full" />
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-1/3 rounded-full" />
                    <Skeleton className="h-8 w-1/3 rounded-full" />
                    <Skeleton className="h-8 w-1/3 rounded-full" />
                  </div>
                </div>
              ))
            ) : filteredMeetings.length === 0 && !isRecording && !isProcessing ? (
              <div className="col-span-full py-32 text-center">
                <div className="w-24 h-24 bg-zinc-900/50 rounded-[40px] flex items-center justify-center mb-6 mx-auto border border-zinc-800/50">
                  <FileText className="text-zinc-700 w-12 h-12" />
                </div>
                <h3 className="text-2xl font-bold text-zinc-400 mb-2">No meetings found</h3>
                <p className="text-zinc-600 text-lg">Start recording your first meeting to see it here.</p>
              </div>
            ) : (
              filteredMeetings.map((meeting, index) => {
                return (
                  <motion.div
                    key={meeting.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="group bg-zinc-900/30 hover:bg-zinc-800/40 border border-zinc-800/50 hover:border-[#F27D26]/30 rounded-[32px] p-6 transition-all cursor-pointer flex flex-col h-full shadow-lg hover:shadow-[#F27D26]/5"
                  >
                    <div onClick={() => setSelectedMeeting(meeting)} className="flex-1">
                      <div className="flex items-start justify-between mb-4">
                        <div className="p-3 bg-zinc-800/50 rounded-2xl group-hover:bg-[#F27D26]/10 transition-colors">
                          <FileText className="w-6 h-6 text-zinc-400 group-hover:text-[#F27D26]" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-widest text-zinc-600 bg-zinc-800/30 px-3 py-1 rounded-full">
                          {meeting.folder}
                        </span>
                      </div>
                      
                      <h3 className="text-xl font-bold mb-3 line-clamp-2 group-hover:text-white transition-colors">
                        {meeting.title}
                      </h3>
                      
                      <p className="text-zinc-500 text-sm line-clamp-3 mb-6 flex-1 leading-relaxed">
                        {meeting.summary}
                      </p>
                      
                      <div className="flex items-center gap-4 text-xs text-zinc-500 font-medium mb-2">
                        <span className="flex items-center gap-1.5">
                          <CalendarIcon className="w-3.5 h-3.5" />
                          {meeting.date ? format(meeting.date.toDate(), 'MMM d, yyyy • h:mm a') : 'Recent'}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          {formatTime(meeting.duration)}
                        </span>
                      </div>
                      {meeting.language && (
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#F27D26] mb-4">
                          Detected: {meeting.language}
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>
        </main>
      </div>

      {/* Meeting Detail Modal */}
      <AnimatePresence>
        {selectedMeeting && (() => {
          const display = selectedMeeting;
          return (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-0 md:p-10 bg-black/80 backdrop-blur-sm"
            >
              <motion.div 
                layoutId={selectedMeeting.id}
                className="bg-[#0a0a0a] w-full max-w-5xl h-full rounded-none md:rounded-[40px] border-none md:border border-zinc-800 overflow-hidden flex flex-col"
              >
                <div className="p-6 md:p-8 border-b border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between md:block gap-4">
                      <h2 className="text-2xl md:text-3xl font-bold mb-2 leading-tight">{display.title}</h2>
                      <button 
                        onClick={() => setSelectedMeeting(null)} 
                        className="md:hidden p-2 bg-zinc-900 rounded-xl flex-shrink-0"
                      >
                        <X className="w-6 h-6" />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 md:gap-4 text-xs md:text-sm text-zinc-500">
                      <span className="flex items-center gap-1">
                        <CalendarIcon className="w-4 h-4" />
                        {selectedMeeting.date ? format(selectedMeeting.date.toDate(), 'MMMM d, yyyy • h:mm a') : 'Recent'}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-4 h-4" />
                        {formatTime(selectedMeeting.duration)}
                      </span>
                      <span className="px-3 py-1 bg-zinc-900 rounded-full text-[#F27D26] font-medium">
                        {selectedMeeting.folder}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap md:flex-nowrap">
                    <button 
                      onClick={() => shareToWhatsApp(selectedMeeting)}
                      title="Share to WhatsApp"
                      className="p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors text-[#25D366]"
                    >
                      <MessageCircle className="w-5 h-5" />
                    </button>
                    <button 
                      onClick={() => downloadSummary(selectedMeeting)}
                      title="Download Summary"
                      className="p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors"
                    >
                      <Download className="w-6 h-6" />
                    </button>
                    <button 
                      onClick={() => setIsPDFModalOpen(true)}
                      title="Export to PDF"
                      className="p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors text-red-400"
                    >
                      <FileDown className="w-6 h-6" />
                    </button>
                    <button 
                      onClick={() => exportToEmail(selectedMeeting)}
                      title="Share via Email"
                      className="p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors"
                    >
                      <Mail className="w-6 h-6" />
                    </button>
                    <button 
                      onClick={() => setIsTranscriptOpen(true)}
                      title="View Transcript"
                      className="p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors flex items-center gap-2"
                    >
                      <FileText className="w-5 h-5 text-[#F27D26]" />
                      <span className="text-xs font-bold uppercase tracking-wider hidden sm:inline">Transcript</span>
                    </button>
                    <button 
                      onClick={() => {
                        setMeetingToDeleteId(selectedMeeting.id);
                        setIsDeleteConfirmOpen(true);
                      }}
                      title="Delete Meeting"
                      className="p-3 bg-zinc-900 rounded-2xl hover:bg-red-500/10 text-red-400 transition-colors"
                    >
                      <Trash2 className="w-6 h-6" />
                    </button>
                    <button 
                      onClick={() => setSelectedMeeting(null)}
                      className="hidden md:block p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors ml-4"
                    >
                      <X className="w-6 h-6" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-10">
                  <div className="lg:col-span-2 space-y-10">
                    <section>
                      <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                        <FileText className="w-6 h-6 text-[#F27D26]" />
                        Executive Summary
                      </h3>
                      <p className="text-zinc-300 leading-relaxed text-lg">
                        {display.summary}
                      </p>
                    </section>

                    <section>
                      <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                        <List className="w-6 h-6 text-[#F27D26]" />
                        Key Discussion Points
                      </h3>
                      <ul className="space-y-3">
                        {display.keyPoints?.map((point: string, i: number) => (
                          <li key={i} className="flex items-start gap-3 text-zinc-400">
                            <div className="w-2 h-2 bg-[#F27D26] rounded-full mt-2" />
                            {point}
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>

                  <div className="space-y-10">
                    <section className="bg-zinc-900/50 rounded-3xl p-6 border border-zinc-800">
                      <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
                        <CheckSquare className="w-6 h-6 text-[#F27D26]" />
                        Action Items
                      </h3>
                      <ul className="space-y-4">
                        {display.actionItems?.map((item: string, i: number) => (
                          <li key={i} className="flex items-center gap-3 p-3 bg-zinc-900 rounded-2xl border border-zinc-800">
                            <div className="w-6 h-6 border-2 border-zinc-700 rounded-lg flex-shrink-0" />
                            <span className="text-sm text-zinc-300">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>

                    <section className="bg-zinc-900/50 rounded-3xl p-6 border border-zinc-800">
                      <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
                        <ChevronRight className="w-6 h-6 text-[#F27D26]" />
                        Next Steps
                      </h3>
                      <ul className="space-y-4">
                        {display.nextSteps?.map((step: string, i: number) => (
                          <li key={i} className="flex items-center gap-3 text-sm text-zinc-400">
                            <Clock className="w-4 h-4 text-zinc-600" />
                            {step}
                          </li>
                        ))}
                      </ul>
                    </section>

                    <button 
                      onClick={() => setIsChatOpen(true)}
                      className="w-full py-4 bg-[#F27D26] text-white font-bold rounded-2xl shadow-lg hover:bg-[#d96a1b] transition-all flex items-center justify-center gap-3"
                    >
                      <MessageSquare className="w-5 h-5" />
                      Ask AI about this meeting
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* AI Chat Drawer */}
      <AnimatePresence>
        {isTranscriptOpen && selectedMeeting && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsTranscriptOpen(false)}
              className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl h-[80vh] bg-[#0a0a0a] border border-zinc-800 rounded-[40px] shadow-2xl z-[70] overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/20">
                <div>
                  <h3 className="text-2xl font-bold flex items-center gap-3">
                    <FileText className="w-7 h-7 text-[#F27D26]" />
                    Full Transcript
                  </h3>
                  <p className="text-xs text-zinc-500 mt-1">
                    Language: {selectedMeeting.language || 'Detected Automatically'}
                  </p>
                </div>
                <button 
                  onClick={() => setIsTranscriptOpen(false)} 
                  className="p-3 bg-zinc-900 rounded-2xl hover:bg-zinc-800 transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-10">
                <div className="prose prose-invert max-w-none">
                  <div className="bg-zinc-900/30 rounded-[32px] p-8 border border-zinc-800/50 shadow-inner">
                    <p className="text-zinc-300 leading-relaxed text-lg whitespace-pre-wrap font-mono">
                      {selectedMeeting.transcript}
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-6 border-t border-zinc-800 bg-zinc-900/20 flex justify-center">
                <button 
                  onClick={() => setIsTranscriptOpen(false)}
                  className="px-8 py-3 bg-zinc-800 hover:bg-zinc-700 text-white font-bold rounded-2xl transition-all"
                >
                  Close Transcript
                </button>
              </div>
            </motion.div>
          </>
        )}

        {isChatOpen && selectedMeeting && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsChatOpen(false)}
              className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#0a0a0a] z-[70] border-l border-zinc-800 flex flex-col shadow-2xl"
            >
              <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-lg">Meeting Assistant</h3>
                  <p className="text-xs text-zinc-500">Chatting about: {selectedMeeting.title}</p>
                </div>
                <button onClick={() => setIsChatOpen(false)} className="p-2 hover:bg-zinc-900 rounded-xl">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
                {chatHistory.length === 0 && (
                  <div className="text-center py-20 text-zinc-500">
                    <div className="w-20 h-20 bg-zinc-900 rounded-[32px] flex items-center justify-center mx-auto mb-6 shadow-xl">
                      <MessageSquare className="w-10 h-10 text-[#F27D26] opacity-50" />
                    </div>
                    <h4 className="text-lg font-bold text-white mb-2">Meeting Assistant</h4>
                    <p className="text-sm max-w-[200px] mx-auto">Ask anything about this meeting in your preferred language.</p>
                  </div>
                )}
                {chatHistory.map((msg, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    className={cn(
                      "flex flex-col gap-1",
                      msg.role === 'user' ? "items-end" : "items-start"
                    )}
                  >
                    <div className={cn(
                      "max-w-[85%] p-4 rounded-[20px] text-sm leading-relaxed shadow-md",
                      msg.role === 'user' 
                        ? "bg-[#F27D26] text-white rounded-tr-none" 
                        : "bg-zinc-800 text-zinc-200 rounded-tl-none border border-zinc-700"
                    )}>
                      {msg.role === 'user' ? (
                        msg.text
                      ) : (
                        <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-li:my-1 prose-ul:my-2">
                          <ReactMarkdown>{msg.text}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 px-2">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">
                        {msg.role === 'user' ? 'You' : 'Assistant'}
                      </span>
                      <span className="text-[10px] text-zinc-600 font-medium">
                        {format(msg.timestamp, 'h:mm a')}
                      </span>
                    </div>
                  </motion.div>
                ))}
                {isChatLoading && (
                  <div className="flex flex-col items-start gap-1">
                    <div className="bg-zinc-800 text-zinc-300 p-4 rounded-[20px] rounded-tl-none text-sm flex items-center gap-3 border border-zinc-700 shadow-md">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-[#F27D26] rounded-full animate-bounce [animation-delay:-0.3s]" />
                        <span className="w-1.5 h-1.5 bg-[#F27D26] rounded-full animate-bounce [animation-delay:-0.15s]" />
                        <span className="w-1.5 h-1.5 bg-[#F27D26] rounded-full animate-bounce" />
                      </div>
                      Thinking...
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <form onSubmit={handleChat} className="p-6 border-t border-zinc-800">
                <div className="relative">
                  <input 
                    type="text" 
                    placeholder="Type your question..."
                    value={chatMessage}
                    onChange={(e) => setChatMessage(e.target.value)}
                    className="w-full bg-zinc-900 border-none rounded-2xl py-4 pl-4 pr-12 text-sm focus:ring-2 focus:ring-[#F27D26]"
                  />
                  <button 
                    type="submit"
                    disabled={!chatMessage.trim() || isChatLoading}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-[#F27D26] text-white rounded-xl disabled:opacity-50"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}

        {/* PDF Options Modal */}
        <AnimatePresence>
          {isPDFModalOpen && selectedMeeting && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-zinc-900 w-full max-w-sm rounded-[32px] border border-zinc-800 overflow-hidden shadow-2xl"
              >
                <div className="p-8 text-center">
                  <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                    <FileDown className="w-10 h-10 text-red-500" />
                  </div>
                  <h3 className="text-2xl font-bold mb-2">Export PDF</h3>
                  <p className="text-zinc-400 text-sm mb-8">Choose how you want to receive your meeting summary PDF.</p>
                  
                  <div className="space-y-3">
                    <button 
                      onClick={() => generatePDF(selectedMeeting, false)}
                      className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 rounded-2xl font-bold transition-all flex items-center justify-center gap-3"
                    >
                      <Download className="w-5 h-5" />
                      Download PDF
                    </button>
                    <button 
                      onClick={() => generatePDF(selectedMeeting, true)}
                      className="w-full py-4 bg-[#25D366] hover:bg-[#20bd5b] text-white rounded-2xl font-bold transition-all flex items-center justify-center gap-3 shadow-lg shadow-[#25D366]/20"
                    >
                      <MessageCircle className="w-5 h-5" />
                      Share on WhatsApp
                    </button>
                    <button 
                      onClick={() => setIsPDFModalOpen(false)}
                      className="w-full py-3 text-zinc-500 hover:text-white transition-colors text-sm font-medium mt-2"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* New Meeting Name Modal */}
        <AnimatePresence>
          {isNewMeetingModalOpen && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-zinc-900 w-full max-w-sm rounded-[32px] border border-zinc-800 overflow-hidden shadow-2xl"
              >
                <div className="p-8">
                  <div className="w-16 h-16 bg-[#F27D26]/10 rounded-full flex items-center justify-center mx-auto mb-6">
                    <Mic className="w-8 h-8 text-[#F27D26]" />
                  </div>
                  <h3 className="text-2xl font-bold text-center mb-2">New Meeting</h3>
                  <p className="text-zinc-400 text-center text-sm mb-8">Give your meeting a name to help you find it later.</p>
                  
                  <div className="space-y-4">
                    <input 
                      type="text"
                      autoFocus
                      placeholder="Meeting Name (Optional)"
                      value={newMeetingName}
                      onChange={(e) => setNewMeetingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setIsNewMeetingModalOpen(false);
                          startRecording(newMeetingName);
                          setNewMeetingName('');
                        }
                      }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-[#F27D26] transition-colors"
                    />
                    
                    <div className="flex gap-3">
                      <button 
                        onClick={() => {
                          setIsNewMeetingModalOpen(false);
                          setNewMeetingName('');
                        }}
                        className="flex-1 py-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl font-bold transition-all"
                      >
                        Cancel
                      </button>
                      <button 
                        onClick={() => {
                          setIsNewMeetingModalOpen(false);
                          startRecording(newMeetingName);
                          setNewMeetingName('');
                        }}
                        className="flex-1 py-4 bg-[#F27D26] hover:bg-[#d96a1d] text-white rounded-2xl font-bold transition-all shadow-lg shadow-[#F27D26]/20"
                      >
                        Start
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation Modal */}
        <AnimatePresence>
          {isDeleteConfirmOpen && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="bg-zinc-900 w-full max-w-sm rounded-[32px] border border-zinc-800 overflow-hidden shadow-2xl"
              >
                <div className="p-8 text-center">
                  <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                    <Trash2 className="w-10 h-10 text-red-500" />
                  </div>
                  <h3 className="text-2xl font-bold mb-2">Delete Meeting?</h3>
                  <p className="text-zinc-400 text-sm mb-8">This action cannot be undone. All summaries and transcripts will be permanently removed.</p>
                  
                  <div className="space-y-3">
                    <button 
                      onClick={() => meetingToDeleteId && deleteMeeting(meetingToDeleteId)}
                      className="w-full py-4 bg-red-500 hover:bg-red-600 text-white rounded-2xl font-bold transition-all flex items-center justify-center gap-3"
                    >
                      Delete Permanently
                    </button>
                    <button 
                      onClick={() => {
                        setIsDeleteConfirmOpen(false);
                        setMeetingToDeleteId(null);
                      }}
                      className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl font-bold transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </AnimatePresence>
    </div>
  );
}
