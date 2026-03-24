/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import { 
  Search, 
  Globe, 
  ChevronRight,
  Loader2,
  Sparkles,
  BookOpen,
  Newspaper,
  Code2,
  Layout,
  Mic,
  MicOff,
  Volume2,
  LogIn,
  LogOut,
  User as UserIcon,
  AlertCircle,
  Image as ImageIcon,
  Plus,
  History,
  MessageSquare,
  Trash2,
  Send,
  Paperclip,
  Zap,
  PenLine,
  Lightbulb,
  Compass
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { 
  auth, 
  db, 
  googleProvider, 
  handleFirestoreError, 
  OperationType 
} from './firebase';
import { 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp, 
  doc, 
  setDoc, 
  getDocFromServer,
  Timestamp
} from 'firebase/firestore';

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// Error Boundary Component
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-[#0a0502]">
          <div className="titan-card p-8 max-w-md w-full text-center space-y-4">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
            <h2 className="text-xl font-bold text-white">Something went wrong</h2>
            <p className="text-white/60 text-sm">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-indigo-500 text-white rounded-xl hover:bg-indigo-400 transition-all"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Audio Helper Functions
// ... (floatTo16BitPCM and base64ToUint8Array remain the same)
const floatTo16BitPCM = (float32Array: Float32Array) => {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
};

const base64ToUint8Array = (base64: string) => {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

interface GroundingChunk {
  web?: {
    uri: string;
    title: string;
  };
}

interface Message {
  role: 'user' | 'titan';
  content: string;
  groundingLinks?: { uri: string; title: string }[];
  type?: 'system' | 'result' | 'image';
  timestamp?: any;
  imageData?: string; // base64
}

interface ChatSession {
  id: string;
  title: string;
  lastTimestamp: any;
}

export default function App() {
  return (
    <ErrorBoundary>
      <TitanApp />
    </ErrorBoundary>
  );
}

function TitanApp() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [liveSession, setLiveSession] = useState<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Test connection to Firestore
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  // Auth State Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);
      setIsAuthReady(true);
      if (user) {
        // Create/Update user profile in Firestore
        const userRef = doc(db, 'users', user.uid);
        try {
          await setDoc(userRef, {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            photoURL: user.photoURL,
            createdAt: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
        }
      } else {
        setMessages([{ 
          role: 'titan', 
          content: 'Hello! I am Titan. Please sign in to save your chat history.',
          type: 'system'
        }]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Chat History Listener (Sessions)
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const sessionsRef = collection(db, 'users', user.uid, 'sessions');
    const q = query(sessionsRef, orderBy('lastTimestamp', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessions: ChatSession[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as ChatSession));
      setChatSessions(sessions);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  // Active Chat Messages Listener
  useEffect(() => {
    if (!user || !isAuthReady || !activeChatId) {
      if (!activeChatId) {
        setMessages([{ 
          role: 'titan', 
          content: user ? `Welcome back, ${user.displayName}! How can I help you today?` : 'Hello! I am Titan. Please sign in to save your chat history.',
          type: 'system'
        }]);
      }
      return;
    }

    const messagesRef = collection(db, 'users', user.uid, 'sessions', activeChatId, 'messages');
    const q = query(messagesRef, orderBy('timestamp', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const history: Message[] = snapshot.docs.map(doc => doc.data() as Message);
      setMessages(history);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/sessions/${activeChatId}/messages`);
    });

    return () => unsubscribe();
  }, [user, isAuthReady, activeChatId]);

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Sign In Error:", error);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setActiveChatId(null);
      setMessages([]);
    } catch (error) {
      console.error("Sign Out Error:", error);
    }
  };

  const toggleLive = async () => {
    if (isLive) {
      if (liveSession) {
        liveSession.close();
      }
      setIsLive(false);
      setLiveSession(null);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (processorRef.current) {
        processorRef.current.disconnect();
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    } else {
      setIsLive(true);
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        }
        
        const session = await ai.live.connect({
          model: "gemini-2.5-flash-native-audio-preview-12-2025",
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: "You are Titan, a helpful AI assistant. Speak naturally and concisely.",
          },
          callbacks: {
            onopen: () => console.log("Live session opened"),
            onmessage: async (message) => {
              if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
                const audioData = base64ToUint8Array(message.serverContent.modelTurn.parts[0].inlineData.data);
                const int16Array = new Int16Array(audioData.buffer);
                audioQueueRef.current.push(int16Array);
                if (!isPlayingRef.current) {
                  playNextInQueue();
                }
              }
            },
            onclose: () => setIsLive(false),
            onerror: (err) => console.error("Live Error:", err),
          }
        });
        
        setLiveSession(session);
        
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const source = audioContextRef.current.createMediaStreamSource(stream);
        const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmData = floatTo16BitPCM(inputData);
          const base64Data = window.btoa(String.fromCharCode(...new Uint8Array(pcmData)));
          session.sendRealtimeInput({
            audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        };

        source.connect(processor);
        processor.connect(audioContextRef.current.destination);
      } catch (error) {
        console.error("Failed to start live session:", error);
        setIsLive(false);
      }
    }
  };

  const playNextInQueue = async () => {
    if (audioQueueRef.current.length === 0 || !audioContextRef.current) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const pcmData = audioQueueRef.current.shift()!;
    const float32Array = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      float32Array[i] = pcmData[i] / 0x8000;
    }

    const buffer = audioContextRef.current.createBuffer(1, float32Array.length, 16000);
    buffer.getChannelData(0).set(float32Array);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => playNextInQueue();
    source.start();
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);
  const createNewChat = () => {
    setActiveChatId(null);
    setMessages([{ 
      role: 'titan', 
      content: 'New conversation started. How can I help?',
      type: 'system'
    }]);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setSelectedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !selectedImage) || isLoading) return;

    const userMessage = input;
    const userImage = selectedImage;
    setInput('');
    setSelectedImage(null);
    
    let currentChatId = activeChatId;
    
    if (user) {
      if (!currentChatId) {
        // Create new session
        const sessionsRef = collection(db, 'users', user.uid, 'sessions');
        const newSession = await addDoc(sessionsRef, {
          title: userMessage.slice(0, 30) || "Image Analysis",
          lastTimestamp: serverTimestamp()
        });
        currentChatId = newSession.id;
        setActiveChatId(currentChatId);
      }

      const messagesRef = collection(db, 'users', user.uid, 'sessions', currentChatId, 'messages');
      try {
        await addDoc(messagesRef, {
          userId: user.uid,
          role: 'user',
          content: userMessage,
          imageData: userImage || null,
          timestamp: serverTimestamp()
        });
        // Update session timestamp
        const sessionRef = doc(db, 'users', user.uid, 'sessions', currentChatId);
        await setDoc(sessionRef, { lastTimestamp: serverTimestamp() }, { merge: true });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/sessions/${currentChatId}/messages`);
      }
    } else {
      setMessages(prev => [...prev, { role: 'user', content: userMessage, imageData: userImage || undefined }]);
    }

    setIsLoading(true);

    try {
      // Check if it's an image generation request
      const isImageGen = userMessage.toLowerCase().startsWith("generate image") || userMessage.toLowerCase().startsWith("draw");
      
      if (isImageGen) {
        setIsGeneratingImage(true);
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: {
            parts: [{ text: userMessage }],
          },
          config: {
            imageConfig: { aspectRatio: "1:1", imageSize: "1K" }
          }
        });

        let generatedImageUrl = "";
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            generatedImageUrl = `data:image/png;base64,${part.inlineData.data}`;
          }
        }

        if (user && currentChatId) {
          const messagesRef = collection(db, 'users', user.uid, 'sessions', currentChatId, 'messages');
          await addDoc(messagesRef, {
            userId: user.uid,
            role: 'titan',
            content: "Here is the image I generated for you:",
            imageData: generatedImageUrl,
            type: 'image',
            timestamp: serverTimestamp()
          });
        } else {
          setMessages(prev => [...prev, { 
            role: 'titan', 
            content: "Here is the image I generated for you:", 
            imageData: generatedImageUrl,
            type: 'image'
          }]);
        }
        setIsGeneratingImage(false);
      } else {
        // Normal text/multimodal request
        const parts: any[] = [{ text: userMessage }];
        if (userImage) {
          const base64Data = userImage.split(',')[1];
          const mimeType = userImage.split(';')[0].split(':')[1];
          parts.push({
            inlineData: {
              data: base64Data,
              mimeType: mimeType
            }
          });
        }

        const responseStream = await ai.models.generateContentStream({
          model: "gemini-3-flash-preview",
          contents: { parts },
          config: {
            systemInstruction: `You are Titan, a helpful and versatile AI assistant, similar to Gemini. 
            Your goal is to provide clear, direct, and pleasant answers as quickly as possible. 
            If the user asks for a list, provide it in clean bullet points. 
            Otherwise, respond in concise, well-structured paragraphs.
            Skip unnecessary filler and introductions to maintain maximum speed.
            Synthesize information from trusted sources into a final answer.`,
            tools: [{ googleSearch: {} }],
          },
        });

        let fullText = "";
        let groundingLinks: { uri: string; title: string }[] = [];
        
        if (!user) {
          setMessages(prev => [...prev, { 
            role: 'titan', 
            content: "",
            type: 'result'
          }]);
        }

        for await (const chunk of responseStream) {
          const chunkText = chunk.text || "";
          fullText += chunkText;
          
          const chunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingChunk[] | undefined;
          if (chunks) {
            const links = chunks
              ?.filter(c => c.web)
              .map(c => ({
                uri: c.web!.uri,
                title: c.web!.title
              })) || [];
            if (links.length > 0) {
              groundingLinks = [...groundingLinks, ...links];
            }
          }

          if (!user) {
            setMessages(prev => {
              const newMessages = [...prev];
              const lastIndex = newMessages.length - 1;
              newMessages[lastIndex] = {
                ...newMessages[lastIndex],
                content: fullText,
                groundingLinks: groundingLinks.length > 0 ? groundingLinks : undefined
              };
              return newMessages;
            });
          }
        }

        if (user && currentChatId) {
          const messagesRef = collection(db, 'users', user.uid, 'sessions', currentChatId, 'messages');
          try {
            await addDoc(messagesRef, {
              userId: user.uid,
              role: 'titan',
              content: fullText,
              timestamp: serverTimestamp(),
              type: 'result',
              groundingLinks: groundingLinks.length > 0 ? groundingLinks : null
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/sessions/${currentChatId}/messages`);
          }
        }
      }

    } catch (error) {
      console.error("Titan Error:", error);
      const errorMessage = "I'm having a bit of trouble. Could you try again?";
      if (user && currentChatId) {
        const messagesRef = collection(db, 'users', user.uid, 'sessions', currentChatId, 'messages');
        try {
          await addDoc(messagesRef, {
            userId: user.uid,
            role: 'titan',
            content: errorMessage,
            timestamp: serverTimestamp(),
            type: 'system'
          });
        } catch (e) {
          handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}/sessions/${currentChatId}/messages`);
        }
      } else {
        setMessages(prev => [...prev, { 
          role: 'titan', 
          content: errorMessage,
          type: 'system'
        }]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const suggestedPrompts = [
    { icon: <PenLine className="w-4 h-4" />, text: "Help me write an email" },
    { icon: <Lightbulb className="w-4 h-4" />, text: "Give me ideas for a weekend trip" },
    { icon: <Zap className="w-4 h-4" />, text: "Summarize the latest AI news" },
    { icon: <ImageIcon className="w-4 h-4" />, text: "Generate image of a futuristic city" },
  ];

  return (
    <div className="min-h-screen flex bg-[#0a0502] text-white overflow-hidden">
      <div className="titan-atmosphere" />
      
      {/* Sidebar */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.aside
            initial={{ x: -300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            className="w-72 bg-white/[0.02] border-r border-white/5 flex flex-col relative z-20"
          >
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <span className="font-bold tracking-tight">Titan</span>
              </div>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="p-2 hover:bg-white/5 rounded-lg text-white/40"
              >
                <Layout className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4">
              <button 
                onClick={createNewChat}
                className="w-full flex items-center gap-3 px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                New Chat
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
              <div className="text-[10px] uppercase tracking-widest text-white/20 font-bold mb-2 px-2">Recent</div>
              {chatSessions.map(session => (
                <button
                  key={session.id}
                  onClick={() => setActiveChatId(session.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all text-left group",
                    activeChatId === session.id ? "bg-indigo-500/10 text-indigo-300" : "hover:bg-white/5 text-white/60"
                  )}
                >
                  <MessageSquare className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate flex-1">{session.title}</span>
                </button>
              ))}
            </div>

            {user && (
              <div className="p-4 border-t border-white/5">
                <div className="flex items-center gap-3 p-2">
                  <img src={user.photoURL || ""} alt="" className="w-8 h-8 rounded-lg" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold truncate">{user.displayName}</div>
                    <div className="text-[10px] text-white/40 truncate">{user.email}</div>
                  </div>
                  <button onClick={handleSignOut} className="p-2 hover:bg-red-500/10 text-white/20 hover:text-red-400 rounded-lg">
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {!isSidebarOpen && (
          <button 
            onClick={() => setIsSidebarOpen(true)}
            className="absolute top-4 left-4 z-30 p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/40"
          >
            <Layout className="w-4 h-4" />
          </button>
        )}

        {/* Header */}
        <header className="h-16 flex items-center justify-between px-6 border-b border-white/5 relative z-10">
          <div className="flex items-center gap-4">
            {!isSidebarOpen && (
              <div className="flex items-center gap-2 ml-10">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <span className="font-bold tracking-tight">Titan</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4">
            {!user && isAuthReady && (
              <button 
                onClick={handleSignIn}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-xl text-white transition-all text-sm font-medium shadow-lg shadow-indigo-500/20"
              >
                <LogIn className="w-4 h-4" />
                Sign In
              </button>
            )}
          </div>
        </header>

        {/* Chat Area */}
        <main className="flex-1 overflow-hidden flex flex-col relative z-10">
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 md:p-8 space-y-12 custom-scrollbar"
          >
            {messages.length <= 1 && (
              <div className="max-w-2xl mx-auto mt-20 space-y-12">
                <div className="space-y-4">
                  <h2 className="text-4xl md:text-5xl font-bold tracking-tight bg-gradient-to-r from-white via-white to-white/20 bg-clip-text text-transparent">
                    Hello, {user?.displayName?.split(' ')[0] || 'there'}.
                  </h2>
                  <p className="text-xl md:text-2xl text-white/40 font-medium">How can I help you today?</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {suggestedPrompts.map((prompt, i) => (
                    <button
                      key={i}
                      onClick={() => setInput(prompt.text)}
                      className="p-6 bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-white/10 rounded-2xl transition-all text-left group flex flex-col gap-4"
                    >
                      <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/40 group-hover:text-indigo-400 transition-colors">
                        {prompt.icon}
                      </div>
                      <span className="text-sm text-white/60 group-hover:text-white transition-colors">{prompt.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="max-w-3xl mx-auto w-full space-y-12">
              <AnimatePresence initial={false}>
                {messages.map((msg, idx) => (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "flex gap-4 md:gap-6",
                      msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center",
                      msg.role === 'user' ? "bg-indigo-500" : "bg-white/5"
                    )}>
                      {msg.role === 'user' ? <UserIcon className="w-4 h-4" /> : <Sparkles className="w-4 h-4 text-indigo-400" />}
                    </div>

                    <div className={cn(
                      "flex-1 space-y-4",
                      msg.role === 'user' ? "text-right" : "text-left"
                    )}>
                      {msg.imageData && (
                        <div className={cn("flex", msg.role === 'user' ? "justify-end" : "justify-start")}>
                          <img src={msg.imageData} alt="Uploaded" className="max-w-sm rounded-2xl border border-white/10 shadow-2xl" />
                        </div>
                      )}
                      
                      <div className={cn(
                        "markdown-body text-[15px] leading-relaxed",
                        msg.role === 'user' ? "text-white/80" : "text-white/90"
                      )}>
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>

                      {msg.groundingLinks && msg.groundingLinks.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-2">
                          {msg.groundingLinks.slice(0, 3).map((link, i) => (
                            <a 
                              key={i} 
                              href={link.uri} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="flex items-center gap-2 text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-full transition-all text-indigo-300"
                            >
                              <Globe className="w-3 h-3" />
                              <span className="truncate max-w-[120px]">{link.title}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {(isLoading || isGeneratingImage) && (
                <div className="flex gap-4 md:gap-6">
                  <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-indigo-400 animate-pulse" />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-white/5 rounded-full w-3/4 animate-pulse" />
                    <div className="h-4 bg-white/5 rounded-full w-1/2 animate-pulse" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Input Area */}
          <div className="p-4 md:p-8">
            <div className="max-w-3xl mx-auto w-full space-y-4">
              {selectedImage && (
                <div className="relative inline-block">
                  <img src={selectedImage} alt="Preview" className="w-20 h-20 object-cover rounded-xl border border-white/10" />
                  <button 
                    onClick={() => setSelectedImage(null)}
                    className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white shadow-lg"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}

              <form onSubmit={handleCommand} className="relative group">
                <div className="absolute inset-0 bg-indigo-500/20 blur-2xl opacity-0 group-focus-within:opacity-100 transition-opacity" />
                <div className="relative bg-white/[0.03] border border-white/10 focus-within:border-indigo-500/50 rounded-[28px] p-2 flex flex-col transition-all">
                  <textarea 
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleCommand(e as any);
                      }
                    }}
                    placeholder="Ask Titan anything..."
                    className="w-full bg-transparent px-4 py-3 text-[16px] focus:outline-none placeholder:text-white/20 resize-none min-h-[60px] max-h-[200px] custom-scrollbar"
                    rows={1}
                  />
                  
                  <div className="flex items-center justify-between px-2 pb-1">
                    <div className="flex items-center gap-1">
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        onChange={handleImageUpload} 
                        accept="image/*" 
                        className="hidden" 
                      />
                      <button 
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="p-2.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-all"
                        title="Upload image"
                      >
                        <ImageIcon className="w-5 h-5" />
                      </button>
                      <button 
                        type="button"
                        onClick={toggleLive}
                        className={cn(
                          "p-2.5 rounded-full transition-all",
                          isLive ? "bg-red-500 text-white" : "hover:bg-white/5 text-white/40 hover:text-white"
                        )}
                        title="Voice mode"
                      >
                        {isLive ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                      </button>
                    </div>

                    <button 
                      type="submit"
                      disabled={isLoading || (!input.trim() && !selectedImage)}
                      className="p-2.5 bg-white text-black hover:bg-white/90 rounded-full transition-all disabled:opacity-20 disabled:bg-white/10 disabled:text-white/20"
                    >
                      <Send className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </form>
              
              <p className="text-[11px] text-center text-white/20">
                Titan can make mistakes. Check important info.
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function StatusCard({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: string, color: string }) {
  return (
    <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 min-w-[100px]">
      <div className={cn("opacity-50", color)}>{icon}</div>
      <div className="flex flex-col">
        <span className="text-[8px] font-mono text-white/30 uppercase tracking-tighter">{label}</span>
        <span className={cn("text-[10px] font-mono font-bold tracking-widest", color)}>{value}</span>
      </div>
    </div>
  );
}
