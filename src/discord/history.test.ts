import { describe, it, expect } from "vitest";
import { walkHistory } from "./history.ts";
function fixture(ids: string[], size = 100) {
  const seen: string[] = [];
  const fetch = async (before?: string) => ids.filter(id => !before || BigInt(id) < BigInt(before)).slice().sort((a,b) => Number(BigInt(b)-BigInt(a))).slice(0,size).map(id => ({ id }));
  return { seen, fetch, consume: async (page: {id:string}[]) => { seen.push(...page.map(p=>p.id)); } };
}
describe("Discord history pagination", () => {
  it("visits every page of a large history without jumping over the middle", async () => {
    const ids = Array.from({length: 354},(_,i)=>String(i+1)); const f = fixture(ids);
    expect(await walkHistory(f)).toBe(true); expect(new Set(f.seen).size).toBe(354); expect(f.seen).toContain("101");
  });
  it("catches up to a conservative watermark across multiple pages", async () => {
    const f = fixture(Array.from({length: 321},(_,i)=>String(i+1)));
    await walkHistory({...f,stopAt:"35"}); expect(f.seen.length).toBe(286); expect(f.seen.every(id=>BigInt(id)>35n)).toBe(true);
  });
  it("resumes an interrupted initial scan from its last completed page", async () => {
    const f = fixture(Array.from({length: 250},(_,i)=>String(i+1))); let before: string | undefined; let stopped=false;
    expect(await walkHistory({...f,checkpoint: id=>{ before=id; stopped=true; },stopped:()=>stopped})).toBe(false);
    const r=fixture(Array.from({length:250},(_,i)=>String(i+1)));
    await walkHistory({...r,before:before!}); expect(new Set([...f.seen,...r.seen]).size).toBe(250);
  });
  it("does not declare a failed page complete", async () => {
    const f=fixture(["1","2"]); await expect(walkHistory({...f,fetch:async()=>{throw Error("offline");}})).rejects.toThrow("offline"); expect(f.seen).toEqual([]);
  });
});
