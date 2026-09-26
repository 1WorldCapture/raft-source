/** Native modules land in the next APK. A missing module must not crash the JS bundle. */
export async function tapFeedback(): Promise<void> {
  try {
    const Haptics = await import("expo-haptics");
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    // The installed binary may predate expo-haptics.
  }
}

export async function copyText(value: string): Promise<void> {
  const Clipboard = await import("expo-clipboard");
  await Clipboard.setStringAsync(value);
}
