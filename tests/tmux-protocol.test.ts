import test from "node:test";
import assert from "node:assert/strict";
import { parsePanes } from "../src/main/tmux-protocol";
test("tmux metadata preserves delimiter characters and Unicode by byte length",()=>{
  const id=crypto.randomUUID(),cwd='/tmp/tab\tline\nλ✓汉🦊,:end',process='tool\n,:name';
  const frame=(row:string[])=>row.map(value=>`${Buffer.byteLength(value)}:${value},`).join("")+"\n";
  const data=Buffer.from(frame([`minimal_${id}`,"123",process,cwd,"1","7","","1780000000","/dev/pts/1"]));
  assert.equal(parsePanes(data).get(id)?.cwd,cwd);assert.equal(parsePanes(data).get(id)?.process,process);assert.equal(parsePanes(data).get(id)?.exitCode,7);
  assert.throws(()=>parsePanes(data.subarray(0,-3)),/Truncated/);
});
