/**
 * How a request handler (outside React) shows a company's Company profile: the shell registers
 * the way to do it (ProfileOpener, which has the router and the company), the MRA Returns app's
 * `open-profile` request uses it. Nothing is sent to the app; only the dashboard's screen moves.
 */
type Opener = (companyId: string) => void;

let opener: Opener | null = null;

/** Registers the way to open a profile; returns how to remove it. */
export function setProfileOpener(next: Opener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

/** Whether the shell is there to open a profile. */
export function profileOpenerReady(): boolean {
  return opener !== null;
}

/** Shows that company's Company profile. False when the shell is not there to do it. */
export function openCompanyProfile(companyId: string): boolean {
  if (!opener) return false;
  opener(companyId);
  return true;
}
