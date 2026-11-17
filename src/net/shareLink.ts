// The invite link the studio shows and copies: always the raw link on the streamer's OWN relay
// (https://vtube-pro-relay.<name>.workers.dev/j/<room>, or their own domain). There is no short-link service.
// Kept as one function so every screen that shows or copies an invite goes through the same place.

/** The link to show / copy for a raw relay invite (unchanged: no wrapper, no redirect service). */
export const shareLink = (raw: string): string => raw;
