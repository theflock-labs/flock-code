// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TerminalFontSetting from "./TerminalFontSetting";
import { getStoredTerminalFont } from "../lib/terminalFont";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Terminal font setting", () => {
  it("applies a preset, remembers it after reopening, and resets to system", () => {
    const view = render(<TerminalFontSetting />);
    fireEvent.change(screen.getByLabelText("Terminal font"), { target: { value: "Menlo" } });
    expect(getStoredTerminalFont()).toBe("Menlo");
    expect(screen.getByLabelText("Terminal font preview").style.fontFamily).toContain("Menlo");
    view.unmount();
    render(<TerminalFontSetting />);
    expect((screen.getByLabelText("Terminal font") as HTMLSelectElement).value).toBe("Menlo");
    fireEvent.click(screen.getByRole("button", { name: "Reset font" }));
    expect(getStoredTerminalFont()).toBe("");
    expect((screen.getByLabelText("Terminal font") as HTMLSelectElement).value).toBe("");
  });

  it("only applies a custom family on submission, with a preview of the applied choice", () => {
    render(<TerminalFontSetting />);
    fireEvent.change(screen.getByLabelText("Terminal font"), { target: { value: "custom" } });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Installed font name"), { target: { value: "Berkeley Mono" } });
    expect(getStoredTerminalFont()).toBe("");
    fireEvent.submit(screen.getByLabelText("Installed font name").closest("form")!);
    expect(getStoredTerminalFont()).toBe("Berkeley Mono");
    expect(screen.getByLabelText("Terminal font preview").style.fontFamily).toContain("Berkeley Mono");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
