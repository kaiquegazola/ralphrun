// notify.ts — the OS-notification side of the "intervenção por exceção"
// principle. The app exists so you do NOT have to watch it; a decision that
// needs you has to reach you when the window is behind something else.
//
// Three events, three independent routings (settings 3b): a pending decision, a
// task merged into the trunk, and a run ending. "silent" means exactly that —
// no notification at all, not a quiet one.

import { Utils } from "electrobun/main";

import { loadAppSettings, type NotifyMode } from "./appsettings.ts";

export type NotifyEvent = "decision" | "merge" | "runEnd";

function modeFor(event: NotifyEvent): NotifyMode {
  const s = loadAppSettings();
  return event === "decision" ? s.notifyDecision : event === "merge" ? s.notifyMerge : s.notifyRunEnd;
}

export function notifyUser(event: NotifyEvent, title: string, body: string): void {
  const mode = modeFor(event);
  if (mode === "silent") return;
  // `silent` on the OS notification is the SOUND switch, not the whole
  // notification — "sistema" shows it quietly, "som" shows it with a chime.
  Utils.showNotification({ title, body, silent: mode !== "sound" });
}
