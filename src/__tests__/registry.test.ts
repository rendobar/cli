import { describe, it, expect } from "bun:test";
import { COMMANDS, GROUP_ORDER, commandNames, toSubCommands } from "../registry.js";

describe("registry", () => {
  it("lists the six commands", () => {
    expect(commandNames().sort()).toEqual(["doctor", "ffmpeg", "login", "logout", "update", "whoami"]);
  });
  it("every command's group is in GROUP_ORDER", () => {
    for (const c of COMMANDS) expect(GROUP_ORDER).toContain(c.group);
  });
  it("command names are unique", () => {
    const names = commandNames();
    expect(new Set(names).size).toBe(names.length);
  });
  it("toSubCommands yields one lazy loader per command", () => {
    const subs = toSubCommands();
    expect(Object.keys(subs).sort()).toEqual(commandNames().sort());
    for (const v of Object.values(subs)) expect(typeof v).toBe("function");
  });
});
