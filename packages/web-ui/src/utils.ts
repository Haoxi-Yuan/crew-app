// Shared utility functions

const AVATAR_COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b",
  "#22c55e", "#06b6d4", "#6366f1", "#14b8a6", "#f97316",
];

export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Generate a conic-gradient CSS value for avatar border progress.
 * The avatar wrapper uses this as background, with inner avatar creating
 * the "border" effect via padding gap.
 * @param percent 0-100 context usage percentage
 * @param color base color (used when percent <= 60)
 */
export function contextBorderGradient(percent: number, color: string): string {
  let ringColor = color;
  if (percent > 80) ringColor = "#ef4444";
  else if (percent > 60) ringColor = "#f59e0b";
  const angle = Math.round((percent / 100) * 360);
  const trackColor = "rgba(255,255,255,0.1)";
  if (percent <= 0) return trackColor;
  if (percent >= 100) return ringColor;
  return `conic-gradient(from 0deg, ${ringColor} 0deg, ${ringColor} ${angle}deg, ${trackColor} ${angle}deg, ${trackColor} 360deg)`;
}
