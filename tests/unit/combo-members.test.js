import { describe, it, expect } from "vitest";
import {
  buildMembersFromModels,
  comboAllowsKey,
  comboMemberModelString,
  comboMembersToModels,
  normalizeComboKeyIds,
  normalizeComboMembers,
  parseComboModelString,
} from "@/shared/utils/comboMembers.js";

describe("parseComboModelString", () => {
  it("splits provider/model at the first slash", () => {
    expect(parseComboModelString("agc/gemini-3.8-flash-low")).toEqual({
      provider: "agc",
      model: "gemini-3.8-flash-low",
    });
    expect(parseComboModelString("nested-combo")).toEqual({ provider: "", model: "nested-combo" });
    expect(parseComboModelString("")).toEqual({ provider: "", model: "" });
  });
});

describe("normalizeComboMembers", () => {
  it("expands legacy model strings into default members", () => {
    const members = buildMembersFromModels(["agc/gemini-3.8-flash-low", "cc/claude-sonnet-5-5"]);
    expect(members).toEqual([
      {
        provider: "agc",
        model: "gemini-3.8-flash-low",
        connectionId: null,
        accountFallback: "next-account",
        enabled: true,
      },
      {
        provider: "cc",
        model: "claude-sonnet-5-5",
        connectionId: null,
        accountFallback: "next-account",
        enabled: true,
      },
    ]);
    expect(comboMembersToModels(members)).toEqual([
      "agc/gemini-3.8-flash-low",
      "cc/claude-sonnet-5-5",
    ]);
  });

  it("keeps a pinned account, normalizes fallback and de-duplicates", () => {
    const members = normalizeComboMembers([
      {
        provider: "agc",
        model: "gemini-3.8-flash-low",
        connectionId: "conn-1",
        accountFallback: "next-member",
      },
      { provider: "agc", model: "gemini-3.8-flash-low", connectionId: "conn-2" },
      { provider: "cc", model: "claude-sonnet-5-5", accountFallback: "bogus" },
    ]);
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({
      provider: "agc",
      model: "gemini-3.8-flash-low",
      connectionId: "conn-1",
      accountFallback: "next-member",
    });
    expect(members[1].accountFallback).toBe("next-account");
  });

  it("accepts a full provider/model string and trims the connection id", () => {
    const members = normalizeComboMembers([
      { model: "agc/gemini-3.8-flash-low", connectionId: "  conn-1  " },
    ]);
    expect(members[0]).toMatchObject({
      provider: "agc",
      model: "gemini-3.8-flash-low",
      connectionId: "conn-1",
    });
    expect(comboMemberModelString(members[0])).toBe("agc/gemini-3.8-flash-low");
  });
});

describe("keyIds", () => {
  it("normalizes ids and treats an empty list as public", () => {
    expect(normalizeComboKeyIds([" key-a ", "key-a", "", 3])).toEqual(["key-a"]);
    expect(comboAllowsKey([], "key-a")).toBe(true);
    expect(comboAllowsKey(["key-b"], "key-a")).toBe(false);
    expect(comboAllowsKey(["key-b"], "key-b")).toBe(true);
    expect(comboAllowsKey(["key-b"], null)).toBe(false);
  });
});
