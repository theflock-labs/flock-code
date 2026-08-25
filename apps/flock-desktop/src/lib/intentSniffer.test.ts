import { describe, it, expect } from "vitest";
import { IntentSniffer } from "./intentSniffer";

const ESC = "\x1b";

describe("IntentSniffer", () => {
  it("captures a plainly typed line on Enter", () => {
    const s = new IntentSniffer();
    expect(s.feed("hello world")).toBeNull();
    expect(s.feed("\r")).toBe("hello world");
  });

  it("trims surrounding whitespace on submit", () => {
    const s = new IntentSniffer();
    expect(s.feed("  spaced out  \r")).toBe("spaced out");
  });

  it("treats LF as a newline in the line, not a submit", () => {
    const s = new IntentSniffer();
    s.feed("first\nsecond");
    expect(s.currentLine()).toBe("first\nsecond");
    // The captured intent flattens the newline; the tracked line keeps it.
    expect(s.feed("\r")).toBe("first second");
    expect(s.currentLine()).toBe("");
  });

  it("swallows the LF of a CRLF pair instead of starting a new line", () => {
    const s = new IntentSniffer();
    expect(s.feed("done\r\n")).toBe("done");
    expect(s.currentLine()).toBe("");
  });

  it("keeps parsing after a submit so trailing input stays in the buffer", () => {
    const s = new IntentSniffer();
    expect(s.feed("first prompt\rleftover")).toBe("first prompt");
    expect(s.currentLine()).toBe("leftover");
  });

  it("returns null for an empty or whitespace-only submit and keeps parsing", () => {
    const s = new IntentSniffer();
    // Blank Enter must not stop the chunk: "after" still lands in the buffer.
    expect(s.feed("   \rafter")).toBeNull();
    expect(s.feed("\r")).toBe("after");
  });

  it("inserts at the cursor after left/right arrow moves", () => {
    const s = new IntentSniffer();
    s.feed("ac");
    s.feed(`${ESC}[D`); // ← before "c"
    s.feed("b");
    expect(s.feed(`${ESC}[C\r`)).toBe("abc"); // → back to end, submit
  });

  it("backspaces at the cursor and is a no-op at line start", () => {
    const s = new IntentSniffer();
    s.feed("\x7fab"); // backspace on empty buffer does nothing
    s.feed("c\x7f"); // delete the "c" again
    expect(s.feed("\r")).toBe("ab");
  });

  it("deletes before the cursor mid-line", () => {
    const s = new IntentSniffer();
    s.feed("axbc");
    s.feed(`${ESC}[D${ESC}[D`); // cursor between "x" and "b"
    s.feed("\x7f"); // delete "x"
    expect(s.feed("\r")).toBe("abc");
  });

  it("jumps with Ctrl-A / Ctrl-E", () => {
    const s = new IntentSniffer();
    s.feed("bc");
    s.feed("\x01a"); // Ctrl-A then insert at start
    s.feed("\x05d"); // Ctrl-E then append at end
    expect(s.feed("\r")).toBe("abcd");
  });

  it("deletes the previous word with Ctrl-W", () => {
    const s = new IntentSniffer();
    s.feed("git commit  \x17"); // trailing spaces are skipped, then the word
    expect(s.feed("push\r")).toBe("git push");
  });

  it("kills to line start with Ctrl-U", () => {
    const s = new IntentSniffer();
    s.feed("junkkeep");
    s.feed(`${ESC}[D${ESC}[D${ESC}[D${ESC}[D`); // cursor before "keep"
    s.feed("\x15"); // Ctrl-U removes "junk"
    expect(s.feed("\r")).toBe("keep");
  });

  it("kills to line end with Ctrl-K", () => {
    const s = new IntentSniffer();
    s.feed("keepjunk");
    s.feed(`${ESC}[D${ESC}[D${ESC}[D${ESC}[D`); // cursor after "keep"
    s.feed("\x0b"); // Ctrl-K removes "junk"
    expect(s.feed("\r")).toBe("keep");
  });

  it("clears the line on Ctrl-C", () => {
    const s = new IntentSniffer();
    s.feed("abandoned draft\x03");
    expect(s.feed("\r")).toBeNull();
    expect(s.feed("fresh\r")).toBe("fresh");
  });

  it("deletes the previous word on Option+Backspace (ESC DEL)", () => {
    const s = new IntentSniffer();
    s.feed(`fix the bugg${ESC}\x7f`);
    expect(s.feed("bug\r")).toBe("fix the bug");
  });

  it("captures a bracketed paste verbatim, wrappers stripped", () => {
    const s = new IntentSniffer();
    s.feed(`${ESC}[200~pasted prompt text${ESC}[201~`);
    expect(s.feed("\r")).toBe("pasted prompt text");
  });

  it("keeps a multi-line paste whole — nothing inside the brackets submits", () => {
    const s = new IntentSniffer();
    // xterm normalizes pasted newlines to CR, so both bytes must be treated as
    // "insert a newline" while the paste brackets are open.
    expect(s.feed(`${ESC}[200~line one\rline two\nline three${ESC}[201~`)).toBeNull();
    expect(s.currentLine()).toBe("line one\nline two\nline three");
    expect(s.feed("\r")).toBe("line one line two line three");
  });

  it("submits again once the paste brackets close", () => {
    const s = new IntentSniffer();
    s.feed(`${ESC}[200~pasted\r${ESC}[201~tail`);
    expect(s.currentLine()).toBe("pasted\ntail");
    expect(s.feed("\r")).toBe("pasted tail");
  });

  it("swallows CSI sequences without leaking params as text", () => {
    const s = new IntentSniffer();
    s.feed(`ab${ESC}[A${ESC}[B${ESC}[1;2C`); // up, down, Shift+Right at end
    expect(s.feed("\r")).toBe("ab");
  });

  it("honors CSI and SS3 home/end variants", () => {
    const s = new IntentSniffer();
    s.feed("bc");
    s.feed(`${ESC}[H`); // Home
    s.feed("a");
    s.feed(`${ESC}[F`); // End
    s.feed("d");
    s.feed(`${ESC}[1~`); // Home variant
    s.feed("_");
    s.feed(`${ESC}[4~`); // End variant
    expect(s.feed("e\r")).toBe("_abcde");
  });

  it("moves the cursor with SS3 application arrows", () => {
    const s = new IntentSniffer();
    s.feed("ac");
    s.feed(`${ESC}OD`); // ← before "c"
    s.feed("b");
    s.feed(`${ESC}OC`); // → back to end
    expect(s.feed("d\r")).toBe("abcd");
  });

  it("forward-deletes with CSI 3~", () => {
    const s = new IntentSniffer();
    s.feed("abx");
    s.feed(`${ESC}[D${ESC}[3~`); // cursor before "x", Delete it
    expect(s.feed("c\r")).toBe("abc");
  });

  it("consumes OSC replies to BEL without polluting the line", () => {
    const s = new IntentSniffer();
    s.feed("real");
    s.feed(`${ESC}]11;rgb:1e1e/1e1e/2e2e\x07`);
    expect(s.feed("\r")).toBe("real");
  });

  it("consumes DCS and APC strings to their ST terminators", () => {
    const s = new IntentSniffer();
    s.feed(`${ESC}P>|xterm(377)${ESC}\\`); // DCS terminal-version reply
    s.feed("typed");
    s.feed(`${ESC}_private payload${ESC}\\`); // APC
    expect(s.feed("\r")).toBe("typed");
  });

  it("passes a /model command with a >24-char token through intact", () => {
    // parseModelCommand (App.tsx) does the token truncation; the sniffer's
    // job is only to deliver the submitted line unmangled.
    const s = new IntentSniffer();
    const line = "/model claude-opus-4-8-experimental-long-token";
    expect(s.feed(`${line}\r`)).toBe(line);
  });

  it("caps the captured prompt at 200 chars and the buffer at 500", () => {
    const s = new IntentSniffer();
    s.feed("x".repeat(600));
    const prompt = s.feed("\r");
    expect(prompt).toHaveLength(200);
    expect(prompt).toBe("x".repeat(200));
  });

  it("reset discards a half-typed line", () => {
    const s = new IntentSniffer();
    s.feed("half typed");
    s.reset();
    expect(s.feed("\r")).toBeNull();
    expect(s.feed("clean\r")).toBe("clean");
  });
});
