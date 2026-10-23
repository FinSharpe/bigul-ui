import { describe, expect, it } from "vitest";
import { parseRawQuery, rawQueryString } from "./query";

describe("rawQueryString", () => {
  it("returns the query exactly as sent, without the fragment", () => {
    expect(
      rawQueryString("https://app.test/auth/callback?a=s+4x/GU=&b=%2B#frag"),
    ).toBe("a=s+4x/GU=&b=%2B");
    expect(rawQueryString("https://app.test/")).toBe("");
    expect(rawQueryString("https://app.test/?")).toBe("");
  });
});

describe("parseRawQuery", () => {
  it("keeps '+' and '/' in values (URLSearchParams would not)", () => {
    const token = "s+4xF+iIYJU9emMt+8DY/GU=";
    const query = `login_success=true&userid=Y09042341&state=abc&token=${token}`;
    expect(parseRawQuery(query).get("token")).toBe(token);
    expect(new URLSearchParams(query).get("token")).not.toBe(token);
  });

  it("percent-decodes values and keys", () => {
    const query = parseRawQuery("?token=a%2Bb%2Fc%3D&user%69d=%20y1%20");
    expect(query.get("token")).toBe("a+b/c=");
    expect(query.get("userid")).toBe(" y1 ");
  });

  it("treats a bare key as empty and keeps '=' inside a value", () => {
    const query = parseRawQuery("flag&token=abc==&empty=");
    expect(query.get("flag")).toBe("");
    expect(query.get("token")).toBe("abc==");
    expect(query.get("empty")).toBe("");
  });

  it("drops repeated and undecodable parameters", () => {
    const query = parseRawQuery(
      "state=a&token=ok&state=b&bad=%E0%A4%A&state=c",
    );
    expect(query.has("state")).toBe(false);
    expect(query.has("bad")).toBe(false);
    expect(query.get("token")).toBe("ok");
  });
});
