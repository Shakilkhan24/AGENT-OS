import type { TerminalRecord } from "./types";
import type { StopPolicy } from "./events";
export interface ProcessInfo {
  id:string;pid:number;process:string;cwd:string;dead:boolean;exitCode?:number;exitSignal?:string;endedAt?:string;tty?:string;
}
export interface Attachment {
  token:string;
  input(data:string):Promise<void>;
  resize(cols:number,rows:number):void;
  acknowledge(bytes:number):void;
  close():void;
}
export interface EngineCapabilities {
  id:string;platforms:readonly string[];persistent:boolean;environment:boolean;pushStatus:boolean;processTree:boolean;
}
export interface StopReport {policy:StopPolicy;signalled:number[];remaining:number[];bestEffort:true;accountingIncomplete:boolean}
export interface EngineAdapter {
  readonly capabilities:EngineCapabilities;
  initialize():Promise<void>;
  inspect():Promise<Map<string,ProcessInfo>>;
  create(terminal:TerminalRecord):Promise<void>;
  remove(id:string):Promise<void>;
  attach(id:string,cols:number,rows:number,output:(token:string,data:string)=>void,exit:(token:string)=>void):Attachment;
  onChange?(listener:()=>void):()=>void;
  stop?(id:string,policy:StopPolicy,report:(stage:"interrupt"|"term"|"kill"|"removed",pids:number[])=>void):Promise<StopReport>;
  close?():void;
}
