// theme.ts — the one line of JS behind the appearance setting.
//
// The palette is entirely CSS custom properties on :root, so switching themes
// is switching an attribute; "system" leaves the choice to prefers-color-scheme
// rather than freezing whatever the OS said at startup.

export type Theme = "dark" | "light" | "system";

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
