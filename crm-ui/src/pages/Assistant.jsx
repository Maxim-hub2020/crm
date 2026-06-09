import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, MessageSquareText, Mic, Volume2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { extractApiErrorMessage, getAssistantLiveWebSocketUrl, sendAssistantMessage, sendAssistantVoiceMessage } from "../api";
import { Button } from "../components/ui.jsx";

const STORAGE_KEY = "crm_voice_assistant_history_v4";
const SESSION_STORAGE_KEY = "crm_voice_assistant_active_session_v1";
const MAX_VISIBLE_TURNS = 40;
const MAX_CONTEXT_MESSAGES = 5;
const LIVE_AUDIO_PROCESSOR_SIZE = 1024;
const BASE_SPEECH_THRESHOLD = 0.012;
const SILENCE_MS = 3000;
const MIN_RECORDING_MS = 1200;
const MIN_SPEECH_MS = 220;
const MAX_UTTERANCE_MS = 30000;
const LIVE_ASSISTANT_CONFIG_ENABLED = import.meta.env.VITE_ASSISTANT_LIVE === "1";
const LIVE_ASSISTANT_FORCE_IOS = import.meta.env.VITE_ASSISTANT_LIVE_IOS === "1";
const IOS_DEVICE = isIOSDevice();
const LIVE_ASSISTANT_ENABLED = LIVE_ASSISTANT_CONFIG_ENABLED && (!IOS_DEVICE || LIVE_ASSISTANT_FORCE_IOS);
const LIVE_INPUT_SAMPLE_RATE = 16000;
const LIVE_OUTPUT_SAMPLE_RATE = 24000;
const LIVE_CLIENT_SILENCE_MS = clampNumber(readEnvNumber(import.meta.env.VITE_ASSISTANT_CLIENT_SILENCE_MS, 1600), 900, 2000);
const LIVE_MIN_SPEECH_MS = 220;
const LIVE_MIN_RECORDING_MS = 700;
const LIVE_MAX_UTTERANCE_MS = clampNumber(readEnvNumber(import.meta.env.VITE_ASSISTANT_LIVE_MAX_UTTERANCE_MS, 30000), 8000, 60000);
const LIVE_RESPONSE_WATCHDOG_MS = clampNumber(readEnvNumber(import.meta.env.VITE_ASSISTANT_LIVE_RESPONSE_WATCHDOG_MS, 14000), 6000, 30000);
const LIVE_REFRESH_AFTER_TURN = import.meta.env.VITE_ASSISTANT_LIVE_REFRESH_AFTER_TURN !== "0";
const LIVE_RECONNECT_MAX_ATTEMPTS = 4;
const STABLE_CLIENT_SILENCE_MS = Number(import.meta.env.VITE_ASSISTANT_STABLE_SILENCE_MS || 3000);
const STABLE_MAX_UTTERANCE_MS = clampNumber(readEnvNumber(import.meta.env.VITE_ASSISTANT_STABLE_MAX_UTTERANCE_MS, 30000), 8000, 60000);
const BROWSER_TTS_MAX_MS = Number(import.meta.env.VITE_ASSISTANT_TTS_MAX_MS || 18000);
const ASSISTANT_TEXT_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_ASSISTANT_TEXT_TIMEOUT_MS || 22000);
const RAW_ASSISTANT_PENDING_WATCHDOG_MS = Number(import.meta.env.VITE_ASSISTANT_PENDING_WATCHDOG_MS || 26000);
const ASSISTANT_PENDING_WATCHDOG_MS = IOS_DEVICE ? Math.max(RAW_ASSISTANT_PENDING_WATCHDOG_MS, 60000) : RAW_ASSISTANT_PENDING_WATCHDOG_MS;
const USE_BROWSER_VOICE_OUTPUT = false;

function readEnvNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isIOSDevice() {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function statusText({ sessionActive, recording, pending, speaking }) {
  if (pending) return "Думаю";
  if (speaking) return "Отвечаю";
  if (recording) return "Слушаю";
  if (sessionActive) return "Готов слушать";
  return "";
}

function historyPreview(item) {
  return item.user.length > 120 ? `${item.user.slice(0, 120)}...` : item.user;
}

function Waveform() {
  return (
    <div className="voice-waveform" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function mergeFloat32Chunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });

  return result;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function encodePcm16(samples, inputSampleRate, outputSampleRate = LIVE_INPUT_SAMPLE_RATE) {
  const ratio = inputSampleRate / outputSampleRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const buffer = new ArrayBuffer(length * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < length; index += 1) {
    const sourceIndex = Math.min(samples.length - 1, Math.floor(index * ratio));
    const sample = Math.max(-1, Math.min(1, samples[sourceIndex] || 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

function pcm16ToAudioBuffer(audioContext, arrayBuffer, sampleRate = LIVE_OUTPUT_SAMPLE_RATE) {
  const samples = new Int16Array(arrayBuffer);
  const audioBuffer = audioContext.createBuffer(1, samples.length, sampleRate);
  const channel = audioBuffer.getChannelData(0);

  for (let index = 0; index < samples.length; index += 1) {
    channel[index] = samples[index] / 0x8000;
  }

  return audioBuffer;
}

function base64ToBlob(base64, mimeType) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || "audio/wav" });
}

function readStoredArray(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredArray(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {}
}

function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function shouldUseRecorderFallback() {
  return true;
}

function getAudioContextCtor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function withTimeout(promise, timeoutMs, errorMessage) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      window.clearTimeout(timer);
    }
  });
}

export default function Assistant() {
  const navigate = useNavigate();
  const [history, setHistory] = useState(() => readStoredArray(window.localStorage, STORAGE_KEY));
  const [heardText, setHeardText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [pending, setPending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);

  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const processorRef = useRef(null);
  const gainNodeRef = useRef(null);
  const chunksRef = useRef([]);
  const sampleRateRef = useRef(44100);
  const lastVoiceAtRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const hasSpeechRef = useRef(false);
  const speechMsRef = useRef(0);
  const noiseFloorRef = useRef(0.006);
  const speechPeakRef = useRef(0);
  const stoppingRef = useRef(false);
  const audioElementRef = useRef(null);
  const audioUrlRef = useRef("");
  const outputAudioContextRef = useRef(null);
  const outputAudioSourceRef = useRef(null);
  const speechResumeTimerRef = useRef(null);
  const latestAudioRef = useRef(null);
  const historyRef = useRef(history);
  const activeConversationRef = useRef(readStoredArray(window.sessionStorage, SESSION_STORAGE_KEY));
  const sessionActiveRef = useRef(false);
  const pendingRef = useRef(false);
  const recordingRef = useRef(false);
  const speakingRef = useRef(false);
  const resumeTimerRef = useRef(null);
  const pendingWatchdogTimerRef = useRef(null);
  const requestEpochRef = useRef(0);
  const liveSocketRef = useRef(null);
  const liveStreamRef = useRef(null);
  const liveAudioContextRef = useRef(null);
  const liveSourceNodeRef = useRef(null);
  const liveProcessorRef = useRef(null);
  const liveGainNodeRef = useRef(null);
  const liveNextPlayTimeRef = useRef(0);
  const liveSpeakingTimerRef = useRef(null);
  const livePlaybackSourcesRef = useRef(new Set());
  const liveHeardBufferRef = useRef("");
  const liveReplyBufferRef = useRef("");
  const liveToolReplyFallbackRef = useRef("");
  const liveReconnectTimerRef = useRef(null);
  const liveResponseWatchdogTimerRef = useRef(null);
  const liveRefreshAfterPlaybackRef = useRef(false);
  const liveReconnectAttemptsRef = useRef(0);
  const liveStartedAtRef = useRef(0);
  const liveLastVoiceAtRef = useRef(0);
  const liveLastStrongVoiceAtRef = useRef(0);
  const liveHasSpeechRef = useRef(false);
  const liveSpeechMsRef = useRef(0);
  const liveNoiseFloorRef = useRef(0.006);
  const liveSpeechPeakRef = useRef(0);
  const liveTurnEndedRef = useRef(false);
  const liveActivityOpenRef = useRef(false);
  const recognitionRef = useRef(null);
  const recognitionRestartTimerRef = useRef(null);
  const recognitionSilenceTimerRef = useRef(null);
  const recognitionUtteranceDeadlineTimerRef = useRef(null);
  const recognitionIgnoreEndRef = useRef(false);
  const stableTranscriptRef = useRef("");
  const stableInterimRef = useRef("");
  const stableLastVisibleTextRef = useRef("");

  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      (
        Boolean(getSpeechRecognitionCtor()) ||
        (
          Boolean(window.navigator?.mediaDevices?.getUserMedia) &&
          Boolean(window.AudioContext || window.webkitAudioContext)
        )
      );
    setVoiceSupported(supported);
  }, []);

  useEffect(() => {
    sessionActiveRef.current = sessionActive;
  }, [sessionActive]);

  useEffect(() => {
    pendingRef.current = pending;
    clearPendingWatchdogTimer();

    if (pending) {
      pendingWatchdogTimerRef.current = window.setTimeout(
        recoverStuckPendingState,
        ASSISTANT_PENDING_WATCHDOG_MS
      );
    }

    return clearPendingWatchdogTimer;
  }, [pending]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  useEffect(() => {
    historyRef.current = history;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_VISIBLE_TURNS)));
  }, [history]);

  useEffect(() => {
    return () => {
      clearResumeTimer();
      clearLiveReconnectTimer();
      clearPendingWatchdogTimer();
      stopStableVoiceSession();
      teardownLiveSession();
      teardownRecorder();
      stopPlayback();
    };
  }, []);

  const recentCommands = useMemo(() => history.slice(0, 5), [history]);
  const hasDialogButton = Boolean(history.length || heardText || replyText);
  const currentStatus = statusText({ sessionActive, recording, pending, speaking });

  function clearResumeTimer() {
    if (resumeTimerRef.current) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }

  function clearLiveReconnectTimer() {
    if (liveReconnectTimerRef.current) {
      window.clearTimeout(liveReconnectTimerRef.current);
      liveReconnectTimerRef.current = null;
    }
  }

  function clearLiveResponseWatchdogTimer() {
    if (liveResponseWatchdogTimerRef.current) {
      window.clearTimeout(liveResponseWatchdogTimerRef.current);
      liveResponseWatchdogTimerRef.current = null;
    }
  }

  function clearRecognitionRestartTimer() {
    if (recognitionRestartTimerRef.current) {
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
  }

  function clearRecognitionSilenceTimer() {
    if (recognitionSilenceTimerRef.current) {
      window.clearTimeout(recognitionSilenceTimerRef.current);
      recognitionSilenceTimerRef.current = null;
    }
  }

  function clearRecognitionUtteranceDeadlineTimer() {
    if (recognitionUtteranceDeadlineTimerRef.current) {
      window.clearTimeout(recognitionUtteranceDeadlineTimerRef.current);
      recognitionUtteranceDeadlineTimerRef.current = null;
    }
  }

  function clearPendingWatchdogTimer() {
    if (pendingWatchdogTimerRef.current) {
      window.clearTimeout(pendingWatchdogTimerRef.current);
      pendingWatchdogTimerRef.current = null;
    }
  }

  function recoverStuckPendingState() {
    if (!pendingRef.current) return;

    requestEpochRef.current += 1;
    pendingRef.current = false;
    recordingRef.current = false;
    speakingRef.current = false;
    setPending(false);
    setRecording(false);
    setSpeaking(false);
    setError("AI-помощник завис на обработке команды. Я сбросил ожидание, можно повторить запрос.");

    try {
      window.speechSynthesis?.cancel();
    } catch {}

    if (LIVE_ASSISTANT_ENABLED) {
      scheduleLiveReconnect("Live-сессия AI-помощника зависла на ответе. Переподключаюсь...");
      return;
    }

    if (sessionActiveRef.current) {
      scheduleStableRecognitionRestart(700);
    }
  }

  function finalizeStableRecognition() {
    clearRecognitionSilenceTimer();
    clearRecognitionUtteranceDeadlineTimer();
    if (!sessionActiveRef.current || pendingRef.current || LIVE_ASSISTANT_ENABLED) return;

    const transcript = `${stableTranscriptRef.current} ${stableInterimRef.current}`.trim();
    stableTranscriptRef.current = "";
    stableInterimRef.current = "";
    stableLastVisibleTextRef.current = "";

    if (!transcript) {
      scheduleStableRecognitionRestart(350);
      return;
    }

    recognitionIgnoreEndRef.current = true;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    void submitStableTextCommand(transcript);
  }

  function scheduleStableCommandSubmit(delay = STABLE_CLIENT_SILENCE_MS) {
    clearRecognitionSilenceTimer();
    if (!sessionActiveRef.current || pendingRef.current || LIVE_ASSISTANT_ENABLED) return;
    recognitionSilenceTimerRef.current = window.setTimeout(finalizeStableRecognition, delay);
  }

  function scheduleStableUtteranceDeadline() {
    if (recognitionUtteranceDeadlineTimerRef.current) return;
    if (!sessionActiveRef.current || pendingRef.current || LIVE_ASSISTANT_ENABLED) return;
    recognitionUtteranceDeadlineTimerRef.current = window.setTimeout(finalizeStableRecognition, STABLE_MAX_UTTERANCE_MS);
  }

  function stopStableVoiceSession() {
    clearRecognitionRestartTimer();
    clearRecognitionSilenceTimer();
    clearRecognitionUtteranceDeadlineTimer();
    recognitionIgnoreEndRef.current = true;
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    recognitionRef.current = null;
    stableTranscriptRef.current = "";
    stableInterimRef.current = "";
    stableLastVisibleTextRef.current = "";
  }

  function teardownRecorder() {
    try {
      processorRef.current?.disconnect();
    } catch {}
    try {
      sourceNodeRef.current?.disconnect();
    } catch {}
    try {
      gainNodeRef.current?.disconnect();
    } catch {}

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close();
    }

    streamRef.current = null;
    audioContextRef.current = null;
    sourceNodeRef.current = null;
    processorRef.current = null;
    gainNodeRef.current = null;
    stoppingRef.current = false;
  }

  function stopLivePlayback() {
    livePlaybackSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {}
    });
    livePlaybackSourcesRef.current.clear();

    if (liveSpeakingTimerRef.current) {
      window.clearTimeout(liveSpeakingTimerRef.current);
      liveSpeakingTimerRef.current = null;
    }

    liveNextPlayTimeRef.current = 0;
    setSpeaking(false);
    speakingRef.current = false;
  }

  function resetLiveTurnDetection() {
    const now = Date.now();
    liveHasSpeechRef.current = false;
    liveSpeechMsRef.current = 0;
    liveSpeechPeakRef.current = 0;
    liveTurnEndedRef.current = false;
    liveActivityOpenRef.current = false;
    liveStartedAtRef.current = now;
    liveLastVoiceAtRef.current = now;
    liveLastStrongVoiceAtRef.current = now;
  }

  function sendLiveJson(socket, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      scheduleLiveReconnect("Live-соединение AI-помощника оборвалось. Переподключаюсь...");
      return false;
    }
  }

  function scheduleLiveResponseWatchdog() {
    clearLiveResponseWatchdogTimer();
    if (!sessionActiveRef.current || !LIVE_ASSISTANT_ENABLED) return;

    liveResponseWatchdogTimerRef.current = window.setTimeout(() => {
      if (!sessionActiveRef.current || !pendingRef.current) return;
      scheduleLiveReconnect("AI-помощник не получил ответ от Live API. Переподключаюсь...");
    }, LIVE_RESPONSE_WATCHDOG_MS);
  }

  function sendLiveActivityEnd(socket) {
    if (!liveActivityOpenRef.current) return false;
    if (!sendLiveJson(socket, { type: "activity_end" })) return false;

    liveActivityOpenRef.current = false;
    liveTurnEndedRef.current = true;
    pendingRef.current = true;
    setPending(true);
    scheduleLiveResponseWatchdog();
    return true;
  }

  function scheduleLiveSessionRefresh(delay = 250) {
    if (!LIVE_REFRESH_AFTER_TURN || !sessionActiveRef.current) return;

    clearLiveReconnectTimer();
    clearLiveResponseWatchdogTimer();
    liveRefreshAfterPlaybackRef.current = false;
    teardownLiveSession();

    if (!sessionActiveRef.current) return;

    pendingRef.current = false;
    recordingRef.current = true;
    speakingRef.current = false;
    setPending(false);
    setRecording(true);
    setSpeaking(false);
    setError("");

    liveReconnectTimerRef.current = window.setTimeout(async () => {
      if (!sessionActiveRef.current) return;
      await startLiveSession({ reconnecting: true, silent: true });
    }, delay);
  }

  function teardownLiveSession() {
    clearLiveReconnectTimer();
    clearLiveResponseWatchdogTimer();
    liveRefreshAfterPlaybackRef.current = false;

    try {
      liveProcessorRef.current?.disconnect();
    } catch {}
    try {
      liveSourceNodeRef.current?.disconnect();
    } catch {}
    try {
      liveGainNodeRef.current?.disconnect();
    } catch {}

    if (liveStreamRef.current) {
      liveStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    if (liveSocketRef.current) {
      liveSocketRef.current.onopen = null;
      liveSocketRef.current.onmessage = null;
      liveSocketRef.current.onerror = null;
      liveSocketRef.current.onclose = null;
      if (liveSocketRef.current.readyState === WebSocket.OPEN || liveSocketRef.current.readyState === WebSocket.CONNECTING) {
        liveSocketRef.current.close();
      }
    }

    stopLivePlayback();

    if (liveAudioContextRef.current && liveAudioContextRef.current.state !== "closed") {
      void liveAudioContextRef.current.close();
    }

    liveSocketRef.current = null;
    liveStreamRef.current = null;
    liveAudioContextRef.current = null;
    liveSourceNodeRef.current = null;
    liveProcessorRef.current = null;
    liveGainNodeRef.current = null;
    liveHeardBufferRef.current = "";
    liveReplyBufferRef.current = "";
    liveToolReplyFallbackRef.current = "";
    liveNoiseFloorRef.current = 0.006;
    resetLiveTurnDetection();
  }

  function scheduleLiveReconnect(reason = "", { silent = false } = {}) {
    if (!sessionActiveRef.current) return;

    clearLiveResponseWatchdogTimer();

    if (liveReconnectAttemptsRef.current >= LIVE_RECONNECT_MAX_ATTEMPTS) {
      setError("Live-сессия Gemini несколько раз оборвалась. Нажмите на значок ассистента и запустите режим заново.");
      deactivateSession();
      return;
    }

    clearLiveReconnectTimer();
    liveReconnectAttemptsRef.current += 1;
    const delay = Math.min(3000, 600 * liveReconnectAttemptsRef.current);
    teardownLiveSession();

    pendingRef.current = !silent;
    recordingRef.current = Boolean(silent);
    speakingRef.current = false;
    setPending(!silent);
    setRecording(Boolean(silent));
    setSpeaking(false);
    stopLivePlayback();
    setError(reason || "Live-соединение Gemini оборвалось. Переподключаюсь...");

    liveReconnectTimerRef.current = window.setTimeout(async () => {
      if (!sessionActiveRef.current) return;
      await startLiveSession({ reconnecting: true });
    }, delay);
  }

  function appendLiveText(bufferRef, text) {
    const cleanText = String(text || "");
    if (!cleanText) return bufferRef.current;
    if (bufferRef.current.endsWith(cleanText)) return bufferRef.current;
    bufferRef.current = `${bufferRef.current}${cleanText}`.trimStart();
    return bufferRef.current;
  }

  function finalizeLiveTurn() {
    const userText = liveHeardBufferRef.current.trim();
    const assistantText = liveReplyBufferRef.current.trim() || liveToolReplyFallbackRef.current.trim();

    if (userText || assistantText) {
      const nextContext = [
        ...activeConversationRef.current,
        ...(userText ? [{ role: "user", content: userText }] : []),
        ...(assistantText ? [{ role: "assistant", content: assistantText }] : []),
      ].slice(-MAX_CONTEXT_MESSAGES);

      activeConversationRef.current = nextContext;
      writeStoredArray(window.sessionStorage, SESSION_STORAGE_KEY, nextContext);

      if (userText || assistantText) {
        const nextHistory = [
          { user: userText || "Голосовая команда", assistant: assistantText || "Ответ без текстовой расшифровки", intent: "live" },
          ...historyRef.current,
        ].slice(0, MAX_VISIBLE_TURNS);
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      }
    }

    liveHeardBufferRef.current = "";
    liveReplyBufferRef.current = "";
    liveToolReplyFallbackRef.current = "";
    resetLiveTurnDetection();
  }

  function playLivePcmChunk(arrayBuffer) {
    const audioContext = liveAudioContextRef.current;
    if (!audioContext || audioContext.state === "closed" || !arrayBuffer?.byteLength) return;

    if (liveActivityOpenRef.current && liveSocketRef.current?.readyState === WebSocket.OPEN) {
      sendLiveJson(liveSocketRef.current, { type: "activity_end" });
      liveActivityOpenRef.current = false;
      liveTurnEndedRef.current = true;
    }

    clearLiveResponseWatchdogTimer();
    pendingRef.current = false;
    setPending(false);

    const audioBuffer = pcm16ToAudioBuffer(audioContext, arrayBuffer);
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    const startAt = Math.max(audioContext.currentTime + 0.02, liveNextPlayTimeRef.current || 0);
    liveNextPlayTimeRef.current = startAt + audioBuffer.duration;
    livePlaybackSourcesRef.current.add(source);

    source.onended = () => {
      livePlaybackSourcesRef.current.delete(source);
    };
    source.start(startAt);

    speakingRef.current = true;
    setSpeaking(true);

    if (liveSpeakingTimerRef.current) {
      window.clearTimeout(liveSpeakingTimerRef.current);
    }

    const resetDelay = Math.max(120, (liveNextPlayTimeRef.current - audioContext.currentTime) * 1000 + 120);
    liveSpeakingTimerRef.current = window.setTimeout(() => {
      if (!livePlaybackSourcesRef.current.size) {
        speakingRef.current = false;
        setSpeaking(false);
        resetLiveTurnDetection();
        if (liveRefreshAfterPlaybackRef.current) {
          scheduleLiveSessionRefresh();
        }
      }
    }, resetDelay);
  }

  function handleLiveEvent(event) {
    if (event.type === "ready" || event.type === "live_connected") {
      if (event.type === "live_connected") {
        liveReconnectAttemptsRef.current = 0;
        setError("");
      }
      pendingRef.current = false;
      recordingRef.current = true;
      setPending(false);
      setRecording(true);
      return;
    }

    if (event.type === "input_transcript") {
      const text = appendLiveText(liveHeardBufferRef, event.text);
      setHeardText(text);
      return;
    }

    if (event.type === "output_text") {
      liveToolReplyFallbackRef.current = "";
      const text = appendLiveText(liveReplyBufferRef, event.text);
      setReplyText(text);
      return;
    }

    if (event.type === "tool_call" && event.reply) {
      liveToolReplyFallbackRef.current = event.reply;
      pendingRef.current = true;
      setPending(true);
      setReplyText(event.reply);
      scheduleLiveResponseWatchdog();
      return;
    }

    if (event.type === "interrupted") {
      stopLivePlayback();
      return;
    }

    if (event.type === "turn_complete") {
      clearLiveResponseWatchdogTimer();
      pendingRef.current = false;
      setPending(false);
      finalizeLiveTurn();
      if (LIVE_REFRESH_AFTER_TURN) {
        liveRefreshAfterPlaybackRef.current = true;
        window.setTimeout(() => {
          if (
            liveRefreshAfterPlaybackRef.current &&
            sessionActiveRef.current &&
            !speakingRef.current &&
            !livePlaybackSourcesRef.current.size
          ) {
            scheduleLiveSessionRefresh();
          }
        }, 900);
      }
      return;
    }

    if (event.type === "error") {
      clearLiveResponseWatchdogTimer();
      if (event.retryable) {
        scheduleLiveReconnect("Live-соединение Gemini временно оборвалось. Переподключаюсь...");
        return;
      }
      setError(event.detail || "Gemini Live API вернул ошибку.");
      deactivateSession();
    }
  }

  function stopPlayback() {
    stopOutputAudioSource();

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = "";
      audioElementRef.current = null;
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = "";
    }

    setSpeaking(false);
    speakingRef.current = false;
  }

  function deactivateSession() {
    requestEpochRef.current += 1;
    sessionActiveRef.current = false;
    setSessionActive(false);
    pendingRef.current = false;
    recordingRef.current = false;
    speakingRef.current = false;
    setPending(false);
    setRecording(false);
    setSpeaking(false);
    clearResumeTimer();
    clearPendingWatchdogTimer();
    clearSpeechResumeTimer();
    stopStableVoiceSession();
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    teardownLiveSession();
    teardownRecorder();
    stopPlayback();
  }

  function scheduleAutoResume(delay = 480) {
    clearResumeTimer();
    if (!sessionActiveRef.current) return;

    resumeTimerRef.current = window.setTimeout(() => {
      if (!sessionActiveRef.current || recordingRef.current || pendingRef.current || speakingRef.current) return;
      void startRecording();
    }, delay);
  }

  function clearSpeechResumeTimer() {
    if (speechResumeTimerRef.current) {
      window.clearInterval(speechResumeTimerRef.current);
      speechResumeTimerRef.current = null;
    }
  }

  function getRussianSpeechVoice() {
    try {
      const voices = window.speechSynthesis?.getVoices?.() || [];
      return (
        voices.find((voice) => normalizeText(voice.lang).startsWith("ru")) ||
        voices.find((voice) => normalizeText(voice.name).includes("russian")) ||
        voices.find((voice) => normalizeText(voice.name).includes("milena")) ||
        null
      );
    } catch {
      return null;
    }
  }

  function unlockSpeechSynthesis() {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance("а");
      utterance.lang = "ru-RU";
      utterance.volume = 0;
      utterance.rate = 1;
      utterance.pitch = 1;
      const voice = getRussianSpeechVoice();
      if (voice) {
        utterance.voice = voice;
      }
      window.speechSynthesis.speak(utterance);
      window.setTimeout(() => {
        try {
          window.speechSynthesis.resume();
        } catch {}
      }, 80);
    } catch {}
  }

  function stopOutputAudioSource() {
    if (outputAudioSourceRef.current) {
      const source = outputAudioSourceRef.current;
      outputAudioSourceRef.current = null;
      try {
        source.onended = null;
      } catch {}
      try {
        source.stop();
      } catch {}
      try {
        source.disconnect();
      } catch {}
    }
  }

  function unlockAudioOutput() {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) return null;

    let context = outputAudioContextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContextCtor();
      outputAudioContextRef.current = context;
    }

    try {
      if (context.state === "suspended") {
        void context.resume();
      }

      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start(0);
    } catch {}

    return context;
  }

  async function playWithOutputAudioContext(blob, { autoResume, epoch }) {
    const context = unlockAudioOutput();
    if (!context) return false;

    try {
      if (context.state === "suspended") {
        await context.resume();
      }

      const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());

      return await new Promise((resolve) => {
        stopOutputAudioSource();

        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(context.destination);
        outputAudioSourceRef.current = source;

        let finished = false;
        const finish = (playbackOk = true) => {
          if (finished) return;
          finished = true;
          if (outputAudioSourceRef.current === source) {
            outputAudioSourceRef.current = null;
          }
          try {
            source.disconnect();
          } catch {}
          speakingRef.current = false;
          setSpeaking(false);
          if (autoResume && sessionActiveRef.current && epoch === requestEpochRef.current) {
            scheduleAutoResume();
          }
          resolve(playbackOk);
        };

        speakingRef.current = true;
        setSpeaking(true);
        source.onended = finish;

        try {
          source.start(0);
        } catch {
          finish(false);
        }
      });
    } catch {
      stopOutputAudioSource();
      speakingRef.current = false;
      setSpeaking(false);
      return false;
    }
  }

  async function playGeminiAudio(audioBase64, mimeType, { autoResume = false, epoch = requestEpochRef.current } = {}) {
    if (!audioBase64) return;

    stopPlayback();

    const blob = base64ToBlob(audioBase64, mimeType);
    const playedWithOutputContext = await playWithOutputAudioContext(blob, { autoResume, epoch });
    if (playedWithOutputContext) return;

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.playsInline = true;

    audioElementRef.current = audio;
    audioUrlRef.current = url;
    speakingRef.current = true;
    setSpeaking(true);

    return new Promise((resolve) => {
      audio.onended = () => {
        stopPlayback();
        if (autoResume && sessionActiveRef.current && epoch === requestEpochRef.current) {
          scheduleAutoResume();
        }
        resolve();
      };

      audio.onerror = () => {
        stopPlayback();
        setError("Не удалось воспроизвести аудиоответ Gemini.");
        if (autoResume && sessionActiveRef.current && epoch === requestEpochRef.current) {
          scheduleAutoResume();
        }
        resolve();
      };

      audio
        .play()
        .catch(() => {
          stopPlayback();
          setError("Браузер не дал автоматически воспроизвести аудиоответ.");
          if (autoResume && sessionActiveRef.current && epoch === requestEpochRef.current) {
            scheduleAutoResume();
          }
          resolve();
        });
    });
  }

  function speakBrowserReply(text) {
    const cleanText = String(text || "").trim();
    if (!cleanText || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      return Promise.resolve();
    }

    try {
      window.speechSynthesis.cancel();
    } catch {}

    speakingRef.current = true;
    setSpeaking(true);

    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = "ru-RU";
      utterance.rate = 1;
      utterance.pitch = 1;
      const voice = getRussianSpeechVoice();
      if (voice) {
        utterance.voice = voice;
      }
      let resolved = false;
      let watchdogTimer = null;

      const finishSpeaking = () => {
        if (resolved) return;
        resolved = true;
        clearSpeechResumeTimer();
        if (watchdogTimer) {
          window.clearTimeout(watchdogTimer);
        }
        speakingRef.current = false;
        setSpeaking(false);
        resolve();
      };
      utterance.onend = finishSpeaking;
      utterance.onerror = finishSpeaking;
      clearSpeechResumeTimer();
      speechResumeTimerRef.current = window.setInterval(() => {
        try {
          window.speechSynthesis.resume();
        } catch {}
      }, 900);
      watchdogTimer = window.setTimeout(() => {
        try {
          window.speechSynthesis.cancel();
        } catch {}
        finishSpeaking();
      }, BROWSER_TTS_MAX_MS);

      window.speechSynthesis.speak(utterance);
      try {
        window.speechSynthesis.resume();
      } catch {}
    });
  }

  function scheduleStableRecognitionRestart(delay = 450) {
    clearRecognitionRestartTimer();
    clearRecognitionSilenceTimer();
    if (!sessionActiveRef.current || LIVE_ASSISTANT_ENABLED) return;

    recognitionRestartTimerRef.current = window.setTimeout(() => {
      if (!sessionActiveRef.current || pendingRef.current || speakingRef.current || LIVE_ASSISTANT_ENABLED) return;
      startStableVoiceRecognition();
    }, delay);
  }

  async function submitStableTextCommand(text) {
    const transcript = String(text || "").trim();
    if (!transcript || pendingRef.current) {
      scheduleStableRecognitionRestart();
      return;
    }

    pendingRef.current = true;
    recordingRef.current = false;
    setPending(true);
    setRecording(false);
    setError("");
    setHeardText(transcript);

    const epoch = requestEpochRef.current;
    const conversationHistory = activeConversationRef.current.slice(-MAX_CONTEXT_MESSAGES);

    try {
      const response = await withTimeout(
        sendAssistantMessage({
          message: transcript,
          history: conversationHistory,
        }),
        ASSISTANT_TEXT_REQUEST_TIMEOUT_MS,
        "AI-помощник слишком долго думает. Я сбросил зависший запрос, повторите команду."
      );

      if (epoch !== requestEpochRef.current) {
        return;
      }

      const nextReply = response.reply || "Gemini не вернул текст ответа.";
      setReplyText(nextReply);

      const nextContext = [
        ...activeConversationRef.current,
        { role: "user", content: transcript },
        { role: "assistant", content: nextReply },
      ].slice(-MAX_CONTEXT_MESSAGES);
      activeConversationRef.current = nextContext;
      writeStoredArray(window.sessionStorage, SESSION_STORAGE_KEY, nextContext);

      const nextHistory = [
        { user: transcript, assistant: nextReply, intent: response.intent || "conversation" },
        ...historyRef.current,
      ].slice(0, MAX_VISIBLE_TURNS);
      historyRef.current = nextHistory;
      setHistory(nextHistory);

      latestAudioRef.current = null;
      pendingRef.current = false;
      setPending(false);

      await speakBrowserReply(nextReply);
      if (epoch !== requestEpochRef.current) {
        return;
      }
      scheduleStableRecognitionRestart();
    } catch (requestError) {
      if (epoch !== requestEpochRef.current) {
        return;
      }

      pendingRef.current = false;
      setPending(false);
      setReplyText("");
      setError(
        extractApiErrorMessage(
          requestError,
          "Не удалось получить ответ Gemini. Проверьте backend и настройки модели."
        )
      );
      scheduleStableRecognitionRestart(900);
    }
  }

  function startStableVoiceRecognition() {
    if (IOS_DEVICE) {
      return false;
    }

    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      setError("В этом браузере нет встроенного распознавания речи. Включите VITE_ASSISTANT_LIVE=1 или используйте Chrome/Яндекс Браузер.");
      return false;
    }

    stopStableVoiceSession();
    recognitionIgnoreEndRef.current = false;
    stableTranscriptRef.current = "";
    stableInterimRef.current = "";
    stableLastVisibleTextRef.current = "";

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = "ru-RU";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interimText = "";
      let finalText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript || "";
        if (result.isFinal) {
          finalText += text;
        } else {
          interimText += text;
        }
      }

      if (finalText.trim()) {
        stableTranscriptRef.current = `${stableTranscriptRef.current} ${finalText}`.trim();
        stableInterimRef.current = "";
      } else {
        stableInterimRef.current = interimText.trim();
      }

      const visibleText = `${stableTranscriptRef.current} ${stableInterimRef.current}`.trim();
      if (visibleText) {
        setHeardText(visibleText);
        if (visibleText !== stableLastVisibleTextRef.current) {
          stableLastVisibleTextRef.current = visibleText;
          scheduleStableCommandSubmit();
          scheduleStableUtteranceDeadline();
        }
      }
    };

    recognition.onerror = (event) => {
      if (!sessionActiveRef.current) return;
      if (event.error === "no-speech" || event.error === "aborted") {
        scheduleStableRecognitionRestart(350);
        return;
      }
      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error)) {
        setError("Браузер не дал доступ к микрофону или распознаванию речи. Разрешите доступ и запустите помощника заново.");
        deactivateSession();
        return;
      }
      setError(`Ошибка распознавания речи: ${event.error || "неизвестная ошибка"}.`);
      scheduleStableRecognitionRestart(900);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      recordingRef.current = false;
      setRecording(false);

      if (recognitionIgnoreEndRef.current) {
        recognitionIgnoreEndRef.current = false;
        return;
      }

      if (`${stableTranscriptRef.current} ${stableInterimRef.current}`.trim()) {
        scheduleStableCommandSubmit(250);
        return;
      }

      scheduleStableRecognitionRestart(350);
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      recordingRef.current = true;
      setRecording(true);
      return true;
    } catch {
      setError("Не удалось запустить распознавание речи. Попробуйте обновить страницу.");
      return false;
    }
  }

  async function startLiveSession({ reconnecting = false, silent = false } = {}) {
    if (!voiceSupported) {
      setError("В этом браузере недоступна запись микрофона.");
      return false;
    }

    teardownLiveSession();
    stopPlayback();
    clearResumeTimer();
    setError(reconnecting && !silent ? "Переподключаю Live-сессию Gemini..." : "");
    if (!reconnecting) {
      setHeardText("");
      setReplyText("");
      latestAudioRef.current = null;
    }
    liveHeardBufferRef.current = "";
    liveReplyBufferRef.current = "";
    liveToolReplyFallbackRef.current = "";
    liveNoiseFloorRef.current = 0.006;
    resetLiveTurnDetection();

    pendingRef.current = true;
    recordingRef.current = false;
    speakingRef.current = false;
    setPending(true);
    setRecording(false);
    setSpeaking(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(LIVE_AUDIO_PROCESSOR_SIZE, 1, 1);
      const gainNode = audioContext.createGain();
      const socket = new WebSocket(
        getAssistantLiveWebSocketUrl({
          screen: localStorage.getItem("crm_last_screen") || "/",
          history: activeConversationRef.current.slice(-MAX_CONTEXT_MESSAGES),
        })
      );
      let recoverHandled = false;

      const recoverLiveConnection = (message) => {
        if (recoverHandled || !sessionActiveRef.current) return;
        recoverHandled = true;
        scheduleLiveReconnect(message);
      };

      socket.binaryType = "arraybuffer";
      gainNode.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN || !sessionActiveRef.current) return;
        if (pendingRef.current || speakingRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const now = Date.now();
        const chunkDurationMs = event.inputBuffer.duration * 1000;

        let sumSquares = 0;
        for (let index = 0; index < input.length; index += 1) {
          sumSquares += input[index] * input[index];
        }

        const rms = Math.sqrt(sumSquares / input.length);
        const noiseFloor = liveNoiseFloorRef.current;
        const speechThreshold = Math.max(BASE_SPEECH_THRESHOLD, noiseFloor * 2.4);
        const previousPeak = liveSpeechPeakRef.current;
        const continuationThreshold = Math.max(
          noiseFloor * 1.8,
          Math.min(speechThreshold, Math.max(BASE_SPEECH_THRESHOLD * 0.65, previousPeak ? previousPeak * 0.22 : speechThreshold))
        );
        const hadSpeech = liveHasSpeechRef.current;
        const isSpeech = rms >= speechThreshold;
        const isContinuation = hadSpeech && rms >= continuationThreshold;

        if (!hadSpeech || rms < speechThreshold * 0.7) {
          liveNoiseFloorRef.current = noiseFloor * 0.94 + rms * 0.06;
        }

        try {
          if (isSpeech || isContinuation) {
            if (liveTurnEndedRef.current) {
              resetLiveTurnDetection();
            }

            if (!liveActivityOpenRef.current) {
              if (!sendLiveJson(socket, { type: "activity_start" })) return;
              liveActivityOpenRef.current = true;
              liveStartedAtRef.current = now;
              liveLastVoiceAtRef.current = now;
            }

            liveHasSpeechRef.current = true;
            liveSpeechMsRef.current += chunkDurationMs;

            if (isSpeech) {
              liveLastVoiceAtRef.current = now;
              liveLastStrongVoiceAtRef.current = now;
              liveSpeechPeakRef.current = Math.max(previousPeak * 0.995, rms);
            }
          }

          if (liveActivityOpenRef.current) {
            const pcm = encodePcm16(input, audioContext.sampleRate, LIVE_INPUT_SAMPLE_RATE);
            socket.send(pcm);
          }

          const silenceReached =
            liveHasSpeechRef.current &&
            liveSpeechMsRef.current >= LIVE_MIN_SPEECH_MS &&
            now - liveStartedAtRef.current >= LIVE_MIN_RECORDING_MS &&
            now - liveLastStrongVoiceAtRef.current >= LIVE_CLIENT_SILENCE_MS;
          const maxUtteranceReached =
            liveActivityOpenRef.current && now - liveStartedAtRef.current >= LIVE_MAX_UTTERANCE_MS;

          if (!liveTurnEndedRef.current && (silenceReached || maxUtteranceReached)) {
            sendLiveActivityEnd(socket);
          }
        } catch {
          recoverLiveConnection("Live-соединение AI-помощника оборвалось. Переподключаюсь...");
        }
      };

      socket.onopen = () => {
        pendingRef.current = false;
        recordingRef.current = true;
        setPending(false);
        setRecording(true);
      };

      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          playLivePcmChunk(event.data);
          return;
        }

        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then(playLivePcmChunk);
          return;
        }

        try {
          handleLiveEvent(JSON.parse(event.data));
        } catch {
          // Ignore malformed service messages; audio streaming can continue.
        }
      };

      socket.onerror = () => {
        recoverLiveConnection("Live-соединение Gemini оборвалось. Переподключаюсь...");
      };

      socket.onclose = (event) => {
        if (!sessionActiveRef.current) return;
        if (event.code === 4401 || event.code === 4403) {
          const reason =
            event.code === 4401
              ? "Сессия AI-помощника не авторизована. Войдите в CRM заново."
              : "Для AI-помощника нужна активная подписка.";
          setError(reason);
          deactivateSession();
          return;
        }
        recoverLiveConnection("Live-соединение Gemini закрыто. Переподключаюсь...");
      };

      source.connect(processor);
      processor.connect(gainNode);
      gainNode.connect(audioContext.destination);

      liveStreamRef.current = stream;
      liveAudioContextRef.current = audioContext;
      liveSourceNodeRef.current = source;
      liveProcessorRef.current = processor;
      liveGainNodeRef.current = gainNode;
      liveSocketRef.current = socket;
      return true;
    } catch {
      teardownLiveSession();
      pendingRef.current = false;
      setPending(false);
      setError("Браузер не дал доступ к микрофону или не удалось открыть Live-сессию.");
      return false;
    }
  }

  async function submitVoiceCommand(audioBlob) {
    if (!audioBlob || pendingRef.current) return;

    const epoch = requestEpochRef.current;

    pendingRef.current = true;
    setPending(true);
    setError("");
    clearResumeTimer();

    const conversationHistory = activeConversationRef.current.slice(-MAX_CONTEXT_MESSAGES);

    try {
      const response = await sendAssistantVoiceMessage({
        audioBlob,
        history: conversationHistory,
        includeAudio: !USE_BROWSER_VOICE_OUTPUT,
      });

      if (epoch !== requestEpochRef.current) {
        return;
      }

      const transcript = (response.transcript || "").trim();
      const nextReply = response.reply || "Gemini не вернул текст ответа.";

      setHeardText(transcript);
      setReplyText(nextReply);

      const nextContext = [
        ...activeConversationRef.current,
        { role: "user", content: transcript },
        { role: "assistant", content: nextReply },
      ].slice(-MAX_CONTEXT_MESSAGES);
      activeConversationRef.current = nextContext;
      writeStoredArray(window.sessionStorage, SESSION_STORAGE_KEY, nextContext);

      const nextHistory = [{ user: transcript, assistant: nextReply, intent: response.intent }, ...historyRef.current].slice(0, MAX_VISIBLE_TURNS);
      historyRef.current = nextHistory;
      setHistory(nextHistory);

      latestAudioRef.current = {
        audioBase64: response.audio_base64 || "",
        audioMimeType: response.audio_mime_type || "audio/wav",
      };

      pendingRef.current = false;
      setPending(false);

      if (response.audio_base64) {
        void playGeminiAudio(response.audio_base64, response.audio_mime_type, {
          autoResume: sessionActiveRef.current,
          epoch,
        });
      } else {
        if (sessionActiveRef.current) {
          scheduleAutoResume();
        }
      }
    } catch (requestError) {
      if (epoch !== requestEpochRef.current) {
        return;
      }

      pendingRef.current = false;
      setPending(false);
      setReplyText("");
      setError(
        extractApiErrorMessage(
          requestError,
          "Не удалось получить голосовой ответ Gemini. Проверьте backend и настройки модели."
        )
      );
      deactivateSession();
    }
  }

  async function stopRecordingAndSubmit() {
    if (!recordingRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    recordingRef.current = false;
    setRecording(false);

    const samples = mergeFloat32Chunks(chunksRef.current);
    const sampleRate = sampleRateRef.current;

    teardownRecorder();

    if (!hasSpeechRef.current || speechMsRef.current < MIN_SPEECH_MS || !samples.length) {
      setError("Не удалось распознать голос. Скажите команду чуть громче и попробуйте ещё раз.");
      if (sessionActiveRef.current) {
        scheduleAutoResume(700);
      }
      return;
    }

    const audioBlob = encodeWav(samples, sampleRate);
    await submitVoiceCommand(audioBlob);
  }

  async function startRecording() {
    if (!voiceSupported) {
      setError("В этом браузере недоступна запись микрофона.");
      return false;
    }

    if (!sessionActiveRef.current || recordingRef.current || pendingRef.current || speakingRef.current) {
      return false;
    }

    clearResumeTimer();
    setError("");
    chunksRef.current = [];
    hasSpeechRef.current = false;
    speechMsRef.current = 0;
    noiseFloorRef.current = 0.006;
    speechPeakRef.current = 0;
    const startedAt = Date.now();
    lastVoiceAtRef.current = startedAt;
    recordingStartedAtRef.current = startedAt;
    stoppingRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const chunk = new Float32Array(input);
        chunksRef.current.push(chunk);

        let sumSquares = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          sumSquares += chunk[index] * chunk[index];
        }
        const rms = Math.sqrt(sumSquares / chunk.length);
        const now = Date.now();
        const noiseFloor = noiseFloorRef.current;
        const speechThreshold = Math.max(BASE_SPEECH_THRESHOLD, noiseFloor * 2.4);
        const previousPeak = speechPeakRef.current;
        const continuationThreshold = Math.max(
          noiseFloor * 1.8,
          Math.min(speechThreshold, Math.max(BASE_SPEECH_THRESHOLD * 0.65, previousPeak ? previousPeak * 0.22 : speechThreshold))
        );
        const chunkDurationMs = event.inputBuffer.duration * 1000;
        const elapsed = now - recordingStartedAtRef.current;
        const hadSpeech = hasSpeechRef.current;
        const isSpeech = rms >= speechThreshold;
        const isContinuation = hadSpeech && rms >= continuationThreshold;

        if (!hasSpeechRef.current || rms < speechThreshold * 0.7) {
          noiseFloorRef.current = noiseFloor * 0.94 + rms * 0.06;
        }

        if (isSpeech || isContinuation) {
          hasSpeechRef.current = true;
          speechMsRef.current += chunkDurationMs;
          lastVoiceAtRef.current = now;

          if (isSpeech) {
            speechPeakRef.current = Math.max(previousPeak * 0.995, rms);
          }
        }

        if (
          hasSpeechRef.current &&
          speechMsRef.current >= MIN_SPEECH_MS &&
          elapsed >= MIN_RECORDING_MS &&
          (
            now - lastVoiceAtRef.current >= SILENCE_MS ||
            elapsed >= MAX_UTTERANCE_MS
          ) &&
          !stoppingRef.current
        ) {
          void stopRecordingAndSubmit();
        }
      };

      source.connect(processor);
      processor.connect(gainNode);
      gainNode.connect(audioContext.destination);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceNodeRef.current = source;
      processorRef.current = processor;
      gainNodeRef.current = gainNode;
      sampleRateRef.current = audioContext.sampleRate;
      recordingRef.current = true;
      setRecording(true);
      return true;
    } catch {
      teardownRecorder();
      setError("Браузер не дал доступ к микрофону. Разрешите его для этого сайта.");
      deactivateSession();
      return false;
    }
  }

  async function handleOrbClick() {
    if (!sessionActive) {
      unlockAudioOutput();
      unlockSpeechSynthesis();
      requestEpochRef.current += 1;
      activeConversationRef.current = [];
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      sessionActiveRef.current = true;
      setSessionActive(true);
      setError("");
      if (LIVE_ASSISTANT_ENABLED) {
        const liveStarted = await startLiveSession();
        if (!liveStarted) {
          deactivateSession();
        }
      } else {
        if (shouldUseRecorderFallback()) {
          const recorderStarted = await startRecording();
          if (!recorderStarted) {
            deactivateSession();
          }
        } else {
          const stableStarted = startStableVoiceRecognition();
          if (!stableStarted) {
            deactivateSession();
          }
        }
      }
      return;
    }

    deactivateSession();
  }

  function clearHistory() {
    historyRef.current = [];
    activeConversationRef.current = [];
    setHistory([]);
    setHeardText("");
    setReplyText("");
    setError("");
    setShowDialog(false);
    latestAudioRef.current = null;
    stopLivePlayback();
    stopPlayback();
    localStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }

  async function replayLatestReply() {
    if (latestAudioRef.current?.audioBase64) {
      await playGeminiAudio(latestAudioRef.current.audioBase64, latestAudioRef.current.audioMimeType);
    }
  }

  return (
    <div className="voice-mode-screen">
      <div className="voice-mode-overlay" />
      <div className="voice-mode-topbar">
        <div className="voice-mode-topbar-actions">
          {hasDialogButton ? (
            <Button type="button" variant="secondary" onClick={() => setShowDialog((current) => !current)}>
              {showDialog ? <X size={16} /> : <MessageSquareText size={16} />}
              {showDialog ? "Скрыть диалог" : "Диалог"}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" onClick={() => navigate("/")}>
            <ArrowLeft size={16} />
            В CRM
          </Button>
        </div>
      </div>

      <div className={`voice-mode-center ${showDialog ? "is-dialog-open" : "is-compact"}`}>
        {(sessionActive || showDialog || error) && <div className="voice-mode-caption">Голосовой помощник</div>}
        <button
          type="button"
          onClick={handleOrbClick}
          disabled={pending}
          className={`voice-assistant-mark ${recording ? "is-listening" : ""} ${pending ? "is-processing" : ""} ${speaking ? "is-speaking" : ""} ${sessionActive ? "is-session-active" : ""}`}
          aria-label="Запустить непрерывный голосовой диалог AI-помощника"
        >
          <span className="voice-mark-shadow" />
          <span className="voice-mark-blob voice-mark-blob-back" />
          <span className="voice-mark-blob voice-mark-blob-front" />
          <span className="voice-mark-wave voice-mark-wave-one" />
          <span className="voice-mark-wave voice-mark-wave-two" />
          <span className="voice-mark-core">
            <span className="voice-mark-glass" />
            {pending ? (
              <LoaderCircle size={40} className="animate-spin text-[#1c4fd7]" />
            ) : speaking ? (
              <Volume2 size={40} className="text-[#1c4fd7]" />
            ) : recording || sessionActive ? (
              <Mic size={40} className="text-[#1c4fd7]" />
            ) : (
              <Waveform />
            )}
          </span>
        </button>

        {currentStatus ? <div className="voice-mode-status">{currentStatus}</div> : null}

        {sessionActive || !voiceSupported ? (
          <div className="voice-mode-hint">
            {!voiceSupported
              ? "Этот браузер не поддерживает запись микрофона"
              : recording
                ? "Говорите. После паузы помощник ответит и сам снова начнёт слушать."
                : speaking
                  ? "Помощник отвечает. После ответа диалог продолжится автоматически."
                  : pending
                    ? "AI-помощник обрабатывает CRM-команду."
                    : "Диалог активен. Чтобы завершить его, нажмите на логотип ещё раз."}
          </div>
        ) : null}
      </div>

      {showDialog ? (
        <div className="voice-mode-dock">
          <div className="voice-mode-dock-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={replayLatestReply}
              disabled={!(latestAudioRef.current?.audioBase64 || replyText) || pending}
            >
              <Volume2 size={16} />
              Повторить ответ
            </Button>
            <Button type="button" variant="ghost" onClick={clearHistory}>
              Очистить
            </Button>
          </div>

          <div className="voice-mode-answer">
            <div className="voice-mode-answer-title">Последняя команда</div>
            <div className="voice-mode-answer-text">
              {heardText || "Здесь будет последняя распознанная голосовая команда."}
            </div>
          </div>

          <div className="voice-mode-answer">
            <div className="voice-mode-answer-title">Последний ответ</div>
            <div className="voice-mode-answer-text">
              {replyText || "Последний ответ AI-помощника появится здесь после голосовой команды."}
            </div>
          </div>

          <div className="voice-mode-history">
            {recentCommands.length === 0 ? (
              <div className="voice-history-empty">История голосовых команд пока пуста.</div>
            ) : (
              recentCommands.map((item, index) => (
                <div key={`${item.user}-${index}`} className="voice-history-item">
                  <div className="voice-history-user">{historyPreview(item)}</div>
                  <div className="voice-history-reply">{item.assistant}</div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {!showDialog && (heardText || replyText) ? (
        <div className="voice-mode-last-reply">
          {heardText ? <div className="voice-mode-last-heard">{heardText}</div> : null}
          <div className="voice-mode-last-answer">
            {replyText || "Жду ответ AI-помощника..."}
          </div>
          {latestAudioRef.current?.audioBase64 || replyText ? (
            <button type="button" className="voice-mode-last-repeat" onClick={replayLatestReply} disabled={pending}>
              Повторить
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <div className={`voice-mode-error ${showDialog ? "" : "voice-mode-error--compact"}`}>{error}</div> : null}
    </div>
  );
}
