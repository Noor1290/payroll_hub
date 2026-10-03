> Status: built on 2026-10-03. Decisions and scope are recorded in docs/BRIEF.md section 12 ("Password gate").

Add a re-authentication gate to the Database page:
- On first open, show a "Confirm your password to continue" dialog. Verify the password with a separate, temporary Supabase client created with persistSession: false and autoRefreshToken: false, calling signInWithPassword using the current user's email. Never touch or replace the main session.
- Never store, log or persist the password. Clear the input and any reference to it immediately after the check.
- Keep the page unlocked for 10 minutes (configurable in Settings, 1 to 30), then lock again. Also lock on manual logout, idle sign-out, session expiry, and when the tab has been hidden for more than 2 minutes.
- Show friendly messages for a wrong password, rate limiting (too many attempts), and an unreachable or paused database.
- Keep sensitive-column masking with click-to-reveal even after unlocking.
- Store the unlocked state in memory only (no localStorage or sessionStorage).
- Add tests for: locks after the timeout, locks on logout, wrong password stays locked, and the password is never present in storage.
- Add a short note in the README saying this gate is a convenience layer and that the database security rules remain the real enforcement.