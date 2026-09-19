import type { AuthSession } from "@hyperfixation/auth";
import { describe, expect, it } from "vitest";
import { actorOf } from "../src/workspace";

/**
 * The one thing the app decides about a workspace request: who it is, and whether they are an
 * admin. It is worth a suite of its own because `admin: true` is what lets `workspace.decide`
 * settle an approval assigned to somebody else — a mapping that reads a role wrong is an
 * authorisation bug, not a rendering one.
 */
function session(user: Partial<AuthSession["user"]>): AuthSession {
  return { factor: "passkey", user: { id: "user-1", ...user } };
}

describe("actorOf", () => {
  it("carries the user id through", () => {
    expect(actorOf(session({ email: "member@example.com" }))).toEqual({
      userId: "user-1",
      admin: false,
    });
  });

  it("is an admin only for the admin role", () => {
    expect(actorOf(session({ role: "admin" })).admin).toBe(true);
    expect(actorOf(session({ role: "member" })).admin).toBe(false);
    expect(actorOf(session({ role: null })).admin).toBe(false);
    expect(actorOf(session({})).admin).toBe(false);
  });

  it("reads the role as the column stores it, not as the form typed it", () => {
    expect(actorOf(session({ role: "Admin" })).admin).toBe(true);
    expect(actorOf(session({ role: " admin " })).admin).toBe(true);
    expect(actorOf(session({ role: "administrator" })).admin).toBe(false);
  });
});
