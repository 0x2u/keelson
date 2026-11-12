import { describe, expect, it } from "vitest";
import { parseDotenv } from "@/lib/dotenv-core";

const values = (text: string) => Object.fromEntries(parseDotenv(text).entries.map((e) => [e.key, e.value]));

describe("parseDotenv", () => {
  it("reads plain assignments, skipping blank lines and comments", () => {
    const out = parseDotenv("# a comment\n\nA=1\n   # indented comment\nB=two words\n");
    expect(out.entries).toEqual([
      { key: "A", value: "1", line: 3 },
      { key: "B", value: "two words", line: 5 },
    ]);
    expect(out.invalid).toEqual([]);
    expect(out.duplicates).toEqual([]);
  });

  it("accepts `export`, spaces around the = and CRLF line ends and a byte-order mark", () => {
    expect(values("\uFEFFexport A=1\r\n  export   B = 2 \r\nC =3\r\n")).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("strips an inline comment that follows a space, and keeps a # inside a word", () => {
    expect(values("A=value # note\nB=a#b\nC=#kept\nD= # nothing\n")).toEqual({ A: "value", B: "a#b", C: "#kept", D: "" });
  });

  it("takes single and backtick quotes literally, escapes included", () => {
    expect(values("A='a\\nb # not a comment'\nB=`x\"y'z`\n")).toEqual({ A: "a\\nb # not a comment", B: "x\"y'z" });
  });

  it("resolves the escapes of a double-quoted value and keeps other backslashes", () => {
    expect(values('A="line1\\nline2\\ttab\\\\ \\"q\\" \\$HOME C:\\dir"\n')).toEqual({ A: 'line1\nline2\ttab\\ "q" $HOME C:\\dir' });
  });

  it("reads a double-quoted value over several lines, and counts the lines that follow", () => {
    const out = parseDotenv('KEY="-----BEGIN\nabc\n-----END"\nNEXT=1\n');
    expect(out.entries).toEqual([
      { key: "KEY", value: "-----BEGIN\nabc\n-----END", line: 1 },
      { key: "NEXT", value: "1", line: 4 },
    ]);
    const single = parseDotenv("A='x\ny'\nB=2");
    expect(single.entries.map((e) => [e.key, e.value, e.line])).toEqual([["A", "x\ny", 1], ["B", "2", 3]]);
  });

  it("allows a comment after a closing quote, and refuses other text there", () => {
    const out = parseDotenv('A="v" # c\nB="v" extra\nC=ok\n');
    expect(out.entries.map((e) => e.key)).toEqual(["A", "C"]);
    expect(out.invalid).toEqual([{ line: 2, key: "B", reason: "text after the closing quote" }]);
  });

  it("reports an unclosed quote on its own line and goes on with the next lines", () => {
    const out = parseDotenv('A="never closed\nB=2\n');
    expect(out.invalid).toEqual([{ line: 1, key: "A", reason: "the quote is never closed" }]);
    expect(values('A="never closed\nB=2\n')).toEqual({ B: "2" });
  });

  it("lets the last value of a repeated name win, and reports the repeat", () => {
    const out = parseDotenv("A=1\nB=2\nA=3\nA=4\n");
    expect(out.entries).toEqual([
      { key: "A", value: "4", line: 4 },
      { key: "B", value: "2", line: 2 },
    ]);
    expect(out.duplicates).toEqual([{ key: "A", lines: [1, 3, 4] }]);
  });

  it("lists invalid names and lines without = by number, never showing a value", () => {
    const out = parseDotenv("1BAD=secret-one\nmy-key=secret-two\n=secret-three\njust some text with a secret\nGOOD=1\n" + `${"X".repeat(129)}=v\n`);
    expect(out.entries.map((e) => e.key)).toEqual(["GOOD"]);
    expect(out.invalid.map((p) => [p.line, p.key, p.reason.slice(0, 12)])).toEqual([
      [1, "1BAD", "not a valid "],
      [2, "my-key", "not a valid "],
      [3, undefined, "no name befo"],
      [4, undefined, "no = sign"],
      [6, `${"X".repeat(64)}…`, "not a valid "],
    ]);
    expect(JSON.stringify(out.invalid)).not.toMatch(/secret/);
  });

  it("keeps an empty value, and an = inside a value", () => {
    expect(values("A=\nB=x=y=z\nC=\"\"\n")).toEqual({ A: "", B: "x=y=z", C: "" });
  });

  it("returns nothing for an empty text", () => {
    expect(parseDotenv("")).toEqual({ entries: [], duplicates: [], invalid: [] });
    expect(parseDotenv("\n\n# only comments\n")).toEqual({ entries: [], duplicates: [], invalid: [] });
  });
});
