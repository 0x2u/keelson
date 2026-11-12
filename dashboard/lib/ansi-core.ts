// CSI sequences (colours, cursor moves, erase), OSC sequences (window titles, links) and two-character escapes. Programs
// write them to a log when they think they talk to a terminal; the browser drops the ESC byte and shows what is left, "[0m".
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** The text without its terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, "");
}
