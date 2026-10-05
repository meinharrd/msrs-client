// The media element the debug panel reads. The player sets it while it is mounted; the panel itself is mounted
// app-wide (MainLayout), so it is there on every page, with or without a player.
export const debugMediaRef: { current: HTMLMediaElement | null } = { current: null };
