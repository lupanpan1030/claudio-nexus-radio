/**
 * Longest narration text the v1 cue path accepts, measured as the trimmed
 * JavaScript string length (UTF-16 code units). The DJ line validator, the
 * cue service (before a script is stored) and the voice service all use this
 * one bound, so a script that is published as ready is one the voice stage
 * will try to speak. It keeps the DJ validator's existing limit; the
 * contracts decoder's larger text bound only keeps stored assets readable.
 */
export const MAX_NARRATION_TEXT_LENGTH = 600;
