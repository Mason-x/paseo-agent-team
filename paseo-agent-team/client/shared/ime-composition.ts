/** Composition end publishes the final text first, then lets the parent resume previews. */
export function finishComposition(
  publish: () => void,
  notify?: (composing: boolean) => void,
): void {
  publish();
  notify?.(false);
}
