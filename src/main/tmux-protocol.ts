import type { ProcessInfo } from "../shared/engine";
const fields=["session_name","pane_pid","pane_current_command","pane_current_path","pane_dead","pane_dead_status","pane_dead_signal","pane_dead_time","pane_tty"];
// tmux's n: reports byte length. Netstrings preserve tabs, newlines, commas and Unicode.
export const paneFormat=fields.map(field=>`#{n:${field}}:#{${field}},`).join("");
export function parsePanes(bytes:Buffer):Map<string,ProcessInfo> {
  const result=new Map<string,ProcessInfo>();
  let offset=0;
  while (offset<bytes.length) {
    if (bytes[offset]===10) {offset++;continue;}
    const row:string[]=[];
    for (let field=0;field<fields.length;field++) {
      const colon=bytes.indexOf(58,offset);
      const prefix=bytes.subarray(offset,colon).toString("ascii");
      if (colon<offset || !/^\d{1,7}$/.test(prefix)) throw new Error("Invalid tmux length prefix");
      const end=colon+1+Number(prefix);
      if (end>=bytes.length || bytes[end]!==44) throw new Error("Truncated tmux metadata");
      const raw=bytes.subarray(colon+1,end);const text=raw.toString("utf8");
      if (!Buffer.from(text).equals(raw)) throw new Error("tmux path is not valid UTF-8");
      row.push(text);offset=end+1;
    }
    const [name,pid,command,cwd,dead,code,signal,time,tty]=row;
    if (!/^minimal_[a-f0-9-]{36}$/.test(name)) continue;
    if (!/^\d+$/.test(pid) || !/^[01]$/.test(dead) || (code && !/^\d+$/.test(code))) throw new Error("Invalid tmux process metadata");
    const id=name.slice(8);
    result.set(id,{id,pid:Number(pid),process:command,cwd,dead:dead==="1",exitCode:code?Number(code):undefined,exitSignal:signal||undefined,endedAt:time && Number.isFinite(Number(time)) && Number(time)>0 ? new Date(Number(time)*1000).toISOString():undefined,tty});
  }
  return result;
}
