// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { claimHandle, getMyProfile, setIdConfig, supabase } from "./flockId";

const profile = { id: "00000000-0000-4000-8000-000000000001", handle: "new-account", display_name: "New Account", avatar_url: null };
const fetchMock = vi.fn();
let backendIndex = 0;

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setIdConfig(`https://identity-${++backendIndex}.example.invalid`, "test-public-key");
  vi.spyOn(supabase().auth, "getSession").mockResolvedValue({
    data: { session: { user: { id: profile.id }, access_token: "test-session" } as Session }, error: null,
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("profile loading during the privacy migration rollout", () => {
  it.each(["usage_sharing", "presence_sharing"])("keeps core identity usable when %s is absent, with sharing off", async (column) => {
    reply({ code: "42703", message: `column profiles.${column} does not exist` }, 400);
    reply([profile]);
    await expect(getMyProfile()).resolves.toEqual({ ...profile, usage_sharing: false, presence_sharing: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("select"))
      .toBe("id,handle,display_name,avatar_url");
  });

  it("retains explicit consent when the backend supports it", async () => {
    const current = { ...profile, usage_sharing: true, presence_sharing: false };
    reply([current]);
    await expect(getMyProfile()).resolves.toEqual(current);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "42501", message: "permission denied for table profiles" },
    { code: "42703", message: "column profiles.handle does not exist" },
  ])("does not turn other backend failures into missing profiles: $code", async (error) => {
    reply(error, 400);
    await expect(getMyProfile()).rejects.toThrow(error.message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed core-profile retry", async () => {
    reply({ code: "PGRST204", message: "Could not find the 'usage_sharing' column of 'profiles' in the schema cache" }, 400);
    reply({ code: "42501", message: "permission denied for table profiles" }, 403);
    await expect(getMyProfile()).rejects.toThrow("permission denied");
  });
});

describe("claiming a handle", () => {
  it("confirms the normalized handle actually persisted", async () => {
    reply(profile);
    await expect(claimHandle(" New-Account ")).resolves.toBeUndefined();
    const [url, request] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("id")).toBe(`eq.${profile.id}`);
    expect(JSON.parse(request.body)).toEqual({ handle: "new-account" });
    expect(request.headers.get("prefer")).toContain("return=representation");
  });

  it("rejects a successful request that updated no visible profile", async () => {
    reply({ code: "PGRST116", details: "The result contains 0 rows", message: "Cannot coerce the result to a single JSON object" }, 406);
    await expect(claimHandle("new-account")).rejects.toThrow("Your handle wasn’t saved");
  });

  it("keeps taken-handle errors actionable", async () => {
    reply({ code: "23505", message: "duplicate key value violates unique constraint profiles_handle_key" }, 409);
    await expect(claimHandle("new-account")).rejects.toThrow("That handle is taken.");
  });

  it.each(["ab", "-new", "a".repeat(33)])("validates database handle constraints before saving: %s", async (handle) => {
    await expect(claimHandle(handle)).rejects.toThrow("Use 3–32");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
