// 日本語の音声フィードバック(Web Speech API)。iOS では最初にユーザー操作内で unlock() が必要。
let enabled = true;

export function setVoiceEnabled(v) {
  enabled = v;
  if (!v && 'speechSynthesis' in window) speechSynthesis.cancel();
}

export function unlockSpeech() {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

export function speak(text, interrupt = true) {
  if (!enabled || !('speechSynthesis' in window)) return;
  const t = (text || '').trim();
  if (!t) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.lang = 'ja-JP';
  const voice = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('ja'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

export function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
