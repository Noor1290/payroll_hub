/**
 * THE one place that says where the dashboard and the apps are hosted.
 *
 * Today everything is on one GitHub Pages origin. That means the iframe sandbox gives NO
 * isolation between the dashboard and the apps (see README: "Same-origin risk"). To move the
 * dashboard to its own origin later, change `dashboard` here and the matching `HUB_ORIGIN`
 * line at the top of docs/bridge.js (a test fails if the two disagree), then redeploy the
 * dashboard and re-copy bridge.js into each app.
 */
export const HOSTING = {
  /** Origin the deployed dashboard is served from. bridge.js in each app trusts exactly this. */
  dashboard: "https://noor1290.github.io",
  /** Origin the apps are served from. */
  apps: "https://noor1290.github.io",
} as const;
