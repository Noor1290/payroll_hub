import { z } from "zod";

// Zod can speed itself up by generating code at runtime, and probes whether it is allowed to.
// The Content Security Policy forbids that (no eval), so tell it not to try. This file must be
// the first import of main.tsx, so it runs before any other module validates something.
z.config({ jitless: true });
