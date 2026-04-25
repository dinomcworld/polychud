/** Discord embed colors used across the bot. Centralized so the green/red
 * profit signaling and the brand blue stay visually consistent across cards. */
export const COLORS = {
  GREEN: 0x00cc66,
  RED: 0xff4444,
  GRAY: 0x888888,
  BLUE: 0x5865f2,
  GOLD: 0xffd700,
  ORANGE: 0xffaa00,
  /** Used by /daily when the bonus was already claimed today. */
  ORANGE_DEEP: 0xff6600,
} as const;

/** Color helpers for the common signed-value pattern. */
export function signedColor(n: number): number {
  if (n > 0) return COLORS.GREEN;
  if (n < 0) return COLORS.RED;
  return COLORS.GRAY;
}
