// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignInGate from "./SignInGate";
import { claimHandle, getMyProfile, signIn } from "../lib/flockId";

vi.mock("../lib/flockId", () => ({
  claimHandle: vi.fn(), getMyProfile: vi.fn(), signIn: vi.fn(),
  getIdConfig: () => ({ url: "https://identity.example.invalid", anonKey: "public-key" }),
  isIdConfigured: () => true, setIdConfig: vi.fn(),
}));
beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

it("keeps Claiming visible until the refreshed profile opens the app", async () => {
  let complete!: () => void;
  const onReady = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  render(<SignInGate checking={false} needsHandle onReady={onReady} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Handle" }), { target: { value: "new-account" } });
  fireEvent.click(screen.getByRole("button", { name: "Claim handle" }));
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Claiming…" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("textbox", { name: "Handle" }).hasAttribute("disabled")).toBe(true);
  complete();
  await waitFor(() => expect(screen.getByRole("button", { name: "Claim handle" }).hasAttribute("disabled")).toBe(false));
});

it("shows profile refresh errors and permits retry instead of silently staying put", async () => {
  const onReady = vi.fn().mockRejectedValueOnce(new Error("Profile service unavailable")).mockResolvedValue(undefined);
  render(<SignInGate checking={false} needsHandle onReady={onReady} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Handle" }), { target: { value: "new-account" } });
  fireEvent.click(screen.getByRole("button", { name: "Claim handle" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Profile service unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Claim handle" }));
  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("does not leave the gate after an unsuccessful handle save", async () => {
  vi.mocked(claimHandle).mockRejectedValueOnce(new Error("That handle is taken."));
  const onReady = vi.fn();
  render(<SignInGate checking={false} needsHandle onReady={onReady} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Handle" }), { target: { value: "taken-name" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Handle" }), { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That handle is taken.");
  expect(onReady).not.toHaveBeenCalled();
});

it("shows a profile read failure after Google sign-in instead of treating it as a new handle", async () => {
  vi.mocked(signIn).mockResolvedValue({} as Awaited<ReturnType<typeof signIn>>);
  vi.mocked(getMyProfile).mockRejectedValueOnce(new Error("Profile lookup failed"));
  render(<SignInGate checking={false} needsHandle={false} onReady={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Profile lookup failed");
  expect(screen.queryByRole("button", { name: "Claim handle" })).toBeNull();
});
